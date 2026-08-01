import type { DeploymentPlan, DeploymentStateV1 } from "./contracts.js";
import type { CommandExecutor } from "./executor.js";
import { loadDeploymentState, saveDeploymentState } from "./files.js";

const composeProject = "argus";

export interface ManifestImage {
  reference: string;
  digest: `sha256:${string}`;
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
  const result = await context.executor.run("docker", composeArgs(...args), {
    cwd: context.root,
    ...(environment === undefined ? {} : { env: environment }),
  });
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
  if (!image.reference || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) {
    throw new Error("A verified release-manifest image digest is required for deployment.");
  }
  return `${image.reference}@${image.digest}`;
};

const composeEnvironment = (desired: DesiredDeployment): Record<string, string> => ({
  ARGUS_API_PORT: String(desired.apiPort),
  ARGUS_VERSION: `${desired.version}@${desired.images.argus.digest}`,
  POSTGRES_IMAGE: imageReference(desired.images.postgres),
  SEARXNG_IMAGE: imageReference(desired.images.searxng),
});

const parseStatus = (stdout: string): DeploymentStatus["services"] => {
  if (!stdout.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
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
  const result = await runCompose(context, ["ps", "--format", "json"], "status inspection");
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
  const status = await getDeploymentStatus(context);
  const running = new Set(status.services.filter((service) => service.state === "running").map((service) => service.name.replace(/^argus-/, "")));
  if (!status.healthy || requiredServices(plan.desired).some((service) => !running.has(service))) {
    throw new Error("Argus deployment did not become healthy. Run 'argus status' for safe diagnostics.");
  }

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
    updatedAt: new Date().toISOString(),
  });
};

export const startDeployment = async (context: DeploymentContext): Promise<void> => {
  await runCompose(context, ["config"], "configuration validation");
  await runCompose(context, ["up", "-d"], "start");
};

export const stopDeployment = async (context: DeploymentContext): Promise<void> => {
  await runCompose(context, ["stop"], "stop");
};

export const restartDeployment = async (context: DeploymentContext): Promise<void> => {
  await runCompose(context, ["restart"], "restart");
};
