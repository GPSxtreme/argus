import { copyFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { VerifiedReleaseManifest } from "@argus/release";
import { DeploymentError } from "./errors.js";
import type { DeploymentStateV1 } from "./contracts.js";
import type { CommandExecutor } from "./executor.js";
import { loadDeploymentState, saveDeploymentState } from "./files.js";

export type UpdatePhase =
  | "planned"
  | "backed_up"
  | "pulled"
  | "migrated"
  | "restarted"
  | "verified"
  | "rolled_back";

export interface UpdatePlan {
  contractVersion: 1;
  currentVersion: string;
  targetVersion: string;
  changes: Array<{ component: "argus" | "postgres" | "searxng"; action: "update"; summary: string }>;
  noop: boolean;
  previousState: DeploymentStateV1;
  release: VerifiedReleaseManifest;
  rollbackRelease: VerifiedReleaseManifest;
}

export interface UpdateHealthReport {
  healthy: boolean;
  services: Array<{ name: string; state: string; health?: string }>;
}

export interface UpdateResult {
  version: string;
  phase: UpdatePhase;
  health: UpdateHealthReport;
}

export interface InstanceBackup {
  path: string;
  state: DeploymentStateV1;
  sqliteFiles: Array<{ relativePath: string }>;
}

interface PersistedUpdate {
  phase: UpdatePhase;
  plan: Pick<UpdatePlan, "currentVersion" | "targetVersion">;
  previousState: DeploymentStateV1;
  release: VerifiedReleaseManifest;
  rollbackRelease: VerifiedReleaseManifest;
  backup?: InstanceBackup;
}

export interface PlanUpdateInput {
  root: string;
  release: VerifiedReleaseManifest;
  rollbackRelease: VerifiedReleaseManifest;
  executor: CommandExecutor;
}

export interface ApplyUpdateInput {
  root: string;
  plan: UpdatePlan;
  executor: CommandExecutor;
}

export interface BackupInstanceInput {
  root: string;
  plan: UpdatePlan;
}

export interface RollbackUpdateInput {
  root: string;
  executor: CommandExecutor;
  release: VerifiedReleaseManifest;
}

const updateStatePath = (root: string): string => join(root, "update-state.json");

const atomicWrite = async (path: string, source: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
};

const persist = async (root: string, state: PersistedUpdate): Promise<void> =>
  atomicWrite(updateStatePath(root), `${JSON.stringify(state, null, 2)}\n`);

const loadPersisted = async (root: string): Promise<PersistedUpdate> => {
  try {
    return JSON.parse(await readFile(updateStatePath(root), "utf8")) as PersistedUpdate;
  } catch {
    throw new DeploymentError(
      "UPDATE_ROLLBACK_UNAVAILABLE",
      "No persisted Argus update backup is available for rollback.",
      { recovery: "Run 'argus doctor --json' and inspect the update state before retrying." },
    );
  }
};

const assertVerifiedRelease = (release: VerifiedReleaseManifest): void => {
  if (!/^[a-f0-9]{64}$/u.test(release.manifestSha256)) {
    throw new DeploymentError(
      "UPDATE_RELEASE_UNVERIFIED",
      "Argus updates require a verified signed release manifest.",
      { recovery: "Obtain a verified release manifest before running an update." },
    );
  }
  if (release.manifest?.schemaVersion !== 1) {
    throw new DeploymentError(
      "UPDATE_RELEASE_UNVERIFIED",
      "Argus updates require a verified supported release manifest.",
    );
  }
};

const assertCompatible = (state: DeploymentStateV1, release: VerifiedReleaseManifest): void => {
  if (state.schemaVersion < Number(release.manifest.minimumStateSchema)) {
    throw new DeploymentError(
      "UPDATE_STATE_INCOMPATIBLE",
      "The persisted instance state is incompatible with this Argus release.",
      { recovery: "Use a release compatible with the persisted state schema before updating." },
    );
  }
};

const releaseMatchesCurrent = (
  state: DeploymentStateV1,
  release: VerifiedReleaseManifest,
): boolean => {
  const compose = state.compose;
  return (
    compose !== undefined &&
    release.manifest.version === state.argusVersion &&
    release.manifest.images.app.reference === compose.images.argus &&
    release.manifest.images.postgres.reference === compose.images.postgres &&
    release.manifest.images.searxng.reference === compose.images.searxng
  );
};

const assertRollbackMatchesCurrent = (
  state: DeploymentStateV1,
  rollbackRelease: VerifiedReleaseManifest,
): void => {
  if (!releaseMatchesCurrent(state, rollbackRelease)) {
    throw new DeploymentError(
      "UPDATE_ROLLBACK_RELEASE_MISMATCH",
      "The verified rollback release does not exactly match the current Argus deployment.",
      { recovery: "Restore the signed release context for the currently deployed Argus version before updating." },
    );
  }
};

const environmentFor = (state: DeploymentStateV1, release: VerifiedReleaseManifest): Record<string, string> => ({
  ARGUS_API_PORT: String(state.compose?.apiPort ?? 8788),
  ARGUS_IMAGE: release.manifest.images.app.reference,
  POSTGRES_IMAGE: release.manifest.images.postgres.reference,
  SEARXNG_IMAGE: release.manifest.images.searxng.reference,
});

const command = async (
  root: string,
  executor: CommandExecutor,
  args: string[],
  environment: Record<string, string>,
  failure: string,
) => {
  const result = await executor.run("docker", ["compose", "-p", "argus", ...args], {
    cwd: root,
    env: environment,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new DeploymentError("UPDATE_FAILED", failure, {
      recovery: "Run 'argus doctor --json' and use its returned recovery command exactly.",
    });
  }
  return result;
};

const health = async (
  root: string,
  executor: CommandExecutor,
  state: DeploymentStateV1,
  release: VerifiedReleaseManifest,
): Promise<UpdateHealthReport> => {
  const result = await command(root, executor, ["ps", "--format", "json"], environmentFor(state, release), "Argus health inspection failed.");
  let records: unknown;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    records = [];
  }
  const services = Array.isArray(records)
    ? records.flatMap((record) => {
        if (!record || typeof record !== "object") return [];
        const value = record as Record<string, unknown>;
        const name = typeof value.Service === "string" ? value.Service : value.service;
        const stateValue = typeof value.State === "string" ? value.State : value.state;
        const healthValue = typeof value.Health === "string" ? value.Health : value.health;
        return typeof name === "string" && typeof stateValue === "string"
          ? [{ name, state: stateValue, ...(typeof healthValue === "string" ? { health: healthValue } : {}) }]
          : [];
      })
    : [];
  const required = ["argus", ...(state.compose?.storage === "postgres" ? ["postgres"] : []), ...(state.compose?.searxng ? ["searxng"] : [])];
  const healthy = required.every((name) =>
    services.some((service) => service.name === name && service.state === "running" && service.health !== "unhealthy"),
  );
  return { healthy, services };
};

const sqliteFiles = async (root: string): Promise<string[]> => {
  const candidates = ["argus.db", "argus.db-wal", "argus.db-shm"];
  const directories = [root, join(root, "data")];
  const files: string[] = [];
  for (const directory of directories) {
    for (const name of candidates) {
      const path = join(directory, name);
      if (await stat(path).then(() => true).catch(() => false)) files.push(path);
    }
    if (files.length) return files;
  }
  return files;
};

export const planUpdate = async ({ root, release, rollbackRelease }: PlanUpdateInput): Promise<UpdatePlan> => {
  assertVerifiedRelease(release);
  assertVerifiedRelease(rollbackRelease);
  const state = await loadDeploymentState(root);
  if (!state?.compose) {
    throw new DeploymentError(
      "UPDATE_STATE_UNAVAILABLE",
      "Argus update requires persisted verified deployment state.",
      { recovery: "Run 'argus onboard' to establish managed deployment state first." },
    );
  }
  assertCompatible(state, release);
  assertCompatible(state, rollbackRelease);
  assertRollbackMatchesCurrent(state, rollbackRelease);
  const noop = releaseMatchesCurrent(state, release);
  const services: Array<"argus" | "postgres" | "searxng"> = ["argus"];
  if (state.compose.storage === "postgres") services.push("postgres");
  if (state.compose.searxng) services.push("searxng");
  const changes = noop
    ? []
    : services.map((component) => ({
        component,
        action: "update" as const,
        summary: `Update ${component} to signed Argus release ${release.manifest.version}.`,
      }));
  return {
    contractVersion: 1,
    currentVersion: state.argusVersion,
    targetVersion: release.manifest.version,
    changes,
    noop,
    previousState: state,
    release,
    rollbackRelease,
  };
};

export const backupInstance = async ({ root, plan }: BackupInstanceInput): Promise<InstanceBackup> => {
  const path = join(root, "backups", `${plan.currentVersion}-${Date.now()}`);
  await mkdir(path, { recursive: true });
  await atomicWrite(join(path, "state.json"), `${JSON.stringify(plan.previousState, null, 2)}\n`);
  const files = await sqliteFiles(root);
  const sqliteBackupFiles = files.map((source) => ({ relativePath: relative(root, source) }));
  for (const file of sqliteBackupFiles) {
    const destination = join(path, file.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, file.relativePath), destination);
  }
  const backup = { path, state: plan.previousState, sqliteFiles: sqliteBackupFiles };
  await persist(root, {
    phase: "backed_up",
    plan: { currentVersion: plan.currentVersion, targetVersion: plan.targetVersion },
    previousState: plan.previousState,
    release: plan.release,
    rollbackRelease: plan.rollbackRelease,
    backup,
  });
  return backup;
};

