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
    createSmokeWatch: async ({ source, targetId }) => ({
      id: `doctor-${source}`,
      targetId: `doctor-${source}-target`,
      source,
      configuredTargetId: targetId,
    }),
    pollRecords: async ({ targetId }) => {
      const source = targetId.split("-")[1] as keyof typeof sourceUrl;
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

    expect(report.healthy).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "docker", status: "healthy" }),
        expect.objectContaining({ component: "argus", status: "healthy" }),
        expect.objectContaining({ component: "storage", status: "healthy" }),
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
            id: "watch",
            targetId: "__argus_doctor:watch",
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

  it("reports an actual storage probe failure", async () => {
    const report = await runDoctor(
      context({
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
      }),
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
          return { id: "watch", targetId: "diagnostic", source, configuredTargetId: targetId };
        }),
      pollRecords: ({ signal }) =>
        abortable(signal, () => new Promise(() => undefined)),
      removeSmokeWatch: ({ signal }) =>
        abortable(signal, async () => {
          mutations.push("cleaned");
        }),
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
    expect(serialized).not.toMatch(/argus repair (fxembed|telegram|web|x)/);
    expect(serialized).toContain("argus repair searxng");
  });
});
