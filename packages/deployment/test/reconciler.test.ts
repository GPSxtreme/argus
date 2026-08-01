import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDeployment,
  getDeploymentStatus,
  inspectDeployment,
  planDeployment,
  restartDeployment,
  startDeployment,
  stopDeployment,
  type CommandExecutor,
  type CommandResult,
  type DeploymentContext,
  type DesiredDeployment,
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

  constructor({ running = true, ignoreLifecycleActions = false } = {}) {
    this.running = running;
    this.ignoreLifecycleActions = ignoreLifecycleActions;
  }

  async run(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ command, args, cwd: options?.cwd, env: options?.env });
    if (args.at(-1) === "json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { Service: "argus", State: this.running ? "running" : "exited", Health: "healthy" },
          { Service: "searxng", State: this.running ? "running" : "exited", Health: "healthy" },
        ]),
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
  configHash: "config-v1",
  images: {
    argus: { reference: "ghcr.io/gpsxtreme/argus", digest: `sha256:${"a".repeat(64)}` },
    searxng: { reference: "docker.io/searxng/searxng", digest: `sha256:${"b".repeat(64)}` },
    postgres: { reference: "docker.io/library/postgres", digest: `sha256:${"c".repeat(64)}` },
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

  it("validates Compose before applying a changed plan", async () => {
    const { context, executor } = await contextFor();
    const plan = planDeployment(await inspectDeployment(context), desired);
    executor.calls.splice(0);
    await applyDeployment(plan, context);

    expect(executor.calls.map(({ command, args }) => [command, args])).toEqual([
      ["docker", ["compose", "-p", "argus", "config"]],
      ["docker", ["compose", "-p", "argus", "up", "-d", "--remove-orphans"]],
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
      ARGUS_VERSION: `0.2.0@sha256:${"a".repeat(64)}`,
      SEARXNG_IMAGE: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
    });
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
            argus: { image: `${desired.images.argus.reference}@${desired.images.argus.digest}`, healthy: true },
            searxng: { image: `${desired.images.searxng.reference}@${desired.images.searxng.digest}`, healthy: true },
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