export const applyUpdate = async ({ root, plan, executor }: ApplyUpdateInput): Promise<UpdateResult> => {
  assertVerifiedRelease(plan.release);
  assertVerifiedRelease(plan.rollbackRelease);
  assertCompatible(plan.previousState, plan.release);
  assertCompatible(plan.previousState, plan.rollbackRelease);
  if (plan.noop) {
    const report = await health(root, executor, plan.previousState, plan.release);
    if (!report.healthy) {
      throw new DeploymentError("UPDATE_HEALTHCHECK_FAILED", "Argus update health verification failed.", {
        recovery: "Run 'argus doctor --json' before retrying the update.",
      });
    }
    return { version: plan.currentVersion, phase: "verified", health: report };
  }
  let persisted: PersistedUpdate = {
    phase: "planned",
    plan: { currentVersion: plan.currentVersion, targetVersion: plan.targetVersion },
    previousState: plan.previousState,
    release: plan.release,
    rollbackRelease: plan.rollbackRelease,
  };
  await persist(root, persisted);
  const backup = await backupInstance({ root, plan });
  persisted = { ...persisted, phase: "backed_up", backup };
  const environment = environmentFor(plan.previousState, plan.release);
  await command(root, executor, ["pull"], environment, "Argus image pull failed.");
  persisted = { ...persisted, phase: "pulled" };
  await persist(root, persisted);
  await command(root, executor, ["run", "--rm", "argus", "migrate"], environment, "Argus migration failed.");
  persisted = { ...persisted, phase: "migrated" };
  await persist(root, persisted);
  await command(root, executor, ["up", "-d"], environment, "Argus restart failed.");
  persisted = { ...persisted, phase: "restarted" };
  await persist(root, persisted);
  const report = await health(root, executor, plan.previousState, plan.release);
  if (!report.healthy) {
    throw new DeploymentError("UPDATE_HEALTHCHECK_FAILED", "Argus update health verification failed.", {
      recovery: "Run 'argus doctor --json', then use 'argus update --rollback' only after reviewing the backup.",
    });
  }
  const compose = plan.previousState.compose;
  if (!compose) throw new Error("Update state lost Compose configuration.");
  await saveDeploymentState(root, {
    ...plan.previousState,
    argusVersion: plan.targetVersion,
    services: Object.fromEntries(Object.entries(plan.previousState.services).map(([name, service]) => [name, { ...service, healthy: true }])),
    compose: {
      ...compose,
      version: plan.targetVersion,
      images: {
        argus: plan.release.manifest.images.app.reference,
        postgres: plan.release.manifest.images.postgres.reference,
        searxng: plan.release.manifest.images.searxng.reference,
      },
    },
    updatedAt: new Date().toISOString(),
  });
  persisted = { ...persisted, phase: "verified" };
  await persist(root, persisted);
  return { version: plan.targetVersion, phase: "verified", health: report };
};

