import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createArgusDoctorApi,
  type DoctorArgusApi,
  type DoctorContext,
  repairService,
  runDoctor,
  saveDeploymentState,
} from "../src/index.js";

const roots: string[] = [];
const result = (
  exitCode = 0,
  stdout = "",
) => ({ exitCode, stdout, stderr: "secret-token" });

const abortable = async <T>(
  signal: AbortSignal,
  operation: () => Promise<T> | T,
): Promise<T> => {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(operation()).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
};

const sourceUrl = {
  telegram: "https://t.me/argus_public/42",
  web: "HTTPS://Example.Test:443/article/#fragment",
  x: "https://x.com/argus/status/12345",
} as const;

const diagnosticIds = {
  telegram: "00000000-0000-4000-8000-000000000001",
  web: "00000000-0000-4000-8000-000000000002",
  x: "00000000-0000-4000-8000-000000000003",
} as const;

const context = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  root: "/opt/argus",
  executor: {
    run: async (_file, args) =>
      args.includes("ps")
        ? result(0, JSON.stringify({ Service: "argus", State: "running", Health: "healthy" }))
        : result(),
  },
  api: {
    health: async () => true,
    createSmokeWatch: async ({ source, targetId }) => {
      const id = diagnosticIds[source];
      return {
        id,
        targetId: `__argus_doctor:${id}`,
        source,
        configuredTargetId: targetId,
      };
    },
    pollRecords: async ({ targetId }) => {
      const id = targetId.slice("__argus_doctor:".length);
      const source = (
        Object.entries(diagnosticIds) as Array<
          [keyof typeof diagnosticIds, string]
        >
      ).find(([, candidate]) => candidate === id)?.[0] as keyof typeof sourceUrl;
      return [{ source, targetId, url: sourceUrl[source] }];
    },
    removeSmokeWatch: async () => undefined,
  } satisfies DoctorArgusApi,
  storage: "sqlite",
  managed: { searxng: "disabled", fxembed: "disabled" },
  sources: { web: true, telegram: false, x: false },
  diagnosticTargetIds: { web: "configured-web-target" },
  checkTimeoutMs: 100,
  aggregateTimeoutMs: 500,
  smokeDeadlineMs: 50,
  cleanupGraceMs: 25,
  pollIntervalMs: 1,
  ...overrides,
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("deployment doctor", () => {
  it("skips disabled components and enabled sources without a configured target", async () => {
    const report = await runDoctor(
      context({
        sources: { web: true, telegram: false, x: false },
        diagnosticTargetIds: {},
      }),
    );

    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "docker", status: "healthy" }),
        expect.objectContaining({ component: "argus", status: "healthy" }),
        expect.objectContaining({
          component: "storage",
          status: "unhealthy",
          code: "STORAGE_COMPOSE_STATE_UNAVAILABLE",
        }),
        expect.objectContaining({
          component: "web",
          status: "skipped",
          code: "SOURCE_DIAGNOSTIC_TARGET_NOT_CONFIGURED",
        }),
        expect.objectContaining({ component: "searxng", status: "skipped" }),
        expect.objectContaining({ component: "fxembed", status: "skipped" }),
        expect.objectContaining({ component: "telegram", status: "skipped" }),
        expect.objectContaining({ component: "x", status: "skipped" }),
      ]),
    );
  });

  it("validates canonical record identities for every source without using configured URLs", async () => {
    const report = await runDoctor(
      context({
        sources: { telegram: true, web: true, x: true },
        diagnosticTargetIds: {
          telegram: "configured-telegram-target",
          web: "configured-web-target",
          x: "configured-x-target",
        },
      }),
    );

    expect(report.checks.filter((check) =>
      ["telegram", "web", "x"].includes(check.component),
    )).toEqual([
      expect.objectContaining({ component: "telegram", status: "healthy" }),
      expect.objectContaining({ component: "web", status: "healthy" }),
      expect.objectContaining({ component: "x", status: "healthy" }),
    ]);
  });

  it("uses the strict source and targetId API contract", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const api = createArgusDoctorApi({
      endpoint: "https://argus.test",
      token: "private",
      fetcher: async (input, init) => {
        requests.push({ url: String(input), ...(init ? { init } : {}) });
        return new Response(
          JSON.stringify({
            id: diagnosticIds.web,
            targetId: `__argus_doctor:${diagnosticIds.web}`,
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      },
    });
    await api.createSmokeWatch({
      source: "web",
      targetId: "configured-web",
      signal: new AbortController().signal,
    });

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      source: "web",
      targetId: "configured-web",
    });
  });

  it.each([
    {
      payload: {
        id: "not-a-uuid",
        targetId: "__argus_doctor:not-a-uuid",
      },
    },
    {
      payload: {
        id: diagnosticIds.web,
        targetId: `__argus_doctor:${diagnosticIds.telegram}`,
      },
    },
  ])("rejects malformed diagnostic watch identities from Argus", async ({ payload }) => {
    const api = createArgusDoctorApi({
      endpoint: "https://argus.test",
      token: "private",
      fetcher: async () =>
        new Response(JSON.stringify(payload), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(
      api.createSmokeWatch({
        source: "web",
        targetId: "configured-web",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Argus diagnostic API request failed.");
  });

  it("rejects diagnostic records that do not belong to the exact target and source", async () => {
    const api = createArgusDoctorApi({
      endpoint: "https://argus.test",
      token: "private",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                source: "telegram",
                targetId: `__argus_doctor:${diagnosticIds.telegram}`,
                url: sourceUrl.telegram,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(
      api.pollRecords({
        id: diagnosticIds.web,
        targetId: `__argus_doctor:${diagnosticIds.web}`,
        source: "web",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Argus diagnostic API request failed.");
  });

  it("reports an actual storage probe failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-doctor-"));
    roots.push(root);
    await saveDeploymentState(root, {
      schemaVersion: 1,
      argusVersion: "0.2.0",
      composeProject: "argus",
      configHash: "config-v1",
      services: {
        postgres: {
          image: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
          healthy: true,
        },
      },
      compose: {
        version: "0.2.0",
        apiPort: 8788,
        storage: "postgres",
        searxng: false,
        images: {
          argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          postgres: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
          searxng: `docker.io/searxng/searxng@sha256:${"c".repeat(64)}`,
        },
      },
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const report = await runDoctor(
      context({
        root,
        storage: "postgres",
        executor: {
          run: async (_file, args) =>
            args.includes("psql") ? result(1) : result(),
        },
      }),
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        component: "storage",
        status: "unhealthy",
        code: "STORAGE_HEALTHCHECK_FAILED",
        logsCommand: "docker compose -p argus logs postgres",
      }),
    );
  });

  it("loads persisted Compose inputs for storage config and exec without ambient fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-doctor-"));
    roots.push(root);
    await saveDeploymentState(root, {
      schemaVersion: 1,
      argusVersion: "0.2.0",
      composeProject: "argus",
      configHash: "config-v1",
      services: {
        argus: {
          image: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          healthy: true,
        },
      },
      compose: {
        version: "0.2.0",
        apiPort: 8788,
        storage: "sqlite",
        searxng: false,
        images: {
          argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          postgres: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
          searxng: `docker.io/searxng/searxng@sha256:${"c".repeat(64)}`,
        },
      },
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const calls: Array<{
      args: string[];
      env: Record<string, string> | undefined;
    }> = [];

    const report = await runDoctor(
      context({
        root,
        executor: {
          run: async (_file, args, options) => {
            calls.push({ args, env: options?.env });
            return result();
          },
        },
      }),
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ component: "storage", status: "healthy" }),
    );
    const storageCalls = calls.filter(
      ({ args }) => args.includes("config") || args.includes("exec"),
    );
    expect(storageCalls.map(({ args }) => args)).toEqual([
      ["compose", "-p", "argus", "config"],
      expect.arrayContaining(["compose", "-p", "argus", "exec", "argus"]),
    ]);
    expect(
      storageCalls.every(
        ({ env }) =>
          env?.ARGUS_IMAGE === `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}` &&
          env.ARGUS_API_PORT === "8788",
      ),
    ).toBe(true);
  });

  it("reports a stable storage diagnostic when persisted Compose state is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-doctor-"));
    roots.push(root);
    const report = await runDoctor(context({ root }));

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        component: "storage",
        status: "unhealthy",
        code: "STORAGE_COMPOSE_STATE_UNAVAILABLE",
        logsCommand: "docker compose -p argus logs argus",
      }),
    );
  });

  it("returns by the aggregate deadline plus bounded grace when dependencies ignore abort", async () => {
    const startedAt = Date.now();
    const report = await runDoctor(
      context({
        executor: { run: async () => await new Promise(() => undefined) },
        api: {
          ...context().api,
          health: async () => await new Promise(() => undefined),
        },
        sources: {},
        aggregateTimeoutMs: 20,
        checkTimeoutMs: 500,
        cleanupGraceMs: 10,
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "docker",
          code: "DIAGNOSTIC_TIMEOUT",
        }),
        expect.objectContaining({
          component: "argus",
          code: "DIAGNOSTIC_TIMEOUT",
        }),
      ]),
    );
  });

  it("aborts aggregate work, awaits cleanup, and has no mutations after return", async () => {
    vi.useFakeTimers();
    const mutations: string[] = [];
    const api: DoctorArgusApi = {
      health: async () => true,
      createSmokeWatch: ({ source, targetId, signal }) =>
        abortable(signal, async () => {
          mutations.push("created");
          const id = diagnosticIds[source];
          return {
            id,
            targetId: `__argus_doctor:${id}`,
            source,
            configuredTargetId: targetId,
          };
        }),
      pollRecords: () => new Promise(() => undefined),
      removeSmokeWatch: async () => {
        await Promise.resolve();
          mutations.push("cleaned");
      },
    };
    const promise = runDoctor(
      context({
        api,
        aggregateTimeoutMs: 20,
        checkTimeoutMs: 100,
        smokeDeadlineMs: 50,
        cleanupGraceMs: 20,
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    const report = await promise;
    expect(report.checks).toContainEqual(
      expect.objectContaining({ component: "web", status: "unhealthy" }),
    );
    expect(mutations).toEqual(["created", "cleaned"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mutations).toEqual(["created", "cleaned"]);
  });

  it("returns after bounded cleanup grace when diagnostic deletion ignores abort", async () => {
    const startedAt = Date.now();
    const report = await runDoctor(
      context({
        api: {
          ...context().api,
          pollRecords: () => new Promise(() => undefined),
          removeSmokeWatch: () => new Promise(() => undefined),
        },
        aggregateTimeoutMs: 20,
        smokeDeadlineMs: 100,
        cleanupGraceMs: 10,
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        component: "web",
        status: "unhealthy",
        code: "SOURCE_SMOKE_CLEANUP_FAILED",
      }),
    );
  });

  it("does not return while diagnostic cleanup is behind a barrier", async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupBarrier = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let returned = false;
    const promise = runDoctor(
      context({
        api: {
          ...context().api,
          removeSmokeWatch: async ({ signal }) => {
            await abortable(signal, () => cleanupBarrier);
          },
        },
      }),
    ).then((report) => {
      returned = true;
      return report;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    releaseCleanup?.();
    const report = await promise;
    expect(returned).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ component: "web", status: "healthy" }),
    );
  });

  it("surfaces cleanup failure deterministically after a smoke timeout", async () => {
    vi.useFakeTimers();
    const api: DoctorArgusApi = {
      ...context().api,
      pollRecords: ({ signal }) =>
        abortable(signal, () => new Promise(() => undefined)),
      removeSmokeWatch: async () => {
        throw new Error("secret-token");
      },
    };
    const promise = runDoctor(context({ api }));
    await vi.advanceTimersByTimeAsync(200);
    const report = await promise;
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        component: "web",
        code: "SOURCE_SMOKE_CLEANUP_FAILED",
        recovery: "Inspect Argus logs and remove the diagnostic watch through the authenticated diagnostics API.",
      }),
    );
    expect(JSON.stringify(report)).not.toContain("secret-token");
  });

  it("rejects non-canonical Telegram and X record URLs", async () => {
    const report = await runDoctor(
      context({
        sources: { telegram: true, x: true },
        diagnosticTargetIds: { telegram: "telegram", x: "x" },
        api: {
          ...context().api,
          pollRecords: async ({ targetId }) => [
            {
              source: targetId.includes("telegram") ? "telegram" : "x",
              targetId,
              url: "https://example.test/not-a-public-post",
            },
          ],
        },
      }),
    );
    expect(report.checks.filter((check) => ["telegram", "x"].includes(check.component)))
      .toEqual([
        expect.objectContaining({ component: "telegram", status: "unhealthy" }),
        expect.objectContaining({ component: "x", status: "unhealthy" }),
      ]);
  });

  it("verifies exactly the repaired service record", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-doctor-"));
    roots.push(root);
    await saveDeploymentState(root, {
      schemaVersion: 1,
      argusVersion: "0.2.0",
      composeProject: "argus",
      configHash: "config-v1",
      services: {
        argus: {
          image: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          healthy: true,
        },
      },
      compose: {
        version: "0.2.0",
        apiPort: 8788,
        storage: "sqlite",
        searxng: false,
        images: {
          argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          postgres: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
          searxng: `docker.io/searxng/searxng@sha256:${"c".repeat(64)}`,
        },
      },
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const report = await repairService(
      "argus",
      context({
        root,
        executor: {
          run: async (_file, args) => {
            if (args.includes("ps")) {
              return result(0, [
                JSON.stringify({ Service: "not-argus", State: "running", Health: "healthy" }),
                JSON.stringify({ Service: "argus-worker", State: "running", Health: "healthy" }),
              ].join("\n"));
            }
            return result();
          },
        },
      }),
    );
    expect(report).toMatchObject({ healthy: false });
    expect(report.checks[0]).toMatchObject({ code: "REPAIR_VERIFY_FAILED" });
  });

  it.each([
    ["argus", "sqlite"],
    ["postgres", "postgres"],
  ] as const)(
    "accepts a running %s repair when Compose declares no healthcheck",
    async (service, storage) => {
      const root = await mkdtemp(join(tmpdir(), "argus-doctor-"));
      roots.push(root);
      await saveDeploymentState(root, {
        schemaVersion: 1,
        argusVersion: "0.2.0",
        composeProject: "argus",
        configHash: "config-v1",
        services: {
          [service]: {
            image:
              service === "argus"
                ? `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`
                : `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
            healthy: true,
          },
        },
        compose: {
          version: "0.2.0",
          apiPort: 8788,
          storage,
          searxng: false,
          images: {
            argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
            postgres: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
            searxng: `docker.io/searxng/searxng@sha256:${"c".repeat(64)}`,
          },
        },
        updatedAt: "2026-08-01T00:00:00.000Z",
      });

      const report = await repairService(
        service,
        context({
          root,
          storage,
          executor: {
            run: async (_file, args) =>
              args.includes("ps")
                ? result(
                    0,
                    JSON.stringify({
                      Service: service,
                      State: "running",
                      Health: "",
                    }),
                  )
                : result(),
          },
        }),
      );

      expect(report).toMatchObject({ healthy: true });
      expect(report.checks[0]).toMatchObject({
        status: "healthy",
        code: "REPAIR_HEALTHY",
      });
    },
  );

  it("rejects a running repaired service with a declared unhealthy status", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-doctor-"));
    roots.push(root);
    await saveDeploymentState(root, {
      schemaVersion: 1,
      argusVersion: "0.2.0",
      composeProject: "argus",
      configHash: "config-v1",
      services: {
        argus: {
          image: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          healthy: true,
        },
      },
      compose: {
        version: "0.2.0",
        apiPort: 8788,
        storage: "sqlite",
        searxng: false,
        images: {
          argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          postgres: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
          searxng: `docker.io/searxng/searxng@sha256:${"c".repeat(64)}`,
        },
      },
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const report = await repairService(
      "argus",
      context({
        root,
        executor: {
          run: async (_file, args) =>
            args.includes("ps")
              ? result(
                  0,
                  JSON.stringify({
                    Service: "argus",
                    State: "running",
                    Health: "unhealthy",
                  }),
                )
              : result(),
        },
      }),
    );

    expect(report).toMatchObject({ healthy: false });
    expect(report.checks[0]).toMatchObject({ code: "REPAIR_VERIFY_FAILED" });
  });

  it("rejects an exact repaired service record that is stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-doctor-"));
    roots.push(root);
    await saveDeploymentState(root, {
      schemaVersion: 1,
      argusVersion: "0.2.0",
      composeProject: "argus",
      configHash: "config-v1",
      services: {
        argus: {
          image: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          healthy: true,
        },
      },
      compose: {
        version: "0.2.0",
        apiPort: 8788,
        storage: "sqlite",
        searxng: false,
        images: {
          argus: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
          postgres: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
          searxng: `docker.io/searxng/searxng@sha256:${"c".repeat(64)}`,
        },
      },
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const report = await repairService(
      "argus",
      context({
        root,
        executor: {
          run: async (_file, args) =>
            args.includes("ps")
              ? result(
                  0,
                  JSON.stringify({
                    Service: "argus",
                    State: "exited",
                    Health: "",
                  }),
                )
              : result(),
        },
      }),
    );

    expect(report).toMatchObject({ healthy: false });
    expect(report.checks[0]).toMatchObject({ code: "REPAIR_VERIFY_FAILED" });
  });

  it("reports unsupported repairs as failed rather than skipped", async () => {
    const report = await repairService(
      "postgres",
      context({ storage: "sqlite" }),
    );

    expect(report).toMatchObject({ healthy: false });
    expect(report.checks[0]).toMatchObject({
      status: "unhealthy",
      code: "POSTGRES_NOT_SELECTED",
    });
  });

  it("only advertises implemented repair commands", async () => {
    const report = await runDoctor(
      context({
        managed: { searxng: "managed", fxembed: "managed" },
        searxngEndpoint: "https://search.test",
        fxembedEndpoint: "https://fx.test",
        fetcher: async () => new Response(null, { status: 503 }),
        sources: { telegram: true, web: true, x: true },
        diagnosticTargetIds: {},
      }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/argus (repair|status|doctor)/);
  });
});
