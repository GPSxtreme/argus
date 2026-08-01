import {
  chmod,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectOnboarding,
  type PromptAdapter,
} from "../src/prompts.js";
import {
  createNodeCliDependencies,
  createProgram,
  type CliDependencies,
  type DeploymentCliAdapter,
} from "../src/program.js";

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
      `version: 1
deployment:
  provider: vps-docker
  root: /opt/argus
  storage: sqlite
  apiHost: 0.0.0.0
  apiPort: 8788
managed:
  searxng: managed
  fxembed: disabled
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
        async applyOnboarding(_answers, secrets) {
          appliedSecrets = secrets;
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
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async apply() {
          return {};
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
    expect(JSON.parse(stdout).ok).toBe(true);
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
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async apply() {
          return {};
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
      secretValues: async () => ({ TOKEN: secret }),
      config: {
        async validate() {
          return {};
        },
        async apply() {
          return {};
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
      `version: 1
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
      secretValues: async () => ({}),
      config: {
        async validate() {
          return {};
        },
        async apply() {
          return {};
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
});
