import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  type CommandExecutor,
  type CommandResult,
  checkManagedSearxngHealth,
  checkSearxngHealth,
  type ManagedSearxngHealthContext,
  renderCompose,
  renderSearxngSettings,
  repairSearxng,
  type SearxngRepairContext,
  saveDeploymentState,
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
    timeoutMs: number | undefined;
  }> = [];

  constructor(
    private readonly response: CommandResult = { exitCode: 0, stdout: "", stderr: "" },
    private readonly responses: CommandResult[] = [],
  ) {}

  async run(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandResult> {
    this.calls.push({
      command,
      args,
      cwd: options?.cwd,
      env: options?.env,
      timeoutMs: options?.timeoutMs,
    });
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
      fxembed: false,
      images: {
        argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
        postgres: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
        searxng: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
        fxembed: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${"d".repeat(64)}`,
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
  it("checks SearXNG from the managed runtime network", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    await persistComposeInputs(root);
    const executor = new FixtureExecutor(
      { exitCode: 0, stdout: "", stderr: "" },
      [
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
      ],
    );

    await expect(checkManagedSearxngHealth({ root, executor })).resolves.toEqual({
      healthy: true,
      resultCount: 0,
    });
    expect(executor.calls).toEqual([
      {
        command: "docker",
        args: ["compose", "-p", "argus", "config"],
        cwd: root,
        env: {
          ARGUS_API_PORT: "8788",
          ARGUS_IMAGE: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          POSTGRES_IMAGE: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
          SEARXNG_IMAGE: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
          FXEMBED_IMAGE: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${"d".repeat(64)}`,
        },
        timeoutMs: 5_000,
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          "argus",
          "exec",
          "-T",
          "argus",
          "node",
          "--input-type=module",
          "-e",
          expect.stringContaining("Array.isArray(body.results)"),
          "http://searxng:8080",
        ],
        cwd: root,
        env: {
          ARGUS_API_PORT: "8788",
          ARGUS_IMAGE: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          POSTGRES_IMAGE: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
          SEARXNG_IMAGE: `docker.io/searxng/searxng@sha256:${"b".repeat(64)}`,
          FXEMBED_IMAGE: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${"d".repeat(64)}`,
        },
        timeoutMs: 5_000,
      },
    ]);
  });

  it.each([
    {
      name: "Compose inputs are missing",
      setup: async (_root: string): Promise<ManagedSearxngHealthContext> => {
        const executor = new FixtureExecutor();
        return { root: _root, executor };
      },
    },
    {
      name: "Compose validation fails",
      setup: async (root: string): Promise<ManagedSearxngHealthContext> => {
        await persistComposeInputs(root);
        return {
          root,
          executor: new FixtureExecutor({ exitCode: 1, stdout: "secret-token", stderr: "secret-token" }),
        };
      },
    },
    {
      name: "Compose validation times out",
      setup: async (root: string): Promise<ManagedSearxngHealthContext> => {
        await persistComposeInputs(root);
        return {
          root,
          executor: new FixtureExecutor({
            exitCode: 124,
            stdout: "secret-token",
            stderr: "secret-token",
            timedOut: true,
          }),
        };
      },
    },
    {
      name: "the runtime probe fails",
      setup: async (root: string): Promise<ManagedSearxngHealthContext> => {
        await persistComposeInputs(root);
        return {
          root,
          executor: new FixtureExecutor(
            { exitCode: 0, stdout: "", stderr: "" },
            [
              { exitCode: 0, stdout: "", stderr: "" },
              { exitCode: 1, stdout: "secret-token", stderr: "secret-token" },
            ],
          ),
        };
      },
    },
    {
      name: "the runtime probe times out",
      setup: async (root: string): Promise<ManagedSearxngHealthContext> => {
        await persistComposeInputs(root);
        return {
          root,
          executor: new FixtureExecutor(
            { exitCode: 0, stdout: "", stderr: "" },
            [
              { exitCode: 0, stdout: "", stderr: "" },
              { exitCode: 124, stdout: "secret-token", stderr: "secret-token", timedOut: true },
            ],
          ),
        };
      },
    },
    {
      name: "the executor throws",
      setup: async (root: string): Promise<ManagedSearxngHealthContext> => {
        await persistComposeInputs(root);
        return { root, executor: new ThrowingExecutor() };
      },
    },
  ])("returns an unhealthy redacted result when $name", async ({ setup }) => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);

    const health = await checkManagedSearxngHealth(await setup(root));

    expect(health).toEqual({ healthy: false, resultCount: 0 });
    expect(JSON.stringify(health)).not.toContain("secret-token");
  });

  it("passes an untrusted endpoint as one runtime argv item", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    await persistComposeInputs(root);
    const endpoint = 'http://searxng:8080/"; process.exit(0); // $HOME';
    const executor = new FixtureExecutor(
      { exitCode: 0, stdout: "", stderr: "" },
      [
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
      ],
    );

    await checkManagedSearxngHealth({ root, executor, endpoint });

    const probe = executor.calls[1];
    expect(probe?.args.at(-1)).toBe(endpoint);
    expect(probe?.args.filter((argument) => argument === endpoint)).toEqual([endpoint]);
    expect(probe?.args[probe.args.indexOf("-e") + 1]).not.toContain(endpoint);
  });

  it("renders JSON search settings with private service access and controlled egress", () => {
    const settings = renderSearxngSettings();
    const compose = renderCompose({ version: "0.2.0", storage: "sqlite", searxng: true });

    expect(settings).toContain("formats: [html, json]");
    expect(settings).toContain("limiter: true");
    expect(compose).toContain("networks: [argus-private, argus-egress]");
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
    const executor = new FixtureExecutor(
      { exitCode: 0, stdout: "", stderr: "" },
      [
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 1, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 1, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
      ],
    );
    const diagnostic = await repairSearxng({
      root,
      executor,
      sleep: async () => undefined,
      requestTimeoutMs: 1,
    });

    expectTypeOf<SearxngRepairContext>().not.toHaveProperty("fetcher");
    expect(await readFile(join(root, "searxng", "settings.yml"), "utf8")).toBe(
      renderSearxngSettings(),
    );
    expect(
      executor.calls.filter(
        (call) =>
          call.command === "docker" &&
          call.args.slice(0, 7).join(" ") === "compose -p argus exec -T argus node",
      ),
    ).toHaveLength(3);
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
          recovery:
            "Inspect the listed SearXNG service logs, correct the service failure, and retry the repair.",
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

  it("returns a structured diagnostic when Compose validation times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    await persistComposeInputs(root);
    const executor = new FixtureExecutor({ exitCode: 124, stdout: "secret", stderr: "raw", timedOut: true });

    const diagnostic = await repairSearxng({
      root,
      executor,
    });

    expect(diagnostic.checks).toEqual([expect.objectContaining({ code: "SEARXNG_COMPOSE_CONFIG_TIMEOUT" })]);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  it("returns a structured diagnostic and skips health polling when recreate times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-"));
    roots.push(root);
    await persistComposeInputs(root);
    const executor = new FixtureExecutor(
      { exitCode: 0, stdout: "", stderr: "" },
      [
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 124, stdout: "secret", stderr: "raw", timedOut: true },
      ],
    );

    const diagnostic = await repairSearxng({
      root,
      executor,
    });

    expect(diagnostic.checks).toEqual([expect.objectContaining({ code: "SEARXNG_RECREATE_TIMEOUT" })]);
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls.every((call) => (call.timeoutMs ?? 0) > 0)).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });
});
