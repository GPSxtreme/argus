import {
  type DeploymentPlan,
  type DeploymentStateV1,
  isPinnedImageReference,
} from "./contracts.js";
import type { CommandExecutor } from "./executor.js";
import { loadDeploymentState, saveDeploymentState } from "./files.js";

const composeProject = "argus";

export interface ManifestImage {
  reference: string;
}

export interface DesiredDeployment {
  version: string;
  apiPort: number;
  storage: "sqlite" | "postgres";
  searxng: boolean;
  configHash: string;
  images: { argus: ManifestImage; postgres: ManifestImage; searxng: ManifestImage };
}

export interface DeploymentContext {
  root: string;
  executor: CommandExecutor;
  desired?: DesiredDeployment;
  composeTimeoutMs?: number;
}

export interface ActualDeployment {
  state: DeploymentStateV1 | undefined;
  services: Record<string, { running: boolean; healthy: boolean }>;
}

export interface LifecyclePlan extends DeploymentPlan {
  desired: DesiredDeployment;
}

export interface DeploymentStatus {
  services: Array<{ name: string; state: string; health: string | undefined }>;
  healthy: boolean;
}

const composeArgs = (...args: string[]): string[] => ["compose", "-p", composeProject, ...args];

const commandFailure = (operation: string): Error =>
  new Error(`Docker Compose ${operation} failed. Run 'argus status' for safe diagnostics.`);

