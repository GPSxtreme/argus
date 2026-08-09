import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateConfig } from "@argus/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import * as argusApp from "../../argus/src/app.js";
import { type CliDependencies, createProgram } from "../../cli/src/program.js";
import { source } from "../lib/source";

const configurationPath = path.join(
  process.cwd(),
  "apps/web/content/docs/configuration.mdx",
);

type DocumentedCliCommand = {
  path: string;
  options: Set<string>;
};

const commanderCommandPaths = (program = createProgram(cliDependencies)): Map<string, Set<string>> => {
  const paths = new Map<string, Set<string>>();
  const optionsFor = (command: typeof program): Set<string> => {
    const helpOption = Reflect.get(command, "_getHelpOption") as
      | (() => { long: string } | null)
      | undefined;
    const help = helpOption?.call(command);
    return new Set([
      ...command.options.flatMap((option) =>
        option.long === undefined ? [] : [option.long],
      ),
      ...(help === null || help === undefined ? [] : [help.long]),
    ]);
  };
  const visit = (command: typeof program, prefix: string): void => {
    for (const child of command.commands) {
      const path = `${prefix} ${child.name()}`;
      paths.set(path, optionsFor(child));
      visit(child, path);
    }
  };
  paths.set("argus", optionsFor(program));
  visit(program, "argus");
  return paths;
};

const documentedCliCommands = async (
  commandPaths: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<DocumentedCliCommand[]> => {
  const knownPaths = [...commandPaths.keys()].sort(
    (left, right) => right.length - left.length,
  );
  const documented = new Map<string, Set<string>>();

  for (const page of source.getPages()) {
    const text = await page.data.getText("processed");
    for (const match of text.matchAll(/(?:^\s*|`)((?:pnpm\s+)?argus(?=[ \t])[^\n`]*)/gmu)) {
      const invocation = (match[1] as string).replace(/^pnpm\s+/u, "").trim();
      const commandPath = knownPaths.find(
        (candidate) =>
          invocation === candidate || invocation.startsWith(`${candidate} `),
      );
      expect(commandPath, `documented CLI invocation: ${invocation}`).toBeDefined();
      if (commandPath === undefined) continue;

      const options = documented.get(commandPath) ?? new Set<string>();
      for (const option of invocation.matchAll(/--[a-z][a-z0-9-]*/giu)) {
        options.add(option[0]);
      }
      documented.set(commandPath, options);
    }
  }

  return [...documented].map(([path, options]) => ({ path, options }));
};

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

  it("validates the primary VPS configuration with managed Compose API access", async () => {
    const content = await readFile(configurationPath, "utf8");
    const match = content.match(
      /### Single VPS with SQLite\n\n[\s\S]*?```yaml config\n([\s\S]*?)```/u,
    );
    expect(match).not.toBeNull();
    if (match === null) return;
    const configBlock = match[1];
    expect(configBlock).toBeDefined();
    if (configBlock === undefined) return;

    const resolved = configBlock
      .replaceAll(`\${ARGUS_API_TOKEN}`, "test-api-token");
    const config = validateConfig(parse(resolved));

    expect(config.api.host).toBe("0.0.0.0");
    expect(config.api.token).toBe("test-api-token");
  });

  it("keeps every documented Commander command path and option available", async () => {
    const commandPaths = commanderCommandPaths();

    for (const documented of await documentedCliCommands(commandPaths)) {
      const availableOptions = commandPaths.get(documented.path);
      expect(availableOptions, `documented command: ${documented.path}`).toBeDefined();
      if (availableOptions === undefined) continue;
      expect([...availableOptions]).toEqual(
        expect.arrayContaining([...documented.options]),
      );
    }
  });

  it("keeps documented API, diagnostic, and management method-path headings aligned with registered routes", async () => {
    const routes = Reflect.get(argusApp, "API_ROUTES") as
      | Record<string, { method: string; path: string }>
      | undefined;
    expect(routes).toBeDefined();
    if (routes === undefined) return;

    const api = await readFile(path.join(process.cwd(), "apps/web/content/docs/api.mdx"), "utf8");
    const documentedRoutes = new Set(
      [...api.matchAll(/^#{2,3} `([A-Z]+) (\/[^`]+)`/gmu)].map(
        ([, method, routePath]) => `${method} ${routePath}`,
      ),
    );
    const registeredRoutes = new Set(
      Object.values(routes).map(({ method, path: routePath }) => `${method} ${routePath}`),
    );

    expect(documentedRoutes).toEqual(registeredRoutes);
  });
});
