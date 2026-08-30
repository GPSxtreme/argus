import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDeployment,
  type CommandExecutor,
  type CommandResult,
  type DeploymentContext,
  type DesiredDeployment,
  getDeploymentStatus,
  inspectDeployment,
  isPinnedImageReference,
  loadDeploymentState,
  planDeployment,
  restartDeployment,
  startDeployment,
  stopDeployment,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

class FixtureExecutor implements CommandExecutor {
  readonly calls: Array<{
    command: string;
    args: string[];
    cwd: string | undefined;
    env: Record<string, string> | undefined;
  }> = [];

  private running: boolean;
  private readonly ignoreLifecycleActions: boolean;

  constructor({
    running = true,
    ignoreLifecycleActions = false,
    psShape = "array",
    health = "healthy",
  }: {
    running?: boolean;
    ignoreLifecycleActions?: boolean;
    psShape?: "array" | "object" | "ndjson";
    health?: string;
  } = {}) {
    this.running = running;
    this.ignoreLifecycleActions = ignoreLifecycleActions;
    this.psShape = psShape;
    this.health = health;
  }

  private readonly psShape: "array" | "object" | "ndjson";
  private readonly health: string;

  async run(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandResult> {
    this.calls.push({ command, args, cwd: options?.cwd, env: options?.env });
    if (args.at(-1) === "json") {
      const services = [
        { Service: "argus", State: this.running ? "running" : "exited", Health: this.health },
        { Service: "searxng", State: this.running ? "running" : "exited", Health: this.health },
      ];
      return {
        exitCode: 0,
        stdout:
          this.psShape === "ndjson"
            ? services.map((service) => JSON.stringify(service)).join("\n")
            : JSON.stringify(this.psShape === "object" ? services[0] : services),
        stderr: "",
      };
    }
    if (!this.ignoreLifecycleActions && args.includes("up")) this.running = true;
    if (!this.ignoreLifecycleActions && args.includes("stop")) this.running = false;
    if (!this.ignoreLifecycleActions && args.includes("restart")) this.running = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

const desired: DesiredDeployment = {
  version: "0.2.0",
  apiPort: 8788,
  storage: "sqlite",
  searxng: true,
  fxembed: false,
  configHash: "config-v1",
  images: {
    argus: { reference: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}` },
    searxng: { reference: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}` },
    postgres: { reference: `docker.io/library/postgres@sha256:${"c".repeat(64)}` },
    fxembed: { reference: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${"d".repeat(64)}` },
  },
};

const contextFor = async (
  executorOptions?: ConstructorParameters<typeof FixtureExecutor>[0],
): Promise<{ context: DeploymentContext; executor: FixtureExecutor }> => {
  const root = await mkdtemp(join(tmpdir(), "argus-reconciler-"));
  roots.push(root);
  const executor = new FixtureExecutor(executorOptions);
  return { context: { root, executor, desired }, executor };
};

describe("deployment reconciliation", () => {
  it.each([
    `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
    `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
    `localhost:5000/argus/service@sha256:${"c".repeat(64)}`,
    `registry:5000/org/image@sha256:${"d".repeat(64)}`,
  ])("accepts a restrictive digest-pinned OCI image reference: %s", (reference) => {
    expect(isPinnedImageReference(reference)).toBe(true);
  });

  it.each([
    "ghcr.io/gpsxtreme/argus:0.2.0",
    `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(63)}`,
    `https://ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
    `ghcr.io/user:token@gpsxtreme/argus@sha256:${"a".repeat(64)}`,
    `ghcr.io/gpsxtreme/argus@sha256:${"A".repeat(64)}`,
    `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}?token=value`,
    `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}#fragment`,
    `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}\n`,
    `argus@sha256:${"a".repeat(64)}`,
    `registry/org/image@sha256:${"a".repeat(64)}`,
    `registry:0/org/image@sha256:${"a".repeat(64)}`,
    `registry:65536/org/image@sha256:${"a".repeat(64)}`,
  ])("rejects unsafe or malformed image reference: %s", (reference) => {
    expect(isPinnedImageReference(reference)).toBe(false);
  });

  it("is idempotent after applying the desired deployment", async () => {
    const { context, executor } = await contextFor();
    const first = planDeployment(await inspectDeployment(context), desired);
    expect(first.changes.map((change) => change.component)).toEqual(["argus", "searxng"]);

    await applyDeployment(first, context);
    executor.calls.splice(0);

    const second = planDeployment(await inspectDeployment(context), desired);
    expect(second.changes).toEqual([]);
    executor.calls.splice(0);
    await applyDeployment(second, context);
    expect(executor.calls).toEqual([]);
  });

  it("parses single-object Compose ps output for a one-service project", async () => {
    const { context } = await contextFor({ psShape: "object" });
    const status = await getDeploymentStatus(context);
    expect(status.services).toEqual([
      { name: "argus", state: "running", health: "healthy" },
    ]);
    expect(status.healthy).toBe(true);
  });

  it("parses newline-delimited Compose ps output for a multi-service project", async () => {
    const { context } = await contextFor({ psShape: "ndjson" });
    const status = await getDeploymentStatus(context);
    expect(status.services).toEqual([
      { name: "argus", state: "running", health: "healthy" },
      { name: "searxng", state: "running", health: "healthy" },
    ]);
    expect(status.healthy).toBe(true);
  });

  it("treats a starting single-object service as not unhealthy", async () => {
    const executor = new FixtureExecutor({
      psShape: "object",
      health: "starting",
    });
    const root = await mkdtemp(join(tmpdir(), "argus-reconciler-starting-"));
    roots.push(root);
    const status = await getDeploymentStatus({ root, executor, desired });
    expect(status.services).toEqual([
      { name: "argus", state: "running", health: "starting" },
    ]);
    expect(status.healthy).toBe(true);
  });

  it("reports an exited single-object service as not healthy", async () => {
    const { context } = await contextFor({ psShape: "object", running: false });
    const status = await getDeploymentStatus(context);
    expect(status.healthy).toBe(false);
  });

  it("validates Compose before applying a changed plan", async () => {
    const { context, executor } = await contextFor();
    const plan = planDeployment(await inspectDeployment(context), desired);
    executor.calls.splice(0);
    await applyDeployment(plan, context);

    expect(executor.calls.map(({ command, args }) => [command, args])).toEqual([
      ["docker", ["compose", "-p", "argus", "config"]],
      [
        "docker",
        [
          "compose",
          "-p",
          "argus",
          "up",
          "-d",
          "--remove-orphans",
          "--wait",
          "--wait-timeout",
          "60",
        ],
      ],
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
    ]);
  });

  it("supplies the API port and manifest-pinned images to Compose", async () => {
    const { context, executor } = await contextFor();
    const plan = planDeployment(await inspectDeployment(context), desired);
    executor.calls.splice(0);

    await applyDeployment(plan, context);

    expect(executor.calls[0]?.env).toMatchObject({
      ARGUS_API_PORT: "8788",
      ARGUS_IMAGE: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
      SEARXNG_IMAGE: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
    });
  });

  it("loads persisted non-secret Compose inputs in a fresh lifecycle context", async () => {
    const { context } = await contextFor();
    await applyDeployment(planDeployment(await inspectDeployment(context), desired), context);
    const freshExecutor = new FixtureExecutor();
    const freshContext: DeploymentContext = { root: context.root, executor: freshExecutor };

    await getDeploymentStatus(freshContext);
    await startDeployment(freshContext);
    await stopDeployment(freshContext);
    await restartDeployment(freshContext);

    expect(freshExecutor.calls.every((call) => call.env?.ARGUS_API_PORT === "8788")).toBe(true);
    expect(freshExecutor.calls[0]?.env).toMatchObject({
      ARGUS_IMAGE: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
      SEARXNG_IMAGE: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
    });
    expect((await loadDeploymentState(context.root))?.compose).toEqual({
      apiPort: 8788,
      version: "0.2.0",
      storage: "sqlite",
      searxng: true,
      fxembed: false,
      images: {
        argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
        postgres: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
        searxng: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
        fxembed: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${"d".repeat(64)}`,
      },
    });
    expect(await readFile(join(context.root, "state.json"), "utf8")).not.toContain("secret");
  });

  it("passes an alternate-registry app image to Compose without reconstruction", async () => {
    const { context, executor } = await contextFor();
    context.desired = {
      ...desired,
      images: {
        ...desired.images,
        argus: { reference: `registry.example:5443/team/argus@sha256:${"d".repeat(64)}` },
      },
    };
    const plan = planDeployment(await inspectDeployment(context), context.desired);
    executor.calls.splice(0);
    await applyDeployment(plan, context);
    expect(executor.calls[0]?.env?.ARGUS_IMAGE).toBe(
      `registry.example:5443/team/argus@sha256:${"d".repeat(64)}`,
    );
  });

  it("bounds Compose calls even when an executor ignores its timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-reconciler-timeout-"));
    roots.push(root);
    const executor: CommandExecutor = {
      run: async () => await new Promise<CommandResult>(() => undefined),
    };
    await expect(
      getDeploymentStatus({ root, executor, desired, composeTimeoutMs: 10 }),
    ).rejects.toThrow("timed out");
  });

  it.each([
    ["missing", {}, "searxng"],
    ["stopped", { searxng: { running: false, healthy: true } }, "searxng"],
    ["unhealthy", { searxng: { running: true, healthy: false } }, "searxng"],
    ["stopped", { argus: { running: false, healthy: true } }, "argus"],
  ])("reconciles a %s selected service", (condition, overrides, expectedService) => {
    const currentServices: Record<string, { running: boolean; healthy: boolean }> = {
      argus: { running: true, healthy: true },
      searxng: { running: true, healthy: true },
      ...overrides,
    };
    if (condition === "missing") Reflect.deleteProperty(currentServices, "searxng");
    const plan = planDeployment(
      {
        state: {
          schemaVersion: 1,
          argusVersion: desired.version,
          composeProject: "argus",
          configHash: desired.configHash,
          services: {
            argus: { image: desired.images.argus.reference, healthy: true },
            searxng: { image: desired.images.searxng.reference, healthy: true },
          },
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        services: currentServices,
      },
      desired,
    );

    expect(plan.changes).toEqual([
      expect.objectContaining({ component: expectedService, action: "restart" }),
    ]);
  });

  it("fails start when the expected services do not become running", async () => {
    const { context } = await contextFor({ running: false, ignoreLifecycleActions: true });

    await expect(startDeployment(context)).rejects.toThrow("did not become healthy");
  });

  it("fails stop when selected services remain running", async () => {
    const { context } = await contextFor({ running: true, ignoreLifecycleActions: true });

    await expect(stopDeployment(context)).rejects.toThrow("did not stop");
  });

  it("fails restart when selected services do not become healthy", async () => {
    const { context } = await contextFor({ running: false, ignoreLifecycleActions: true });

    await expect(restartDeployment(context)).rejects.toThrow("did not become healthy");
  });

  it("uses Docker Compose lifecycle commands with the fixed project name", async () => {
    const { context, executor } = await contextFor();

    await startDeployment(context);
    await stopDeployment(context);
    await restartDeployment(context);
    await getDeploymentStatus(context);

    expect(executor.calls.map(({ command, args }) => [command, args])).toEqual([
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
      ["docker", ["compose", "-p", "argus", "config"]],
      ["docker", ["compose", "-p", "argus", "up", "-d"]],
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
      ["docker", ["compose", "-p", "argus", "stop"]],
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
      ["docker", ["compose", "-p", "argus", "restart"]],
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
      ["docker", ["compose", "-p", "argus", "ps", "--format", "json"]],
    ]);
    expect(executor.calls.every((call) => call.env?.ARGUS_API_PORT === "8788")).toBe(true);
  });
});