const runCompose = async (
  context: DeploymentContext,
  args: string[],
  operation: string,
  environment?: Record<string, string>,
) => {
  const timeoutMs = Math.min(Math.max(context.composeTimeoutMs ?? 30_000, 1), 300_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execution = context.executor.run("docker", composeArgs(...args), {
    cwd: context.root,
    timeoutMs,
    ...(environment === undefined ? {} : { env: environment }),
  });
  const result = await Promise.race([
    execution,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(commandFailure(`${operation} timed out`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (result.timedOut) throw commandFailure(`${operation} timed out`);
  if (result.exitCode !== 0) throw commandFailure(operation);
  return result;
};

const requiredServices = (desired: DesiredDeployment): Array<keyof DesiredDeployment["images"]> => {
  const services: Array<keyof DesiredDeployment["images"]> = ["argus"];
  if (desired.storage === "postgres") services.push("postgres");
  if (desired.searxng) services.push("searxng");
  return services;
};

const imageReference = (image: ManifestImage): string => {
  if (!isPinnedImageReference(image.reference)) {
    throw new Error("A verified release-manifest image digest is required for deployment.");
  }
  return image.reference;
};

const composeEnvironment = (desired: DesiredDeployment): Record<string, string> => ({
  ARGUS_API_PORT: String(desired.apiPort),
  ARGUS_IMAGE: imageReference(desired.images.argus),
  POSTGRES_IMAGE: imageReference(desired.images.postgres),
  SEARXNG_IMAGE: imageReference(desired.images.searxng),
});

const splitImageReference = (image: string): ManifestImage => {
  if (!isPinnedImageReference(image)) {
    throw new Error("Persisted Compose inputs are missing a verified release-manifest image digest.");
  }
  return { reference: image };
};

const desiredFromState = (state: DeploymentStateV1 | undefined): DesiredDeployment | undefined => {
  const compose = state?.compose;
  if (compose === undefined || state === undefined) return undefined;
  return {
    version: compose.version,
    apiPort: compose.apiPort,
    storage: compose.storage,
    searxng: compose.searxng,
    configHash: state.configHash,
    images: {
      argus: splitImageReference(compose.images.argus),
      postgres: splitImageReference(compose.images.postgres),
      searxng: splitImageReference(compose.images.searxng),
    },
  };
};

const loadDesired = async (context: DeploymentContext): Promise<DesiredDeployment> => {
  if (context.desired !== undefined) return context.desired;
  const desired = desiredFromState(await loadDeploymentState(context.root));
  if (desired === undefined) {
    throw new Error("Verified Compose inputs are unavailable. Run 'argus onboard' or 'argus repair' first.");
  }
  return desired;
};

/** Loads only validated, persisted Compose interpolation values for a targeted repair. */
export const loadPersistedComposeEnvironment = async (
  context: DeploymentContext,
): Promise<Record<string, string>> => composeEnvironment(await loadDesired(context));

const parseStatus = (stdout: string): DeploymentStatus["services"] => {
  if (!stdout.trim()) return [];
  try {
    let entries: unknown[];
    try {
      const parsed: unknown = JSON.parse(stdout);
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      entries = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);
    }
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      const name =
        typeof value.Service === "string"
          ? value.Service
          : typeof value.service === "string"
            ? value.service
            : typeof value.Name === "string"
              ? value.Name
              : value.name;
      const state = typeof value.State === "string" ? value.State : value.state;
      const health = typeof value.Health === "string" ? value.Health : value.health;
      return typeof name === "string" && typeof state === "string"
        ? [{ name, state, health: typeof health === "string" ? health : undefined }]
        : [];
    });
  } catch {
    return [];
  }
};

export const getDeploymentStatus = async (context: DeploymentContext): Promise<DeploymentStatus> => {
  const environment = composeEnvironment(await loadDesired(context));
  const result = await runCompose(context, ["ps", "--format", "json"], "status inspection", environment);
  const services = parseStatus(result.stdout);
  return {
    services,
    healthy:
      services.length > 0 &&
      services.every((service) => service.state === "running" && service.health !== "unhealthy"),
  };
};

export const inspectDeployment = async (context: DeploymentContext): Promise<ActualDeployment> => {
  const [state, status] = await Promise.all([loadDeploymentState(context.root), getDeploymentStatus(context)]);
  return {
    state,
    services: Object.fromEntries(
      status.services.map((service) => [
        service.name.replace(/^argus-/, ""),
        { running: service.state === "running", healthy: service.health !== "unhealthy" },
      ]),
    ),
  };
};

const change = (
  component: DeploymentPlan["changes"][number]["component"],
  action: DeploymentPlan["changes"][number]["action"],
  summary: string,
) => ({ component, action, summary, external: false });

export const planDeployment = (actual: ActualDeployment, desired: DesiredDeployment): LifecyclePlan => {
  const changes: DeploymentPlan["changes"] = [];
  const expected = new Set(requiredServices(desired));
  const state = actual.state;

  for (const service of expected) {
    const expectedImage = imageReference(desired.images[service]);
    const observed = state?.services[service];
    if (observed === undefined) {
      changes.push(change(service, "create", `Create ${service} service.`));
    } else if (observed.image !== expectedImage) {
      changes.push(change(service, "update", `Update ${service} to its pinned release image.`));
    } else {
      const runtime = actual.services[service];
      if (runtime === undefined || !runtime.running || !runtime.healthy) {
        changes.push(change(service, "restart", `Restore ${service} to a healthy running state.`));
      }
    }
  }
  for (const service of Object.keys(state?.services ?? {})) {
    if (service !== "argus" && service !== "postgres" && service !== "searxng") continue;
    if (!expected.has(service)) changes.push(change(service, "remove", `Remove unselected ${service} service.`));
  }
  if (state && state.configHash !== desired.configHash && !changes.some((entry) => entry.component === "argus")) {
    changes.push(change("argus", "restart", "Restart Argus for its updated configuration."));
  }
  return { contractVersion: 1, changes, desired };
};

export const applyDeployment = async (plan: LifecyclePlan, context: DeploymentContext): Promise<void> => {
  if (plan.changes.length === 0) return;
  const environment = composeEnvironment(plan.desired);
  await runCompose(context, ["config"], "configuration validation", environment);
  await runCompose(context, ["up", "-d", "--remove-orphans"], "apply", environment);
  await verifyRunning(context, plan.desired);

  const services = Object.fromEntries(
    requiredServices(plan.desired).map((service) => [
      service,
      { image: imageReference(plan.desired.images[service]), healthy: true },
    ]),
  );
  await saveDeploymentState(context.root, {
    schemaVersion: 1,
    argusVersion: plan.desired.version,
    composeProject,
    configHash: plan.desired.configHash,
    services,
    compose: {
      version: plan.desired.version,
      apiPort: plan.desired.apiPort,
      storage: plan.desired.storage,
      searxng: plan.desired.searxng,
      images: {
        argus: imageReference(plan.desired.images.argus),
        postgres: imageReference(plan.desired.images.postgres),
        searxng: imageReference(plan.desired.images.searxng),
      },
    },
    updatedAt: new Date().toISOString(),
  });
};

const verifyRunning = async (context: DeploymentContext, desired: DesiredDeployment): Promise<void> => {
  const status = await getDeploymentStatus({ ...context, desired });
  const running = new Set(
    status.services
      .filter((service) => service.state === "running" && service.health !== "unhealthy")
      .map((service) => service.name.replace(/^argus-/, "")),
  );
  if (!status.healthy || requiredServices(desired).some((service) => !running.has(service))) {
    throw new Error("Argus deployment did not become healthy. Run 'argus status' for safe diagnostics.");
  }
};

const verifyStopped = async (context: DeploymentContext, desired: DesiredDeployment): Promise<void> => {
  const status = await getDeploymentStatus({ ...context, desired });
  const running = new Set(
    status.services.filter((service) => service.state === "running").map((service) => service.name.replace(/^argus-/, "")),
  );
  if (requiredServices(desired).some((service) => running.has(service))) {
    throw new Error("Argus deployment did not stop. Run 'argus status' for safe diagnostics.");
  }
};

export const startDeployment = async (context: DeploymentContext): Promise<void> => {
  const desired = await loadDesired(context);
  const environment = composeEnvironment(desired);
  await getDeploymentStatus(context);
  await runCompose(context, ["config"], "configuration validation", environment);
  await runCompose(context, ["up", "-d"], "start", environment);
  await verifyRunning(context, desired);
};

export const stopDeployment = async (context: DeploymentContext): Promise<void> => {
  const desired = await loadDesired(context);
  const environment = composeEnvironment(desired);
  await getDeploymentStatus(context);
  await runCompose(context, ["stop"], "stop", environment);
  await verifyStopped(context, desired);
};

export const restartDeployment = async (context: DeploymentContext): Promise<void> => {
  const desired = await loadDesired(context);
  const environment = composeEnvironment(desired);
  await getDeploymentStatus(context);
  await runCompose(context, ["restart"], "restart", environment);
  await verifyRunning(context, desired);
};
