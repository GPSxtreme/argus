import type { DiagnosticReport } from "./contracts.js";
import type { CommandExecutor } from "./executor.js";
import { loadPersistedComposeEnvironment } from "./reconciler.js";
import { repairSearxng, type SearxngFetcher } from "./searxng.js";

type Component =
  | "docker"
  | "argus"
  | "postgres"
  | "storage"
  | "searxng"
  | "fxembed"
  | "telegram"
  | "web"
  | "x";
type Source = "telegram" | "web" | "x";
type Check = DiagnosticReport["checks"][number];
type DiagnosticRecord = {
  source: Source;
  targetId: string;
  url: string;
};

export interface DoctorArgusApi {
  health(signal: AbortSignal): Promise<boolean>;
  createSmokeWatch(input: {
    source: Source;
    targetId: string;
    signal: AbortSignal;
  }): Promise<{
    id: string;
    targetId: string;
    source: Source;
    configuredTargetId: string;
  }>;
  pollRecords(input: {
    targetId: string;
    signal: AbortSignal;
  }): Promise<DiagnosticRecord[]>;
  removeSmokeWatch(input: { id: string; signal: AbortSignal }): Promise<void>;
}

export interface ArgusDoctorApiOptions {
  endpoint: string;
  token: string;
  fetcher?: SearxngFetcher;
  requestTimeoutMs?: number;
}

const bounded = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(Math.max(1, value), maximum);

const timeoutSignal = (
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; cancel(): void } => {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Diagnostic deadline reached.")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
};

/** Authenticated and secret-safe client for the server-owned diagnostic-watch API. */
export const createArgusDoctorApi = ({
  endpoint,
  token,
  fetcher = fetch,
  requestTimeoutMs,
}: ArgusDoctorApiOptions): DoctorArgusApi => {
  const base = endpoint.replace(/\/+$/, "");
  const request = async (
    path: string,
    signal: AbortSignal,
    init?: RequestInit,
  ): Promise<Response> => {
    const deadline = timeoutSignal(
      bounded(requestTimeoutMs, 5_000, 10_000),
      signal,
    );
    try {
      const response = await fetcher(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...Object.fromEntries(new Headers(init?.headers).entries()),
        },
        signal: deadline.signal,
      });
      if (!response.ok) throw new Error("request failed");
      return response;
    } catch {
      throw new Error("Argus diagnostic API request failed.");
    } finally {
      deadline.cancel();
    }
  };

  return {
    async health(signal) {
      const deadline = timeoutSignal(
        bounded(requestTimeoutMs, 5_000, 10_000),
        signal,
      );
      try {
        return (
          await fetcher(`${base}/health`, { signal: deadline.signal })
        ).ok;
      } catch {
        return false;
      } finally {
        deadline.cancel();
      }
    },
    async createSmokeWatch({ source, targetId, signal }) {
      const response = await request(
        "/v1/diagnostics/smoke-watches",
        signal,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source, targetId }),
        },
      );
      const payload = (await response.json()) as unknown;
      if (!payload || typeof payload !== "object") {
        throw new Error("Argus diagnostic API request failed.");
      }
      const value = payload as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.targetId !== "string") {
        throw new Error("Argus diagnostic API request failed.");
      }
      return {
        id: value.id,
        targetId: value.targetId,
        source,
        configuredTargetId: targetId,
      };
    },
    async pollRecords({ targetId, signal }) {
      const response = await request(
        `/v1/records?target=${encodeURIComponent(targetId)}&limit=50`,
        signal,
      );
      const payload = (await response.json()) as unknown;
      const records =
        payload && typeof payload === "object"
          ? (payload as { items?: unknown }).items
          : undefined;
      if (!Array.isArray(records)) return [];
      return records.flatMap((record) => {
        if (!record || typeof record !== "object") return [];
        const value = record as Record<string, unknown>;
        if (
          (value.source !== "telegram" &&
            value.source !== "web" &&
            value.source !== "x") ||
          typeof value.targetId !== "string" ||
          typeof value.url !== "string"
        ) {
          return [];
        }
        return [
          {
            source: value.source,
            targetId: value.targetId,
            url: value.url,
          },
        ];
      });
    },
    async removeSmokeWatch({ id, signal }) {
      await request(
        `/v1/diagnostics/smoke-watches/${encodeURIComponent(id)}`,
        signal,
        { method: "DELETE" },
      );
    },
  };
};

