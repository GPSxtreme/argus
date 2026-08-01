import { describe, expect, it } from "vitest";
import { DeploymentError } from "@argus/deployment";
import {
  createProgram,
  type CliDependencies,
  type DeploymentCliAdapter,
} from "../src/program.js";

const createHarness = (
  overrides: Partial<DeploymentCliAdapter> = {},
  secretValues: Record<string, string> = {},
) => {
  let stdout = "";
  let stderr = "";
  const deployment: DeploymentCliAdapter = {
    async inspectLifecycle(action) {
      return { action, state: "stopped" };
    },
    async applyLifecycle() {},
    async verifyLifecycle() {
      return { state: "running", services: { argus: "healthy" } };
    },
    async status() {
      return { state: "running", services: { argus: "healthy" } };
    },
    async logs() {
      return "bounded logs";
    },
    async doctor() {
      return { contractVersion: 1, healthy: true, checks: [] };
    },
    async inspectRepair(service) {
      return { service, changes: [{ component: service, action: "restart" }] };
    },
    async applyRepair() {},
    async verifyRepair() {
      return { contractVersion: 1, healthy: true, checks: [] };
    },
    async inspectOnboarding() {
      return { changes: [] };
    },
    async applyOnboarding() {},
    async verifyOnboarding() {
      return { state: "running" };
    },
    ...overrides,
  };
  const dependencies: CliDependencies = {
    deployment,
    prompt: {
      async confirm() {
        return true;
      },
      async select(options) {
        return options.initialValue ?? options.options[0]?.value ?? "";
      },
      async multiselect() {
        return [];
      },
      async text() {
        return "";
      },
      async secret() {
        return "";
      },
    },
    io: {
      stdout(value) {
        stdout += value;
      },
      stderr(value) {
        stderr += value;
      },
    },
    files: {
      async readText() {
        return "";
      },
      async stat() {
        return { mode: 0o600 };
      },
      async writeSecret() {},
    },
    root: "/opt/argus",
    secretValues: async () => secretValues,
    config: {
      async validate() {
        return { valid: true };
      },
      async apply() {
        return { applied: true };
      },
      async show() {
        return {};
      },
    },
  };
  return {
    dependencies,
    output: () => ({ stdout, stderr }),
  };
};

const run = async (args: string[], dependencies: CliDependencies) => {
  const program = createProgram(dependencies);
  await program.parseAsync(["node", "argus", ...args]);
};

describe("CLI JSON contract", () => {
  it("registers the complete lifecycle and management command surface", () => {
    const harness = createHarness();
    const names = createProgram(harness.dependencies).commands.map(
      (command) => command.name(),
    );
    expect(names).toEqual([
      "onboard",
      "start",
      "stop",
      "restart",
      "status",
      "logs",
      "doctor",
      "repair",
      "config",
      "secrets",
      "run",
    ]);
  });

  it("emits a stable success envelope and no stderr output", async () => {
    const harness = createHarness();
    await run(["status", "--json"], harness.dependencies);

    expect(JSON.parse(harness.output().stdout)).toEqual({
      contractVersion: 1,
      ok: true,
      data: { state: "running", services: { argus: "healthy" } },
    });
    expect(harness.output().stderr).toBe("");
  });

  it("emits redacted stable errors with deterministic exit codes", async () => {
    const harness = createHarness({
      async status() {
        throw new DeploymentError(
          "STATUS_FAILED",
          "token secret-value failed",
          { recovery: "retry without secret-value" },
        );
      },
    }, { ARGUS_API_TOKEN: "secret-value" });
    const program = createProgram(harness.dependencies);

    await expect(
      program.parseAsync(["node", "argus", "status", "--json"]),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(JSON.parse(harness.output().stdout)).toEqual({
      contractVersion: 1,
      ok: false,
      error: {
        code: "STATUS_FAILED",
        message: "token [REDACTED] failed",
        recovery: "retry without [REDACTED]",
      },
    });
    expect(harness.output().stderr).toBe("");
  });

  it("requires explicit confirmation for non-interactive mutations", async () => {
    const harness = createHarness();
    const program = createProgram(harness.dependencies);

    await expect(
      program.parseAsync(["node", "argus", "start", "--json"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(JSON.parse(harness.output().stdout)).toMatchObject({
      contractVersion: 1,
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    });
  });

  it("bounds logs at the executor boundary and never emits a configured secret", async () => {
    let requestedLimit = 0;
    const harness = createHarness(
      {
        async logs(_service, options) {
          requestedLimit = options.tail;
          return "before secret-value after";
        },
      },
      { ARGUS_API_TOKEN: "secret-value" },
    );

    await run(["logs", "argus", "--tail", "999999", "--json"], harness.dependencies);

    expect(requestedLimit).toBe(10_000);
    expect(harness.output().stdout).not.toContain("secret-value");
    expect(JSON.parse(harness.output().stdout).data.logs).toBe(
      "before [REDACTED] after",
    );
  });
});
