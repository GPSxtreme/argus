import { DeploymentError } from "@argus/deployment";
import { describe, expect, it } from "vitest";
import {
  type CliDependencies,
  createProgram,
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
    interactive: true,
    secretValues: async () => secretValues,
    config: {
      async validate() {
        return { valid: true };
      },
      async inspectApply() {
        return { contractVersion: 1, operations: [] };
      },
      async apply() {
        return { applied: true };
      },
      async verifyApply() {
        return { healthy: true };
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
      "update",
      "config",
      "secrets",
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

  it("honors JSON mode before the selected command", async () => {
    const harness = createHarness();
    await run(["--json", "status"], harness.dependencies);
    expect(JSON.parse(harness.output().stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      contractVersion: 1,
      ok: true,
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

  it("returns the applied release version and final health only after JSON --yes", async () => {
    let applied = false;
    const harness = createHarness();
    Object.assign(harness.dependencies.deployment as object, {
      async inspectUpdate() {
        return { targetVersion: "2.0.0", changes: [{ component: "argus", action: "update" }] };
      },
      async applyUpdate() {
        applied = true;
        return { version: "2.0.0", health: { healthy: true, checks: [] } };
      },
      async verifyUpdate() {
        return { healthy: true, checks: [] };
      },
    });

    await expect(
      createProgram(harness.dependencies).parseAsync(["node", "argus", "update", "--json"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(applied).toBe(false);

    await run(["update", "--json", "--yes"], harness.dependencies);
    expect(
      JSON.parse(harness.output().stdout.trim().split("\n").at(-1) ?? ""),
    ).toMatchObject({
      contractVersion: 1,
      ok: true,
      data: { version: "2.0.0", health: { healthy: true } },
    });
  });

  it("requires --yes before exposing a verified rollback through JSON", async () => {
    let applied = false;
    const harness = createHarness();
    Object.assign(harness.dependencies.deployment as object, {
      async inspectRollbackUpdate() {
        return { release: { manifestSha256: "a".repeat(64) } };
      },
      async applyRollbackUpdate() {
        applied = true;
        return { version: "1.0.0", health: { healthy: true } };
      },
    });

    await expect(
      createProgram(harness.dependencies).parseAsync(["node", "argus", "update", "--rollback", "--json"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(applied).toBe(false);

    await run(["update", "--rollback", "--json", "--yes"], harness.dependencies);
    expect(JSON.parse(harness.output().stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      ok: true,
      data: { version: "1.0.0", health: { healthy: true } },
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

    await run(["logs", "argus", "--tail", "10000", "--json"], harness.dependencies);

    expect(requestedLimit).toBe(10_000);
    expect(harness.output().stdout).not.toContain("secret-value");
    expect(JSON.parse(harness.output().stdout).data.logs).toBe(
      "before [REDACTED] after",
    );
  });

  it.each(["0", "-1", "1junk", "1.5", "10001", "99999999999999999999"])(
    "rejects invalid log tail %s",
    async (tail) => {
      const harness = createHarness();
      await expect(
        createProgram(harness.dependencies).parseAsync([
          "node",
          "argus",
          "logs",
          "--tail",
          tail,
          "--json",
        ]),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(JSON.parse(harness.output().stdout).error.code).toBe(
        "LOG_TAIL_INVALID",
      );
    },
  );

  it("dry-runs lifecycle plans without confirmation or mutation", async () => {
    let applied = false;
    const harness = createHarness({
      async applyLifecycle() {
        applied = true;
      },
    });
    harness.dependencies.prompt.confirm = async () => {
      throw new Error("confirmation must not run");
    };

    await run(["start", "--dry-run", "--json"], harness.dependencies);

    expect(applied).toBe(false);
    expect(JSON.parse(harness.output().stdout)).toMatchObject({
      ok: true,
      data: { plan: { action: "start", state: "stopped" } },
    });
  });

  it.each([
    ["config", ["config", "apply", "--dry-run", "--json"]],
    ["repair", ["repair", "argus", "--dry-run", "--json"]],
    ["secrets", ["secrets", "set", "ARGUS_API_TOKEN", "--dry-run", "--json"]],
  ])("dry-runs %s mutations without apply or prompts", async (_name, args) => {
    let mutated = false;
    const harness = createHarness({
      async applyRepair() {
        mutated = true;
      },
    });
    harness.dependencies.config.apply = async () => {
      mutated = true;
      return {};
    };
    harness.dependencies.files.writeSecret = async () => {
      mutated = true;
    };
    harness.dependencies.prompt.confirm = async () => {
      throw new Error("confirmation must not run");
    };
    harness.dependencies.prompt.secret = async () => {
      throw new Error("secret prompt must not run");
    };

    await run(args, harness.dependencies);

    expect(mutated).toBe(false);
    expect(JSON.parse(harness.output().stdout)).toMatchObject({
      ok: true,
      data: { plan: expect.any(Object) },
    });
  });

  it("prints the inspected human plan before interactive confirmation", async () => {
    const harness = createHarness();
    harness.dependencies.interactive = true;
    harness.dependencies.prompt.confirm = async () => {
      expect(harness.output().stdout).toContain("Plan:");
      expect(harness.output().stdout).toContain("- start");
      return true;
    };

    await run(["start"], harness.dependencies);

    expect(harness.output().stdout).toContain("completed and was verified");
  });

  it("renders useful human status and doctor recovery details", async () => {
    const statusHarness = createHarness();
    await run(["status"], statusHarness.dependencies);
    expect(statusHarness.output().stdout).toContain("Argus: running");
    expect(statusHarness.output().stdout).toContain("argus: healthy");

    const doctorHarness = createHarness({
      async doctor() {
        return {
          contractVersion: 1,
          healthy: false,
          checks: [
            {
              component: "argus",
              status: "unhealthy",
              code: "ARGUS_DOWN",
              message: "Argus is down.",
              recovery: "Run argus repair argus.",
            },
          ],
        };
      },
    });
    await run(["doctor"], doctorHarness.dependencies);
    expect(doctorHarness.output().stdout).toContain("Argus is down.");
    expect(doctorHarness.output().stdout).toContain(
      "Try: Run argus repair argus.",
    );
  });
});