export interface DoctorContext {
  root: string;
  executor: CommandExecutor;
  api: DoctorArgusApi;
  storage: "sqlite" | "postgres";
  managed: {
    searxng: "disabled" | "managed" | "external";
    fxembed: "disabled" | "managed" | "external";
  };
  sources: Partial<Record<Source, boolean>>;
  diagnosticTargetIds?: Partial<Record<Source, string>>;
  searxngEndpoint?: string;
  fxembedEndpoint?: string;
  fetcher?: SearxngFetcher;
  checkTimeoutMs?: number;
  aggregateTimeoutMs?: number;
  smokeDeadlineMs?: number;
  cleanupGraceMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const logs: Record<Component, string> = {
  docker: "docker info",
  argus: "docker compose -p argus logs argus",
  postgres: "docker compose -p argus logs postgres",
  storage: "docker compose -p argus logs postgres",
  searxng: "docker compose -p argus logs searxng",
  fxembed: "argus status",
  telegram: "docker compose -p argus logs argus",
  web: "docker compose -p argus logs argus",
  x: "docker compose -p argus logs argus",
};

const recovery: Record<Component, string> = {
  docker: "Verify Docker is installed and running, then retry the diagnostic.",
  argus: "Run argus repair argus.",
  postgres: "Run argus repair postgres.",
  storage: "Inspect the configured storage and Argus logs; run argus repair postgres only when PostgreSQL is selected.",
  searxng: "Run argus repair searxng.",
  fxembed: "Inspect the Cloudflare Worker deployment and endpoint, then redeploy FxEmbed manually.",
  telegram: "Inspect the configured Telegram target and Argus source logs, then retry the diagnostic.",
  web: "Inspect the configured Web target and Argus source logs, then retry the diagnostic.",
  x: "Inspect the configured X target and Argus source logs, then retry the diagnostic.",
};

const healthy = (
  component: Component,
  code: string,
  message: string,
): Check => ({ component, status: "healthy", code, message });
const skipped = (
  component: Component,
  code: string,
  message: string,
): Check => ({ component, status: "skipped", code, message });
const unhealthy = (
  component: Component,
  code: string,
  message: string,
  overrideRecovery?: string,
): Check => ({
  component,
  status: "unhealthy",
  code,
  message,
  recovery: overrideRecovery ?? recovery[component],
  logsCommand: logs[component],
});

const abortableSleep = (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });

const normalizedHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url;
  } catch {
    return undefined;
  }
};

const canonicalRecordMatches = (
  source: Source,
  targetId: string,
  record: DiagnosticRecord,
): boolean => {
  if (record.source !== source || record.targetId !== targetId) return false;
  const url = normalizedHttpUrl(record.url);
  if (!url) return false;
  if (source === "web") return true;
  if (source === "telegram") {
    return (
      url.protocol === "https:" &&
      url.hostname === "t.me" &&
      /^\/(?:s\/)?[A-Za-z0-9_]+\/\d+$/.test(url.pathname)
    );
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === "x.com" || url.hostname === "twitter.com") &&
    /^\/[A-Za-z0-9_]+\/status\/\d+$/.test(url.pathname)
  );
};

