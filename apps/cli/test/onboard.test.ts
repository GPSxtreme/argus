import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnboardingAnswers } from "@argus/deployment";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type CliDependencies,
  createNodeCliDependencies,
  createProgram,
  type DeploymentCliAdapter,
  type InstalledConfigApplication,
  type InstalledConfigPlan,
  type ProductionOnboardingIntegration,
  type ReleaseOnboardingApplication,
  type ReleaseOnboardingInspection,
  type VerifiedOnboardingRelease,
} from "../src/program.js";
import {
  collectOnboarding,
  type PromptAdapter,
} from "../src/prompts.js";

const temporaryDirectories: string[] = [];
const onboardingFixture = await readFile(
  new URL("./fixtures/onboarding.yaml", import.meta.url),
  "utf8",
);
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const promptHarness = (sources: string[], webQueries = "") => {
  const calls: Array<{ kind: string; message: string }> = [];
  const prompt: PromptAdapter = {
    async confirm(options) {
      calls.push({ kind: "confirm", message: options.message });
      return options.initialValue ?? true;
    },
    async select(options) {
      calls.push({ kind: "select", message: options.message });
      return options.initialValue ?? options.options[0]?.value ?? "";
    },
    async multiselect(options) {
      calls.push({ kind: "multiselect", message: options.message });
      if (options.message.includes("sources")) return sources;
      return [];
    },
    async text(options) {
      calls.push({ kind: "text", message: options.message });
      if (options.message.includes("Web search queries")) return webQueries;
      return options.initialValue ?? "";
    },
    async secret(options) {
      calls.push({ kind: "secret", message: options.message });
      return `${options.message}-value`;
    },
  };
  return { prompt, calls };
};

describe("onboarding wizard", () => {
  it("skips Cloudflare questions when X is disabled", async () => {
    const harness = promptHarness(["telegram"]);
    await collectOnboarding(harness.prompt);

    expect(
      harness.calls.some((call) => call.message.includes("Cloudflare")),
    ).toBe(false);
  });

  it("defaults to managed SearXNG when web queries are configured", async () => {
    const harness = promptHarness(["web"], "argus news");
    const result = await collectOnboarding(harness.prompt);

    expect(result.answers.managed.searxng).toBe("managed");
  });

  it("uses hidden secret prompts for every secret", async () => {
    const harness = promptHarness(["x"]);
    await collectOnboarding(harness.prompt);

    const secretMessages = harness.calls
      .filter((call) => call.kind === "secret")
      .map((call) => call.message);
    expect(secretMessages).toContain("Argus API token");
    expect(secretMessages).toContain("Cloudflare API token");
    expect(
      harness.calls.some(
        (call) =>
          call.kind === "text" &&
          (call.message.includes("token") || call.message.includes("password")),
      ),
    ).toBe(false);
  });

  it("recommends the standard seven-day X reply profile", async () => {
    const result = await collectOnboarding(promptHarness(["x"]).prompt);

    expect(result.answers.xReplies).toEqual({
      enabled: true,
      maxPerPost: 50,
      maxTrackingHours: 168,
      orderBy: "likes",
    });
  });

  it("handles prompt cancellation as a stable deployment error", async () => {
    const prompt = promptHarness([]).prompt;
    prompt.select = async () => {
      const { DeploymentError } = await import("@argus/deployment");
      throw new DeploymentError("PROMPT_CANCELLED", "Onboarding was cancelled.");
    };

    await expect(collectOnboarding(prompt)).rejects.toMatchObject({
      code: "PROMPT_CANCELLED",
    });
  });
});

const noPrompt: PromptAdapter = {
  async confirm() {
    return true;
  },
  async select() {
    throw new Error("unexpected select prompt");
  },
  async multiselect() {
    throw new Error("unexpected multiselect prompt");
  },
  async text() {
    throw new Error("unexpected text prompt");
  },
  async secret(options) {
    return `${options.message}-value`;
  },
};

