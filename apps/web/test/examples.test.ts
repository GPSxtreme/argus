import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateConfig } from "@argus/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type CliDependencies, createProgram } from "../../cli/src/program.js";

const configurationPath = path.join(
  process.cwd(),
  "apps/web/content/docs/configuration.mdx",
);

const cliDependencies: CliDependencies = {
  deployment: {
    async inspectLifecycle() { return {}; },
    async applyLifecycle() { return {}; },
    async verifyLifecycle() { return {}; },
    async status() { return {}; },
    async logs() { return ""; },
    async doctor() { return { contractVersion: 1, healthy: true, checks: [] }; },
    async inspectRepair() { return {}; },
    async applyRepair() { return {}; },
    async verifyRepair() { return {}; },
    async inspectOnboarding() { return {}; },
    async applyOnboarding() { return {}; },
    async verifyOnboarding() { return {}; },
  },
  prompt: {
    async confirm() { return true; },
    async select(options) { return options.initialValue ?? options.options[0]?.value ?? ""; },
    async multiselect() { return []; },
    async text() { return ""; },
    async secret() { return ""; },
  },
  io: { stdout() {}, stderr() {} },
  files: {
    async readText() { return ""; },
    async stat() { return { mode: 0o600 }; },
    async writeSecret() {},
  },
  root: "/opt/argus",
  interactive: false,
  secretValues: async () => ({}),
  config: {
    async validate() { return {}; },
    async inspectApply() { return {}; },
    async apply() { return {}; },
    async verifyApply() { return {}; },
    async show() { return {}; },
  },
};

describe("operator documentation examples", () => {
  it("validates every complete configuration example", async () => {
    const content = await readFile(configurationPath, "utf8");
    const configBlocks = [...content.matchAll(/```yaml config\n([\s\S]*?)```/gu)];

    expect(configBlocks.length).toBeGreaterThanOrEqual(3);
    for (const [, block] of configBlocks) {
      const resolved = (block as string)
        .replaceAll(`\${OPENROUTER_API_KEY}`, "test-openrouter-key")
        .replaceAll(`\${ARGUS_API_TOKEN}`, "test-api-token");
      expect(() => validateConfig(parse(resolved))).not.toThrow();
    }
  });

  it("keeps every documented root command available", () => {
    const documentedCommands = [
      "onboard", "start", "stop", "restart", "status", "logs", "doctor",
      "repair", "update", "config", "secrets",
    ] as const;
    const commands = createProgram(cliDependencies).commands.map((command) => command.name());

    expect(commands).toEqual(expect.arrayContaining([...documentedCommands]));
  });
});