const smokeCheck = async (
  source: Source,
  context: DoctorContext,
  parentSignal: AbortSignal,
): Promise<Check> => {
  if (!context.sources[source]) {
    return skipped(source, "SOURCE_DISABLED", `${source} source is disabled.`);
  }
  const configuredTargetId = context.diagnosticTargetIds?.[source];
  if (!configuredTargetId) {
    return skipped(
      source,
      "SOURCE_DIAGNOSTIC_TARGET_NOT_CONFIGURED",
      `${source} source has no configured diagnostic target.`,
    );
  }

  const deadline = timeoutSignal(
    bounded(context.smokeDeadlineMs, 10_000, 30_000),
    parentSignal,
  );
  let smoke:
    | {
        id: string;
        targetId: string;
        source: Source;
        configuredTargetId: string;
      }
    | undefined;
  let outcome: Check | undefined;
  try {
    smoke = await context.api.createSmokeWatch({
      source,
      targetId: configuredTargetId,
      signal: deadline.signal,
    });
    while (!deadline.signal.aborted) {
      const records = await context.api.pollRecords({
        targetId: smoke.targetId,
        signal: deadline.signal,
      });
      if (
        records.some((record) =>
          canonicalRecordMatches(source, smoke?.targetId ?? "", record),
        )
      ) {
        outcome = healthy(
          source,
          "SOURCE_SMOKE_HEALTHY",
          `${source} source ingested its dedicated diagnostic target.`,
        );
        break;
      }
      await (context.sleep ?? abortableSleep)(
        bounded(context.pollIntervalMs, 200, 1_000),
        deadline.signal,
      );
    }
  } catch {
    outcome = unhealthy(
      source,
      deadline.signal.aborted ? "SOURCE_SMOKE_TIMEOUT" : "SOURCE_SMOKE_FAILED",
      deadline.signal.aborted
        ? `${source} source did not ingest its dedicated diagnostic target before the deadline.`
        : `${source} source diagnostic request failed.`,
    );
  } finally {
    deadline.cancel();
  }

  if (!smoke) {
    return (
      outcome ??
      unhealthy(
        source,
        "SOURCE_SMOKE_FAILED",
        `${source} source diagnostic request failed.`,
      )
    );
  }

  const cleanup = timeoutSignal(
    bounded(context.cleanupGraceMs, 2_000, 10_000),
  );
  try {
    await context.api.removeSmokeWatch({
      id: smoke.id,
      signal: cleanup.signal,
    });
  } catch {
    return unhealthy(
      source,
      "SOURCE_SMOKE_CLEANUP_FAILED",
      "The dedicated diagnostic watch could not be removed.",
      "Inspect Argus logs and remove the diagnostic watch through the authenticated diagnostics API.",
    );
  } finally {
    cleanup.cancel();
  }
  return (
    outcome ??
    unhealthy(
      source,
      "SOURCE_SMOKE_TIMEOUT",
      `${source} source did not ingest its dedicated diagnostic target before the deadline.`,
    )
  );
};

const endpointCheck = async (
  component: "searxng" | "fxembed",
  endpoint: string | undefined,
  context: DoctorContext,
  signal: AbortSignal,
): Promise<Check> => {
  if (context.managed[component] === "disabled") {
    return skipped(
      component,
      `${component.toUpperCase()}_DISABLED`,
      `${component} is disabled.`,
    );
  }
  if (!endpoint) {
    return unhealthy(
      component,
      `${component.toUpperCase()}_ENDPOINT_UNAVAILABLE`,
      `${component} endpoint is unavailable.`,
    );
  }
  try {
    const url =
      component === "searxng"
        ? new URL(
            `/search?q=argus&format=json`,
            endpoint,
          )
        : new URL(endpoint);
    const response = await (context.fetcher ?? fetch)(url, {
      ...(component === "searxng"
        ? { headers: { accept: "application/json" } }
        : {}),
      signal,
    });
    if (component === "searxng") {
      const body = (await response.json()) as { results?: unknown };
      return response.ok && Array.isArray(body.results)
        ? healthy(
            component,
            "SEARXNG_HEALTHY",
            "SearXNG is serving JSON search results.",
          )
        : unhealthy(
            component,
            "SEARXNG_HEALTHCHECK_FAILED",
            "SearXNG did not return a valid JSON search response.",
          );
    }
    return response.ok
      ? healthy(component, "FXEMBED_HEALTHY", "FxEmbed endpoint is reachable.")
      : unhealthy(
          component,
          "FXEMBED_HEALTHCHECK_FAILED",
          "FxEmbed endpoint did not accept a health request.",
        );
  } catch {
    return unhealthy(
      component,
      `${component.toUpperCase()}_HEALTHCHECK_FAILED`,
      `${component === "searxng" ? "SearXNG did not return a valid JSON search response." : "FxEmbed endpoint did not accept a health request."}`,
    );
  }
};

