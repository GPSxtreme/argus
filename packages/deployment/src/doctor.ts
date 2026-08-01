import type { DiagnosticReport } from "./contracts.js";
import type { CommandExecutor } from "./executor.js";
import { loadPersistedComposeEnvironment } from "./reconciler.js";
import { checkSearxngHealth, repairSearxng, type SearxngFetcher } from "./searxng.js";

type Component = "docker" | "argus" | "postgres" | "storage" | "searxng" | "fxembed" | "telegram" | "web" | "x";
type Source = "telegram" | "web" | "x";
type Check = DiagnosticReport["checks"][number];

export interface DoctorArgusApi {
  health(): Promise<boolean>;
  createSmokeWatch(input: { source: Source }): Promise<{ id: string; targetId: string; expectedUrl: string }>;
  pollRecords(input: { targetId: string }): Promise<Array<{ url: string }>>;
  removeSmokeWatch(input: { id: string }): Promise<void>;
}

export interface ArgusDoctorApiOptions {
  endpoint: string;
  token: string;
  fetcher?: SearxngFetcher;
  requestTimeoutMs?: number;
}

/**
 * Authenticated, response-body-minimising client for the temporary-watch API.
 * The server owns the temporary watch lifecycle; Doctor never modifies a user watch.
 */
export const createArgusDoctorApi = ({ endpoint, token, fetcher = fetch, requestTimeoutMs }: ArgusDoctorApiOptions): DoctorArgusApi => {
  const base = endpoint.replace(/\/+$/, "");
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      const response = await fetcher(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init?.headers).entries()) },
        signal: AbortSignal.timeout(bounded(requestTimeoutMs, 5_000, 10_000)),
      });
      if (!response.ok) throw new Error("request failed");
      return response;
    } catch { throw new Error("Argus diagnostic API request failed."); }
  };
  return {
    async health() {
      try { return (await fetcher(`${base}/health`, { signal: AbortSignal.timeout(bounded(requestTimeoutMs, 5_000, 10_000)) })).ok; }
      catch { return false; }
    },
    async createSmokeWatch({ source }) {
      const payload = await (await request("/v1/diagnostics/smoke-watches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) })).json() as unknown;
      if (!payload || typeof payload !== "object") throw new Error("Argus diagnostic API request failed.");
      const value = payload as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.targetId !== "string" || typeof value.expectedUrl !== "string") throw new Error("Argus diagnostic API request failed.");
      return { id: value.id, targetId: value.targetId, expectedUrl: value.expectedUrl };
    },
    async pollRecords({ targetId }) {
      const payload = await (await request(`/v1/records?target=${encodeURIComponent(targetId)}&limit=50`)).json() as unknown;
      const records = payload && typeof payload === "object" ? (payload as { items?: unknown }).items : undefined;
      return Array.isArray(records) ? records.flatMap((record) => record && typeof record === "object" && typeof (record as { url?: unknown }).url === "string" ? [{ url: (record as { url: string }).url }] : []) : [];
    },
    async removeSmokeWatch({ id }) { await request(`/v1/diagnostics/smoke-watches/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  };
};

export interface DoctorContext {
  root: string;
  executor: CommandExecutor;
  api: DoctorArgusApi;
  storage: "sqlite" | "postgres";
  managed: { searxng: "disabled" | "managed" | "external"; fxembed: "disabled" | "managed" | "external" };
  sources: Partial<Record<Source, boolean>>;
  searxngEndpoint?: string;
  fxembedEndpoint?: string;
  fetcher?: SearxngFetcher;
  checkTimeoutMs?: number;
  aggregateTimeoutMs?: number;
  smokeDeadlineMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
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
  docker: "Verify Docker is running, then run argus repair argus.",
  argus: "Run argus repair argus.",
  postgres: "Run argus repair postgres.",
  storage: "Run argus repair postgres.",
  searxng: "Run argus repair searxng.",
  fxembed: "Run argus repair fxembed.",
  telegram: "Verify the Telegram source configuration, then run argus repair telegram.",
  web: "Verify the Web source configuration, then run argus repair web.",
  x: "Verify the X source configuration, then run argus repair x.",
};

const healthy = (component: Component, code: string, message: string): Check => ({ component, status: "healthy", code, message });
const skipped = (component: Component, code: string, message: string): Check => ({ component, status: "skipped", code, message });
const unhealthy = (component: Component, code: string, message: string, overrideRecovery?: string): Check => ({
  component, status: "unhealthy", code, message, recovery: overrideRecovery ?? recovery[component], logsCommand: logs[component],
});

const bounded = (value: number | undefined, fallback: number, maximum: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(Math.max(1, value), maximum);

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const canonicalUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch { return undefined; }
};

const smokeCheck = async (source: Source, context: DoctorContext): Promise<Check> => {
  if (!context.sources[source]) return skipped(source, "SOURCE_DISABLED", `${source} source is disabled.`);
  let smoke: { id: string; targetId: string; expectedUrl: string } | undefined;
  let outcome: Check | undefined;
  try {
    smoke = await context.api.createSmokeWatch({ source });
    const expected = canonicalUrl(smoke.expectedUrl);
    if (!expected) outcome = unhealthy(source, "SOURCE_SMOKE_INVALID_TARGET", "The diagnostic source target URL is invalid.");
    else {
    const deadline = Date.now() + bounded(context.smokeDeadlineMs, 10_000, 30_000);
    while (Date.now() <= deadline) {
      const records = await context.api.pollRecords({ targetId: smoke.targetId });
      if (records.some((record) => canonicalUrl(record.url) === expected)) {
        outcome = healthy(source, "SOURCE_SMOKE_HEALTHY", `${source} source ingested its dedicated diagnostic target.`);
        break;
      }
      await (context.sleep ?? wait)(Math.min(bounded(context.pollIntervalMs, 200, 1_000), Math.max(1, deadline - Date.now())));
    }
    outcome ??= unhealthy(source, "SOURCE_SMOKE_TIMEOUT", `${source} source did not ingest its dedicated diagnostic target before the deadline.`);
    }
  } catch {
    outcome = unhealthy(source, "SOURCE_SMOKE_FAILED", `${source} source diagnostic request failed.`);
  }
  if (smoke === undefined) return outcome ?? unhealthy(source, "SOURCE_SMOKE_FAILED", `${source} source diagnostic request failed.`);
  try { await context.api.removeSmokeWatch({ id: smoke.id }); }
  catch { return unhealthy(source, "SOURCE_SMOKE_CLEANUP_FAILED", "The dedicated diagnostic watch could not be removed.", `Run argus repair ${source} to remove the dedicated diagnostic watch.`); }
  return outcome ?? unhealthy(source, "SOURCE_SMOKE_FAILED", `${source} source diagnostic request failed.`);
};

const endpointCheck = async (component: "searxng" | "fxembed", endpoint: string | undefined, context: DoctorContext): Promise<Check> => {
  if (context.managed[component] === "disabled") return skipped(component, `${component.toUpperCase()}_DISABLED`, `${component} is disabled.`);
  if (!endpoint) return unhealthy(component, `${component.toUpperCase()}_ENDPOINT_UNAVAILABLE`, `${component} endpoint is unavailable.`);
  if (component === "searxng") {
    const result = await checkSearxngHealth(endpoint, context.fetcher, context.checkTimeoutMs === undefined ? {} : { requestTimeoutMs: context.checkTimeoutMs });
    return result.healthy ? healthy(component, "SEARXNG_HEALTHY", "SearXNG is serving JSON search results.") : unhealthy(component, "SEARXNG_HEALTHCHECK_FAILED", "SearXNG did not return a valid JSON search response.");
  }
  try {
    const response = await (context.fetcher ?? fetch)(endpoint, { signal: AbortSignal.timeout(bounded(context.checkTimeoutMs, 5_000, 10_000)) });
    return response.ok ? healthy(component, "FXEMBED_HEALTHY", "FxEmbed endpoint is reachable.") : unhealthy(component, "FXEMBED_HEALTHCHECK_FAILED", "FxEmbed endpoint did not accept a health request.");
  } catch { return unhealthy(component, "FXEMBED_HEALTHCHECK_FAILED", "FxEmbed endpoint did not accept a health request."); }
};

/** Runs independent, bounded, secret-safe service and source diagnostics. */
export const runDoctor = async (context: DoctorContext): Promise<DiagnosticReport> => {
  const perCheck = bounded(context.checkTimeoutMs, 5_000, 10_000);
  const aggregate = bounded(context.aggregateTimeoutMs, 15_000, 30_000);
  const checks: Array<[Component, () => Promise<Check>]> = [
    ["docker", async () => {
      try { const result = await context.executor.run("docker", ["info"], { timeoutMs: perCheck }); return result.exitCode === 0 && !result.timedOut ? healthy("docker", "DOCKER_HEALTHY", "Docker is available to the Argus management container.") : unhealthy("docker", "DOCKER_UNAVAILABLE", "Docker is not available to the Argus management container."); } catch { return unhealthy("docker", "DOCKER_UNAVAILABLE", "Docker is not available to the Argus management container."); }
    }],
    ["argus", async () => { try { return await context.api.health() ? healthy("argus", "ARGUS_HEALTHY", "Argus API is healthy.") : unhealthy("argus", "ARGUS_HEALTHCHECK_FAILED", "Argus API did not report healthy."); } catch { return unhealthy("argus", "ARGUS_HEALTHCHECK_FAILED", "Argus API did not report healthy."); } }],
    ["storage", async () => context.storage === "sqlite" ? healthy("storage", "SQLITE_HEALTHY", "SQLite storage is managed with Argus.") : healthy("storage", "POSTGRES_HEALTHY", "PostgreSQL storage is selected.")],
    ["searxng", () => endpointCheck("searxng", context.searxngEndpoint, context)],
    ["fxembed", () => endpointCheck("fxembed", context.fxembedEndpoint, context)],
    ["telegram", () => smokeCheck("telegram", context)], ["web", () => smokeCheck("web", context)], ["x", () => smokeCheck("x", context)],
  ];
  const timed = await withTimeout(Promise.all(checks.map(async ([component, check]) => ({ component, result: await withTimeout(check(), perCheck) }))), aggregate);
  const resolved = new Map(timed?.map(({ component, result }) => [component, result ?? unhealthy(component, "DIAGNOSTIC_TIMEOUT", "Diagnostic check timed out.")]) ?? []);
  const reportChecks = checks.map(([component]) => resolved.get(component) ?? unhealthy(component, "DIAGNOSTIC_AGGREGATE_TIMEOUT", "Diagnostic run reached its aggregate deadline."));
  return { contractVersion: 1, healthy: reportChecks.every((check) => check.status !== "unhealthy"), checks: reportChecks };
};

/** Performs only verified, targeted managed repairs; it never changes user configuration. */
export const repairService = async (service: "argus" | "postgres" | "searxng", context: DoctorContext): Promise<DiagnosticReport> => {
  if (service === "searxng") {
    if (context.managed.searxng !== "managed") return { contractVersion: 1, healthy: false, checks: [skipped("searxng", "SEARXNG_NOT_MANAGED", "SearXNG is not managed by Argus.")] };
    return repairSearxng({ root: context.root, executor: context.executor, ...(context.searxngEndpoint === undefined ? {} : { endpoint: context.searxngEndpoint }), ...(context.fetcher === undefined ? {} : { fetcher: context.fetcher }), ...(context.checkTimeoutMs === undefined ? {} : { requestTimeoutMs: context.checkTimeoutMs }) });
  }
  if (service === "postgres" && context.storage !== "postgres") {
    return { contractVersion: 1, healthy: false, checks: [skipped("postgres", "POSTGRES_NOT_SELECTED", "PostgreSQL is not selected for this deployment.")] };
  }
  try {
    const environment = await loadPersistedComposeEnvironment({ root: context.root, executor: context.executor });
    const restarted = await context.executor.run("docker", ["compose", "-p", "argus", "restart", service], { cwd: context.root, env: environment, timeoutMs: bounded(context.checkTimeoutMs, 10_000, 30_000) });
    if (restarted.exitCode !== 0 || restarted.timedOut) throw new Error("failed");
    const verified = await context.executor.run("docker", ["compose", "-p", "argus", "ps", "--format", "json"], { cwd: context.root, env: environment, timeoutMs: bounded(context.checkTimeoutMs, 10_000, 30_000) });
    const running = verified.exitCode === 0 && !verified.timedOut && verified.stdout.includes(`"${service}"`) && verified.stdout.includes("running");
    return { contractVersion: 1, healthy: running, checks: [running ? healthy(service, "REPAIR_HEALTHY", `${service} is running after targeted repair.`) : unhealthy(service, "REPAIR_VERIFY_FAILED", `${service} could not be verified after targeted repair.`)] };
  } catch { return { contractVersion: 1, healthy: false, checks: [unhealthy(service, "REPAIR_FAILED", `${service} targeted repair failed.`)] }; }
};
