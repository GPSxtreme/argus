import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { loadConfig, validateConfig } from "@argus/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import * as argusApp from "../../argus/src/app.js";
import { assertApiBindGuard } from "../../argus/src/runtime.js";
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

const commanderPublicCommands = (
  program = createProgram(cliDependencies),
): Map<string, Set<string>> => {
  const paths = new Map<string, Set<string>>();
  const optionsFor = (command: typeof program): Set<string> =>
    new Set(
      command.options.flatMap((option) =>
        option.long === undefined ? [] : [option.long],
      ),
    );
  const visit = (command: typeof program, prefix: string): void => {
    for (const child of command.commands) {
      const path = `${prefix} ${child.name()}`;
      if (child.commands.length === 0) {
        paths.set(path, optionsFor(child));
      } else {
        visit(child, path);
      }
    }
  };
  const versionOption = program.options.find(
    (option) => option.attributeName() === "version",
  );
  if (versionOption?.long !== undefined) {
    paths.set("argus", new Set([versionOption.long]));
  }
  visit(program, "argus");
  return paths;
};

const parseDocumentedCliInvocation = (
  invocation: string,
  program = createProgram(cliDependencies),
): DocumentedCliCommand | undefined => {
  const tokens = invocation.split(/\s+/u);
  expect(tokens[0], `documented CLI invocation: ${invocation}`).toBe("argus");

  let command = program;
  const path = ["argus"];
  let index = 1;
  while (index < tokens.length && !tokens[index]?.startsWith("-")) {
    const child = command.commands.find(
      (candidate) => candidate.name() === tokens[index],
    );
    if (child === undefined) break;
    command = child;
    path.push(child.name());
    index += 1;
  }

  if (command === program) {
    if (tokens.length < 2) return undefined;
    const option = program.options.find(
      (candidate) => candidate.long === tokens[1],
    );
    if (
      option?.attributeName() === "version" &&
      option.long !== undefined &&
      tokens.length === 2
    ) {
      return { path: "argus", options: new Set([option.long]) };
    }
    if (tokens[1] === "--help" && tokens.length === 2) return undefined;
    expect.fail(`documented CLI invocation has an unknown command: ${invocation}`);
  }
  expect(command.commands, `documented CLI invocation: ${invocation}`).toHaveLength(0);

  const positionalArguments = command.registeredArguments;
  let positionalIndex = 0;
  const options = new Set<string>();
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (token.startsWith("--")) {
      const [name, inlineValue] = token.split("=", 2);
      const option = command.options.find(
        (candidate) => candidate.long === name,
      );
      expect(option, `documented CLI invocation: ${invocation}`).toBeDefined();
      if (option === undefined) break;
      options.add(name as string);
      if ((option.required || option.optional) && inlineValue === undefined) {
        expect(tokens[index + 1], `documented CLI invocation: ${invocation}`).toBeDefined();
        index += 1;
      }
    } else {
      expect(
        positionalIndex,
        `documented CLI invocation has an undeclared positional token: ${invocation}`,
      ).toBeLessThan(positionalArguments.length);
      positionalIndex += 1;
    }
    index += 1;
  }

  return { path: path.join(" "), options };
};

const documentedCliCommands = async (
  program = createProgram(cliDependencies),
): Promise<DocumentedCliCommand[]> => {
  const documented = new Map<string, Set<string>>();

  for (const page of source.getPages()) {
    const text = await page.data.getText("processed");
    for (const match of text.matchAll(/(?:^\s*|`)((?:pnpm\s+)?argus(?=[ \t])[^\n`]*)/gmu)) {
      const invocation = (match[1] as string).replace(/^pnpm\s+/u, "").trim();
      const parsed = parseDocumentedCliInvocation(invocation, program);
      if (parsed === undefined) continue;
      documented.set(
        parsed.path,
        new Set([...documented.get(parsed.path) ?? [], ...parsed.options]),
      );
    }
  }

  return [...documented].map(([path, options]) => ({ path, options }));
};

const commandSurface = (
  commands: Iterable<DocumentedCliCommand>,
): Record<string, string[]> =>
  Object.fromEntries(
    [...commands]
      .map(({ path, options }) => [path, [...options].sort()] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

const registeredApiRoutes = (): Set<string> => {
  const config = validateConfig({
    version: 2,
    storage: { adapter: "sqlite", url: ":memory:" },
    sources: {},
    watches: [],
    api: { token: "test-api-token" },
  });
  const app = argusApp.createApp({
    config,
    repository: {} as Parameters<typeof argusApp.createApp>[0]["repository"],
  });
  return new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  );
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

  it("loads the primary VPS configuration with managed Compose API access", async () => {
    const content = await readFile(configurationPath, "utf8");
    const match = content.match(
      /### Single VPS with SQLite\n\n[\s\S]*?```yaml config\n([\s\S]*?)```/u,
    );
    expect(match).not.toBeNull();
    if (match === null) return;
    const configBlock = match[1];
    expect(configBlock).toBeDefined();
    if (configBlock === undefined) return;

    const directory = await mkdtemp(join(tmpdir(), "argus-docs-"));
    const configPath = join(directory, "argus.yaml");
    try {
      await writeFile(configPath, configBlock, "utf8");
      const config = await loadConfig(configPath, {
        ARGUS_API_TOKEN: "test-api-token",
      });

      expect(config.api.host).toBe("0.0.0.0");
      expect(config.api.token).toBe("test-api-token");
      expect(() => assertApiBindGuard(config)).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the documented public Commander command paths and long options exact", async () => {
    const documented = await documentedCliCommands();
    const available = commanderPublicCommands();

    expect(commandSurface(documented)).toEqual(
      commandSurface(
        [...available].map(([path, options]) => ({ path, options })),
      ),
    );
  });

  it("rejects unknown command words after an otherwise valid CLI path", () => {
    expect(() => parseDocumentedCliInvocation("argus missing")).toThrow();
    expect(() => parseDocumentedCliInvocation("argus doctor extra")).toThrow(
      /undeclared positional token/u,
    );
    expect(() => parseDocumentedCliInvocation("argus config missing")).toThrow();
  });

  it("keeps documented API, diagnostic, and management method-path headings aligned with registered routes", async () => {
    const api = await readFile(path.join(process.cwd(), "apps/web/content/docs/api.mdx"), "utf8");
    const documentedRoutes = new Set(
      [...api.matchAll(/^#{2,3} `([A-Z]+) (\/[^`]+)`/gmu)].map(
        ([, method, routePath]) => `${method} ${routePath}`,
      ),
    );
    expect(documentedRoutes).toEqual(registeredApiRoutes());
  });
});