/** Runs independent, abortable, secret-safe service and source diagnostics. */
export const runDoctor = async (
  context: DoctorContext,
): Promise<DiagnosticReport> => {
  const smokeDeadline = bounded(context.smokeDeadlineMs, 10_000, 30_000);
  const cleanupGrace = bounded(context.cleanupGraceMs, 2_000, 10_000);
  const perCheck = Math.max(
    bounded(context.checkTimeoutMs, 5_000, 30_000),
    smokeDeadline + cleanupGrace,
  );
  const aggregate = bounded(context.aggregateTimeoutMs, 15_000, 60_000);
  const aggregateDeadline = timeoutSignal(aggregate);

  const checks: Array<
    [Component, (signal: AbortSignal) => Promise<Check>]
  > = [
    [
      "docker",
      async () => {
        try {
          const result = await context.executor.run("docker", ["info"], {
            timeoutMs: perCheck,
          });
          return result.exitCode === 0 && !result.timedOut
            ? healthy(
                "docker",
                "DOCKER_HEALTHY",
                "Docker is available to the Argus management container.",
              )
            : unhealthy(
                "docker",
                "DOCKER_UNAVAILABLE",
                "Docker is not available to the Argus management container.",
              );
        } catch {
          return unhealthy(
            "docker",
            "DOCKER_UNAVAILABLE",
            "Docker is not available to the Argus management container.",
          );
        }
      },
    ],
    [
      "argus",
      async (signal) => {
        try {
          return (await context.api.health(signal))
            ? healthy("argus", "ARGUS_HEALTHY", "Argus API is healthy.")
            : unhealthy(
                "argus",
                "ARGUS_HEALTHCHECK_FAILED",
                "Argus API did not report healthy.",
              );
        } catch {
          return unhealthy(
            "argus",
            "ARGUS_HEALTHCHECK_FAILED",
            "Argus API did not report healthy.",
          );
        }
      },
    ],
    [
      "storage",
      async () => {
        try {
          const args =
            context.storage === "postgres"
              ? [
                  "compose",
                  "-p",
                  "argus",
                  "exec",
                  "-T",
                  "postgres",
                  "psql",
                  "-U",
                  "argus",
                  "-d",
                  "argus",
                  "-v",
                  "ON_ERROR_STOP=1",
                  "-tAc",
                  "SELECT 1",
                ]
              : [
                  "compose",
                  "-p",
                  "argus",
                  "exec",
                  "-T",
                  "argus",
                  "node",
                  "--input-type=module",
                  "-e",
                  "import Database from 'better-sqlite3';const db=new Database('/app/data/argus.db');const row=db.pragma('quick_check',{simple:true});db.close();if(row!=='ok')process.exit(1)",
                ];
          const result = await context.executor.run("docker", args, {
            cwd: context.root,
            timeoutMs: perCheck,
          });
          return result.exitCode === 0 && !result.timedOut
            ? healthy(
                "storage",
                context.storage === "postgres"
                  ? "POSTGRES_HEALTHY"
                  : "SQLITE_HEALTHY",
                `${context.storage === "postgres" ? "PostgreSQL" : "SQLite"} storage is reachable.`,
              )
            : unhealthy(
                "storage",
                "STORAGE_HEALTHCHECK_FAILED",
                "Configured storage did not pass its bounded health check.",
              );
        } catch {
          return unhealthy(
            "storage",
            "STORAGE_HEALTHCHECK_FAILED",
            "Configured storage did not pass its bounded health check.",
          );
        }
      },
    ],
    [
      "searxng",
      (signal) =>
        endpointCheck("searxng", context.searxngEndpoint, context, signal),
    ],
    [
      "fxembed",
      (signal) =>
        endpointCheck("fxembed", context.fxembedEndpoint, context, signal),
    ],
    [
      "telegram",
      (signal) => smokeCheck("telegram", context, signal),
    ],
    ["web", (signal) => smokeCheck("web", context, signal)],
    ["x", (signal) => smokeCheck("x", context, signal)],
  ];

  const settled = await Promise.all(
    checks.map(async ([component, check]) => {
      const deadline = timeoutSignal(perCheck, aggregateDeadline.signal);
      try {
        return { component, result: await check(deadline.signal) };
      } catch {
        return {
          component,
          result: unhealthy(
            component,
            deadline.signal.aborted
              ? "DIAGNOSTIC_TIMEOUT"
              : "DIAGNOSTIC_FAILED",
            deadline.signal.aborted
              ? "Diagnostic check timed out."
              : "Diagnostic check failed.",
          ),
        };
      } finally {
        deadline.cancel();
      }
    }),
  );
  aggregateDeadline.cancel();
  const resolved = new Map(
    settled.map(({ component, result }) => [component, result]),
  );
  const reportChecks = checks.map(
    ([component]) =>
      resolved.get(component) ??
      unhealthy(
        component,
        "DIAGNOSTIC_FAILED",
        "Diagnostic check failed.",
      ),
  );
  return {
    contractVersion: 1,
    healthy: reportChecks.every((check) => check.status !== "unhealthy"),
    checks: reportChecks,
  };
};