export const rollbackUpdate = async ({ root, executor, release }: RollbackUpdateInput): Promise<UpdateResult> => {
  assertVerifiedRelease(release);
  const persisted = await loadPersisted(root);
  const backup = persisted.backup;
  if (
    !backup ||
    backup.state.schemaVersion < Number(release.manifest.minimumStateSchema) ||
    release.manifestSha256 !== persisted.rollbackRelease.manifestSha256 ||
    release.manifest.version !== persisted.rollbackRelease.manifest.version
  ) {
    throw new DeploymentError(
      "UPDATE_ROLLBACK_INCOMPATIBLE",
      "The available Argus backup is incompatible with the requested rollback.",
      { recovery: "Keep the backup and select a release compatible with its state schema." },
    );
  }
  for (const file of backup.sqliteFiles) {
    const destination = join(root, file.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(backup.path, file.relativePath), destination);
  }
  const environment = environmentFor(backup.state, persisted.rollbackRelease);
  await command(root, executor, ["up", "-d"], environment, "Argus rollback restart failed.");
  const report = await health(root, executor, backup.state, persisted.rollbackRelease);
  if (!report.healthy) {
    throw new DeploymentError("UPDATE_ROLLBACK_VERIFY_FAILED", "Argus rollback health verification failed.", {
      recovery: "Run 'argus doctor --json' and preserve the existing backup for recovery.",
    });
  }
  await saveDeploymentState(root, backup.state);
  await persist(root, { ...persisted, phase: "rolled_back" });
  return { version: backup.state.argusVersion, phase: "rolled_back", health: report };
};
