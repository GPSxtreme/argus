import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSearxngHealth,
  renderCompose,
  renderSearxngSettings,
  repairSearxng,
  saveDeploymentState,
  type CommandExecutor,
  type CommandResult,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

class FixtureExecutor implements CommandExecutor {
  readonly calls: Array<{
    command: string;
    args: string[];
    cwd: string | undefined;
    env: Record<string, string> | undefined;
  }> = [];

  constructor(
    private readonly response: CommandResult = { exitCode: 0, stdout: "", stderr: "" },
    private readonly responses: CommandResult[] = [],
  ) {}

  async run(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ command, args, cwd: options?.cwd, env: options?.env });
    return this.responses.shift() ?? this.response;
  }
}

const persistComposeInputs = async (root: string): Promise<void> => {
  await saveDeploymentState(root, {
    schemaVersion: 1,
    argusVersion: "0.2.0",
    composeProject: "argus",
    configHash: "config-v1",
    services: {
      argus: { image: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`, healthy: true },
      searxng: {
        image: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
        healthy: true,
      },
    },
    compose: {
      version: "0.2.0",
      apiPort: 8788,
      storage: "sqlite",
      searxng: true,
      images: {
        argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
        postgres: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
        searxng: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
      },
    },
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
};

class ThrowingExecutor implements CommandExecutor {
  async run(): Promise<CommandResult> {
    throw new Error("executor-secret");
  }
}

describe("managed SearXNG", () => {
  it("renders JSON search settings and keeps the managed service private", () => {
    const settings = renderSearxngSettings();
    const compose = renderCompose({ version: "0.2.0", storage: "sqlite", searxng: true });

    expect(settings).toContain("formats: [html, json]");
    expect(settings).toContain("limiter: true");
    expect(compose).toContain("networks: [argus-private]");
    expect(compose).toContain("internal: true");
    expect(compose).not.toContain('"8080:8080"');
  });

  it("ships the deterministic versioned settings used by repair", async () => {
    const settingsPath = fileURLToPath(
      new URL("../../../deploy/managed/searxng/settings.yml", import.meta.url),
    );

    expect(await readFile(settingsPath, "utf8")).toBe(renderSearxngSettings());
  });

  it("reports the result count from the JSON search endpoint", async () => {
    const requested: URL[] = [];
    const health = await checkSearxngHealth("http://searxng:8080", async (input) => {
      requested.push(
        new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
      );
      return jsonResponse({ results: [{ url: "https://argus.example/result" }] });
    });

    expect(requested.map(String)).toEqual(["http://searxng:8080/search?q=argus&format=json"]);
    expect(health).toEqual({ healthy: true, resultCount: 1 });
  });

  it("returns an unhealthy result without exposing a failed endpoint response", async () => {
    const health = await checkSearxngHealth("http://searxng:8080", async () =>
      jsonResponse({ error: "upstream-secret" }, 503),
    );

    expect(health).toEqual({ healthy: false, resultCount: 0 });
    expect(JSON.stringify(health)).not.toContain("upstream-secret");
  });

  it("times out a fetcher that ignores abort signals", async () => {
    let signal: AbortSignal | undefined;
    const health = checkSearxngHealth(
      "http://searxng:8080",
      async (_input, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      },
      { requestTimeoutMs: 10 },
    );

    await expect(health).resolves.toEqual({ healthy: false, resultCount: 0 });
    expect(signal?.aborted).toBe(true);
  }, 200);

  it("rewrites only managed settings, recreates SearXNG, and retries health with a bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    await persistComposeInputs(root);
    const executor = new FixtureExecutor();
    let attempts = 0;
    const diagnostic = await repairSearxng({
      root,
      executor,
      fetcher: async () => {
        attempts += 1;
        return attempts === 3
          ? jsonResponse({ results: [{ url: "https://argus.example/result" }] })
          : jsonResponse({}, 503);
      },
      sleep: async () => undefined,
    });

    expect(await readFile(join(root, "searxng", "settings.yml"), "utf8")).toBe(
      renderSearxngSettings(),
    );
    expect(executor.calls).toEqual([
      {
        command: "docker",
        args: ["compose", "-p", "argus", "config"],
        cwd: root,
        env: {
          ARGUS_API_PORT: "8788",
          ARGUS_VERSION: `0.2.0@sha256:${"a".repeat(64)}`,
          POSTGRES_IMAGE: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
          SEARXNG_IMAGE: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
        },
      },
      {
        command: "docker",
        args: ["compose", "-p", "argus", "up", "-d", "--force-recreate", "searxng"],
        cwd: root,
        env: {
          ARGUS_API_PORT: "8788",
          ARGUS_VERSION: `0.2.0@sha256:${"a".repeat(64)}`,
          POSTGRES_IMAGE: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
          SEARXNG_IMAGE: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
        },
      },
    ]);
    expect(attempts).toBe(3);
    expect(diagnostic).toEqual({
      contractVersion: 1,
      healthy: true,
      checks: [
        {
          component: "searxng",
          status: "healthy",
          code: "SEARXNG_HEALTHY",
          message: "Managed SearXNG is serving JSON search results.",
        },
      ],
    });
  });

  it("returns redacted structured diagnostics when recreation or health fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    await persistComposeInputs(root);
    const diagnostic = await repairSearxng({
      root,
      executor: new FixtureExecutor(
        { exitCode: 0, stdout: "", stderr: "" },
        [
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 1, stdout: "token=secret", stderr: "raw failure" },
        ],
      ),
      fetcher: async () => jsonResponse({ error: "response-secret" }, 503),
      sleep: async () => undefined,
    });

    expect(diagnostic).toEqual({
      contractVersion: 1,
      healthy: false,
      checks: [
        {
          component: "searxng",
          status: "unhealthy",
          code: "SEARXNG_RECREATE_FAILED",
          message: "Managed SearXNG could not be recreated.",
          recovery: "argus repair searxng",
          logsCommand: "docker compose -p argus logs searxng",
        },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(JSON.stringify(diagnostic)).not.toContain("raw failure");
  });

  it("contains command execution errors in a structured diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    await persistComposeInputs(root);

    await expect(
      repairSearxng({ root, executor: new ThrowingExecutor(), sleep: async () => undefined }),
    ).resolves.toEqual(
      expect.objectContaining({
        healthy: false,
        checks: [expect.objectContaining({ code: "SEARXNG_RECREATE_FAILED" })],
      }),
    );
  });

  it("refuses repair when validated pinned Compose inputs are not persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    const executor = new FixtureExecutor();

    await expect(repairSearxng({ root, executor })).resolves.toEqual(
      expect.objectContaining({
        healthy: false,
        checks: [expect.objectContaining({ code: "SEARXNG_COMPOSE_INPUTS_UNAVAILABLE" })],
      }),
    );
    expect(executor.calls).toEqual([]);
  });
});