const parseComposeServiceRecords = (
  stdout: string,
): Array<Record<string, unknown>> => {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (Array.isArray(value)) {
      return value.filter(
        (record): record is Record<string, unknown> =>
          !!record && typeof record === "object" && !Array.isArray(record),
      );
    }
    if (value && typeof value === "object") {
      return [value as Record<string, unknown>];
    }
  } catch {
    return trimmed.split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }
  return [];
};

const serviceRecordHealthy = (
  record: Record<string, unknown>,
  service: string,
): boolean => {
  const name =
    typeof record.Service === "string"
      ? record.Service
      : typeof record.service === "string"
        ? record.service
        : undefined;
  const state =
    typeof record.State === "string"
      ? record.State
      : typeof record.state === "string"
        ? record.state
        : undefined;
  const health =
    typeof record.Health === "string"
      ? record.Health
      : typeof record.health === "string"
        ? record.health
        : undefined;
  return (
    name === service &&
    state?.toLowerCase() === "running" &&
    health?.toLowerCase() === "healthy"
  );
};

/** Performs only verified, targeted managed repairs; it never changes user configuration. */
export const repairService = async (
  service: "argus" | "postgres" | "searxng",
  context: DoctorContext,
): Promise<DiagnosticReport> => {
  if (service === "searxng") {
    if (context.managed.searxng !== "managed") {
      return {
        contractVersion: 1,
        healthy: false,
        checks: [
          skipped(
            "searxng",
            "SEARXNG_NOT_MANAGED",
            "SearXNG is not managed by Argus.",
          ),
        ],
      };
    }
    return repairSearxng({
      root: context.root,
      executor: context.executor,
      ...(context.searxngEndpoint === undefined
        ? {}
        : { endpoint: context.searxngEndpoint }),
      ...(context.fetcher === undefined ? {} : { fetcher: context.fetcher }),
      ...(context.checkTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: context.checkTimeoutMs }),
    });
  }
  if (service === "postgres" && context.storage !== "postgres") {
    return {
      contractVersion: 1,
      healthy: false,
      checks: [
        skipped(
          "postgres",
          "POSTGRES_NOT_SELECTED",
          "PostgreSQL is not selected for this deployment.",
        ),
      ],
    };
  }
  try {
    const environment = await loadPersistedComposeEnvironment({
      root: context.root,
      executor: context.executor,
    });
    const timeoutMs = bounded(context.checkTimeoutMs, 10_000, 30_000);
    const restarted = await context.executor.run(
      "docker",
      ["compose", "-p", "argus", "restart", service],
      { cwd: context.root, env: environment, timeoutMs },
    );
    if (restarted.exitCode !== 0 || restarted.timedOut) {
      return {
        contractVersion: 1,
        healthy: false,
        checks: [
          unhealthy(
            service,
            "REPAIR_FAILED",
            `${service} targeted repair failed.`,
          ),
        ],
      };
    }
    const verified = await context.executor.run(
      "docker",
      ["compose", "-p", "argus", "ps", "--format", "json"],
      { cwd: context.root, env: environment, timeoutMs },
    );
    const running =
      verified.exitCode === 0 &&
      !verified.timedOut &&
      parseComposeServiceRecords(verified.stdout).some((record) =>
        serviceRecordHealthy(record, service),
      );
    return {
      contractVersion: 1,
      healthy: running,
      checks: [
        running
          ? healthy(
              service,
              "REPAIR_HEALTHY",
              `${service} is running and healthy after targeted repair.`,
            )
          : unhealthy(
              service,
              "REPAIR_VERIFY_FAILED",
              `${service} could not be verified after targeted repair.`,
            ),
      ],
    };
  } catch {
    return {
      contractVersion: 1,
      healthy: false,
      checks: [
        unhealthy(
          service,
          "REPAIR_FAILED",
          `${service} targeted repair failed.`,
        ),
      ],
    };
  }
};