const deploymentAdapter = (): DeploymentCliAdapter => ({
  async inspectLifecycle() {
    return {};
  },
  async applyLifecycle() {},
  async verifyLifecycle() {
    return {};
  },
  async status() {
    return {};
  },
  async logs() {
    return "";
  },
  async doctor() {
    return { contractVersion: 1, healthy: true, checks: [] };
  },
  async inspectRepair() {
    return {};
  },
  async applyRepair() {},
  async verifyRepair() {
    return {};
  },
  async inspectOnboarding() {
    return { changes: [] };
  },
  async applyOnboarding() {},
  async verifyOnboarding() {
    return { state: "running" };
  },
});

describe("onboarding file and config contracts", () => {
  it("accepts strict non-secret YAML and prompts only for required secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-cli-"));
    temporaryDirectories.push(directory);
    const setup = join(directory, "setup.yaml");
    await writeFile(
      setup,
      `version: 2
deployment:
  provider: vps-docker
  root: /opt/argus
  storage: sqlite
  apiHost: 0.0.0.0
  apiPort: 8788
managed:
  searxng: managed
  fxembed: disabled
xReplies:
  enabled: false
  maxPerPost: 50
  maxTrackingHours: 168
  orderBy: likes
watches:
  - id: web
    enabled: true
    schedule: "*/5 * * * *"
    x: { accounts: [], queries: [] }
    telegram: { channels: [] }
    web: { urls: [], feeds: [], queries: [argus] }
    keywords: []
intelligence:
  enabled: false
  model: openai/gpt-4.1-mini
`,
    );
    await chmod(setup, 0o644);
    let stdout = "";
    let appliedSecrets: Record<string, string> | undefined;
    const dependencies: CliDependencies = {
      deployment: {
        ...deploymentAdapter(),
        async inspectOnboarding(_answers, secrets) {
          return { summary: `plan ${secrets.ARGUS_API_TOKEN}` };
        },
        async applyOnboarding(_answers, secrets) {
          appliedSecrets = secrets;
        },
        async verifyOnboarding() {
          return { echo: appliedSecrets?.ARGUS_API_TOKEN };
        },
      },
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
      files: {
        readText: (path) => readFile(path, "utf8"),
        async stat(path) {
          return {
            mode: (await (await import("node:fs/promises")).stat(path)).mode,
          };
        },
        async writeSecret() {},
      },
      root: "/opt/argus",
      interactive: true,
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async inspectApply() {
          return { operations: [] };
        },
        async apply() {
          return {};
        },
        async verifyApply() {
          return { healthy: true };
        },
        async show() {
          return {};
        },
      },
    };
    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "onboard",
      "--from",
      setup,
      "--json",
      "--yes",
    ]);

    expect(appliedSecrets).toEqual({
      ARGUS_API_TOKEN: "Argus API token-value",
    });
    expect(stdout).not.toContain("Argus API token-value");
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("redacts newly entered secrets from future adapter errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-cli-ephemeral-"));
    temporaryDirectories.push(directory);
    const setup = join(directory, "setup.yaml");
    await writeFile(setup, onboardingFixture, { mode: 0o600 });
    let stdout = "";
    const dependencies: CliDependencies = {
      deployment: {
        ...deploymentAdapter(),
        async applyOnboarding(_answers, secrets) {
          const { DeploymentError } = await import("@argus/deployment");
          throw new DeploymentError(
            "FUTURE_ADAPTER_FAILED",
            `future adapter leaked ${secrets.ARGUS_API_TOKEN}`,
          );
        },
      },
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
      files: {
        readText: (path) => readFile(path, "utf8"),
        async stat(path) {
          return { mode: (await stat(path)).mode };
        },
        async writeSecret() {},
      },
      root: "/opt/argus",
      interactive: true,
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async inspectApply() {
          return { operations: [] };
        },
        async apply() {
          return {};
        },
        async verifyApply() {
          return { healthy: true };
        },
        async show() {
          return {};
        },
      },
    };

    await expect(
      createProgram(dependencies).parseAsync([
        "node",
        "argus",
        "onboard",
        "--from",
        setup,
        "--yes",
        "--json",
      ]),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(stdout).not.toContain("Argus API token-value");
    expect(JSON.parse(stdout).error.message).toContain("[REDACTED]");
  });

  it("dry-runs file onboarding without secret prompts or mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-cli-dry-run-"));
    temporaryDirectories.push(directory);
    const setup = join(directory, "setup.yaml");
    await writeFile(setup, onboardingFixture, { mode: 0o600 });
    let stdout = "";
    let applied = false;
    const dependencies: CliDependencies = {
      deployment: {
        ...deploymentAdapter(),
        async inspectOnboarding() {
          return { changes: [{ component: "argus", action: "create" }] };
        },
        async applyOnboarding() {
          applied = true;
        },
      },
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
      files: {
        readText: (path) => readFile(path, "utf8"),
        async stat(path) {
          return { mode: (await stat(path)).mode };
        },
        async writeSecret() {},
      },
      root: "/opt/argus",
      interactive: true,
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async inspectApply() {
          return { operations: [] };
        },
        async apply() {
          return {};
        },
        async verifyApply() {
          return { healthy: true };
        },
        async show() {
          return {};
        },
      },
    };

    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "onboard",
      "--from",
      setup,
      "--dry-run",
      "--json",
    ]);

    expect(applied).toBe(false);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      data: { plan: { changes: expect.any(Array) } },
    });
  });

  it("emits a JSON schema that validates the checked-in onboarding fixture", async () => {
    let stdout = "";
    const dependencies: CliDependencies = {
      deployment: deploymentAdapter(),
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
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
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async inspectApply() {
          return { operations: [] };
        },
        async apply() {
          return {};
        },
        async verifyApply() {
          return { healthy: true };
        },
        async show() {
          return {};
        },
      },
    };

    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "config",
      "schema",
      "--json",
    ]);

    const schema = JSON.parse(stdout).data as Record<string, unknown>;
    const fixture = parse(
      await readFile(
        new URL("./fixtures/onboarding.yaml", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const validate = new Ajv2020({
      strict: false,
      formats: { uri: true },
    }).compile(schema);
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      {
        ...structuredClone(fixture),
        managed: { searxng: "managed", fxembed: "managed" },
      },
      {
        ...structuredClone(fixture),
        managed: { searxng: "external", fxembed: "disabled" },
      },
      {
        ...structuredClone(fixture),
        managed: { searxng: "managed", fxembed: "external" },
      },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it("redacts exact secrets and secret-derived strings from config show JSON", async () => {
    let stdout = "";
    const secret = "super-secret";
    const dependencies: CliDependencies = {
      deployment: deploymentAdapter(),
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
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
      secretValues: async () => ({ TOKEN: secret }),
      config: {
        async validate() {
          return {};
        },
        async inspectApply() {
          return { operations: [] };
        },
        async apply() {
          return {};
        },
        async verifyApply() {
          return { healthy: true };
        },
        async show() {
          return {
            token: secret,
            endpoint: `https://user:${secret}@example.com`,
            header: `Bearer ${secret}`,
          };
        },
      },
    };

    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "config",
      "show",
      "--json",
    ]);

    expect(stdout).not.toContain(secret);
    expect(JSON.parse(stdout).data).toEqual({
      token: "[REDACTED]",
      endpoint: "https://user:[REDACTED]@example.com",
      header: "Bearer [REDACTED]",
    });
  });

  it.each([
    [
      "secret fields",
      `version: 2
apiToken: forbidden
`,
      "ONBOARDING_FILE_CONTAINS_SECRET",
      0o600,
    ],
    [
      "unknown fields",
      `${onboardingFixture}unknown: true\n`,
      "ONBOARDING_ANSWERS_INVALID",
      0o600,
    ],
    [
      "unsafe writable modes",
      onboardingFixture,
      "ONBOARDING_FILE_MODE_UNSAFE",
      0o622,
    ],
  ])("rejects %s in --from answers", async (_name, contents, code, mode) => {
    const directory = await mkdtemp(join(tmpdir(), "argus-cli-reject-"));
    temporaryDirectories.push(directory);
    const setup = join(directory, "setup.yaml");
    await writeFile(setup, contents, { mode });
    await chmod(setup, mode);
    let stdout = "";
    const dependencies: CliDependencies = {
      deployment: deploymentAdapter(),
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
      files: {
        readText: (path) => readFile(path, "utf8"),
        async stat(path) {
          return { mode: (await stat(path)).mode };
        },
        async writeSecret() {},
      },
      root: "/opt/argus",
      interactive: true,
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async inspectApply() {
          return { operations: [] };
        },
        async apply() {
          return {};
        },
        async verifyApply() {
          return { healthy: true };
        },
        async show() {
          return {};
        },
      },
    };

    await expect(
      createProgram(dependencies).parseAsync([
        "node",
        "argus",
        "onboard",
        "--from",
        setup,
        "--json",
        "--yes",
      ]),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(JSON.parse(stdout).error.code).toBe(code);
  });

  it("writes secrets atomically with owner-only mode and never prints the value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-cli-secret-"));
    temporaryDirectories.push(directory);
    let stdout = "";
    const secret = "value-that-must-not-print";
    const dependencies = createNodeCliDependencies({
      root: directory,
      executor: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      prompt: {
        ...noPrompt,
        async secret() {
          return secret;
        },
      },
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
    });
    dependencies.interactive = true;

    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "secrets",
      "set",
      "ARGUS_API_TOKEN",
      "--yes",
      "--json",
    ]);

    const path = join(directory, "secrets.env");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain(
      "ARGUS_API_TOKEN=value-that-must-not-print",
    );
    expect(stdout).not.toContain(secret);
  });

  it.each(["symlink", "wrong-mode"] as const)(
    "refuses to read an unsafe existing secrets file: %s",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "argus-cli-unsafe-"));
      temporaryDirectories.push(directory);
      const secretsPath = join(directory, "secrets.env");
      if (kind === "symlink") {
        const target = join(directory, "target.env");
        await writeFile(target, "ARGUS_API_TOKEN=sentinel\n", { mode: 0o600 });
        await symlink(target, secretsPath);
      } else {
        await writeFile(secretsPath, "ARGUS_API_TOKEN=sentinel\n", {
          mode: 0o644,
        });
        await chmod(secretsPath, 0o644);
      }
      const dependencies = createNodeCliDependencies({
        root: directory,
        executor: {
          async run() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        prompt: noPrompt,
        io: { stdout: () => undefined, stderr: () => undefined },
      });

      await expect(dependencies.secretValues()).rejects.toMatchObject({
        code: "SECRETS_FILE_UNSAFE",
      });
    },
  );

  it("fails closed before any partial mutation when signed release integration is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-cli-release-"));
    temporaryDirectories.push(directory);
    const installRoot = join(directory, "instance");
    const setup = join(directory, "setup.yaml");
    await writeFile(setup, onboardingFixture, { mode: 0o600 });
    const results: Record<string, string> = {
      "cat /host/etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\n',
      "docker info --format {{.Architecture}}": "x86_64\n",
      "docker --version": "Docker version 28\n",
      "docker compose version": "Docker Compose version v2\n",
      "docker info": "Server: Docker\n",
      "cat /host/proc/meminfo": "MemTotal:       2097152 kB\n",
      "df -B1 /opt/argus":
        "Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/vda 10000000000 1 9000000000 1% /\n",
      "ss -ltn": "State Recv-Q Send-Q Local Address:Port Peer Address:Port\n",
    };
    let stdout = "";
    const dependencies = createNodeCliDependencies({
      root: installRoot,
      executor: {
        async run(command, args) {
          const key = [command, ...args].join(" ");
          return {
            exitCode: key in results ? 0 : 1,
            stdout: results[key] ?? "",
            stderr: "",
          };
        },
      },
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
    });
    dependencies.interactive = true;

    await expect(
      createProgram(dependencies).parseAsync([
        "node",
        "argus",
        "onboard",
        "--from",
        setup,
        "--yes",
        "--json",
      ]),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(JSON.parse(stdout).error.code).toBe("RELEASE_MANIFEST_REQUIRED");
    expect(await readdir(directory)).toEqual(["setup.yaml"]);
  });

  it("applies installed config through the service integration using the exact inspected plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-config-service-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "must-not-open.db");
    await writeFile(
      join(directory, "argus.yaml"),
      `version: 2
storage: { adapter: sqlite, url: "${database}" }
sources: {}
watches: []
`,
      { mode: 0o644 },
    );
    const plan: InstalledConfigPlan = {
      contractVersion: 1,
      planId: "plan-1",
      path: join(directory, "argus.yaml"),
      desiredContentHash: "a".repeat(64),
      operations: [
        {
          resource: "applied-config",
          action: "create",
          summary: "Create the installed service configuration.",
        },
      ],
    };
    const application: InstalledConfigApplication = {
      planId: "plan-1",
      receipt: { revision: 1 },
    };
    let stdout = "";
    const dependencies = createNodeCliDependencies({
      root: directory,
      executor: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
      installedConfigIntegration: {
        async inspect() {
          return plan;
        },
        async apply(input) {
          expect(input.inspection).toBe(plan);
          return application;
        },
        async verify(input) {
          expect(input.inspection).toBe(plan);
          expect(input.application).toBe(application);
          return { healthy: true, planId: "plan-1", status: "applied" };
        },
      },
    });

    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "config",
      "apply",
      "--yes",
      "--json",
    ]);

    expect(JSON.parse(stdout).ok).toBe(true);
    await expect(access(database)).rejects.toThrow();
  });

  const verifiedRelease: VerifiedOnboardingRelease = {
    version: "1.2.3",
    manifestSha256: "a".repeat(64),
    images: {
      argus: `ghcr.io/argus/app@sha256:${"b".repeat(64)}`,
      postgres: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
      searxng: `docker.io/searxng/searxng@sha256:${"d".repeat(64)}`,
    },
    fxembed: {
      bundleSha256: "e".repeat(64),
      compatibilityDate: "2026-08-01",
    },
  };
  const releaseInspection: ReleaseOnboardingInspection = {
    plan: { changes: [{ component: "argus", action: "create" }] },
    release: verifiedRelease,
  };
  const releaseApplication: ReleaseOnboardingApplication = {
    receipt: { deployment: "created" },
    release: verifiedRelease,
    stateWritten: true,
  };

  const releaseDependencies = (
    integration: ProductionOnboardingIntegration,
  ) =>
    createNodeCliDependencies({
      root: "/opt/argus",
      executor: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      prompt: noPrompt,
      io: { stdout: () => undefined, stderr: () => undefined },
      onboardingIntegration: integration,
    });

  const parsedReleaseAnswers = async (): Promise<OnboardingAnswers> =>
    (await import("@argus/deployment")).onboardingAnswersSchema.parse(
      parse(onboardingFixture),
    ) as OnboardingAnswers;

  it("re-onboards when the persisted managed deployment owns the API port", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-cli-reonboard-"));
    temporaryDirectories.push(directory);
    const installRoot = join(directory, "instance");
    const setup = join(directory, "setup.yaml");
    await mkdir(installRoot);
    await writeFile(setup, onboardingFixture, { mode: 0o600 });
    await writeFile(
      join(installRoot, "state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        argusVersion: verifiedRelease.version,
        composeProject: "argus",
        configHash: "persisted-config",
        services: {},
        compose: {
          version: verifiedRelease.version,
          apiPort: 8788,
          storage: "sqlite",
          searxng: true,
          images: verifiedRelease.images,
        },
        updatedAt: "2026-08-10T00:00:00.000Z",
      })}\n`,
      { mode: 0o644 },
    );
    const results: Record<string, string> = {
      "cat /host/etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\n',
      "docker info --format {{.Architecture}}": "x86_64\n",
      "docker --version": "Docker version 29\n",
      "docker compose version": "Docker Compose version v2\n",
      "docker info": "Server: Docker\n",
      "cat /host/proc/meminfo": "MemTotal:       4194304 kB\n",
      "df -B1 /opt/argus":
        "Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/vda 10000000000 1 9000000000 1% /\n",
      "ss -ltn":
        "State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 4096 0.0.0.0:8788 0.0.0.0:*\n",
      "docker ps --quiet --filter label=com.docker.compose.project=argus --filter label=com.docker.compose.service=argus":
        "managed-container-id\n",
      "docker inspect --format {{json .NetworkSettings.Ports}} managed-container-id":
        '{"8788/tcp":[{"HostIp":"0.0.0.0","HostPort":"8788"}]}\n',
    };
    let inspected = false;
    let stdout = "";
    const dependencies = createNodeCliDependencies({
      root: installRoot,
      executor: {
        async run(command, args) {
          const key = [command, ...args].join(" ");
          return {
            exitCode: key in results ? 0 : 1,
            stdout: results[key] ?? "",
            stderr: "",
          };
        },
      },
      prompt: noPrompt,
      io: { stdout: (value) => (stdout += value), stderr: () => undefined },
      onboardingIntegration: {
        async inspect() {
          inspected = true;
          return releaseInspection;
        },
        async apply() {
          return releaseApplication;
        },
        async verify() {
          return { healthy: true, release: verifiedRelease, status: "running" };
        },
      },
    });
    dependencies.interactive = true;

    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "onboard",
      "--from",
      setup,
      "--yes",
      "--json",
    ]);

    expect(inspected).toBe(true);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("applies and verifies the exact inspected release object identity", async () => {
    const answers = await parsedReleaseAnswers();
    const integration: ProductionOnboardingIntegration = {
      async inspect() {
        return releaseInspection;
      },
      async apply(input) {
        expect(input.inspection).toBe(releaseInspection);
        return releaseApplication;
      },
      async verify(input) {
        expect(input.application).toBe(releaseApplication);
        return {
          healthy: true,
          release: verifiedRelease,
          status: "healthy",
        };
      },
    };
    const dependencies = releaseDependencies(integration);
    const application = await dependencies.deployment.applyOnboarding(
      answers,
      {},
      releaseInspection,
    );
    expect(application).toBe(releaseApplication);
    await expect(
      dependencies.deployment.verifyOnboarding(answers, application),
    ).resolves.toMatchObject({ healthy: true });
  });

  it.each([
    [
      "state write",
      { ...releaseApplication, stateWritten: false },
    ],
    [
      "version",
      {
        ...releaseApplication,
        release: { ...verifiedRelease, version: "9.9.9" },
      },
    ],
    [
      "manifest",
      {
        ...releaseApplication,
        release: { ...verifiedRelease, manifestSha256: "f".repeat(64) },
      },
    ],
    [
      "image",
      {
        ...releaseApplication,
        release: {
          ...verifiedRelease,
          images: {
            ...verifiedRelease.images,
            argus: `ghcr.io/argus/app@sha256:${"f".repeat(64)}`,
          },
        },
      },
    ],
    [
      "FxEmbed",
      {
        ...releaseApplication,
        release: {
          ...verifiedRelease,
          fxembed: {
            ...verifiedRelease.fxembed,
            bundleSha256: "f".repeat(64),
            compatibilityDate: "2026-08-01",
          },
        },
      },
    ],
  ])("rejects onboarding application %s mismatch", async (_name, application) => {
    const answers = await parsedReleaseAnswers();
    const dependencies = releaseDependencies({
      async inspect() {
        return releaseInspection;
      },
      async apply() {
        return application as ReleaseOnboardingApplication;
      },
      async verify() {
        return { healthy: true, release: verifiedRelease, status: "healthy" };
      },
    });

    await expect(
      dependencies.deployment.applyOnboarding(
        answers,
        {},
        releaseInspection,
      ),
    ).rejects.toMatchObject({ code: "ONBOARDING_APPLICATION_MISMATCH" });
  });

  it.each([
    [
      "unhealthy",
      { healthy: false, release: verifiedRelease, status: "unhealthy" },
    ],
    [
      "release mismatch",
      {
        healthy: true,
        release: { ...verifiedRelease, version: "9.9.9" },
        status: "healthy",
      },
    ],
  ])("rejects onboarding verification %s", async (_name, verification) => {
    const answers = await parsedReleaseAnswers();
    const dependencies = releaseDependencies({
      async inspect() {
        return releaseInspection;
      },
      async apply() {
        return releaseApplication;
      },
      async verify() {
        return verification;
      },
    });

    await expect(
      dependencies.deployment.verifyOnboarding(
        answers,
        releaseApplication,
      ),
    ).rejects.toMatchObject({ code: "ONBOARDING_VERIFY_FAILED" });
  });
});
