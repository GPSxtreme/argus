import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DiagnosticReport } from "./contracts.js";
import type { CommandExecutor } from "./executor.js";

const managedSettings = `# Argus managed SearXNG settings v1
use_default_settings: true
general:
  instance_name: Argus
search:
  formats: [html, json]
server:
  bind_address: 0.0.0.0
  port: 8080
  limiter: true
`;

const searchPath = (endpoint: string): URL => {
  const url = new URL("/search", endpoint);
  url.searchParams.set("q", "argus");
  url.searchParams.set("format", "json");
  return url;
};

const unhealthyHealth = (): SearxngHealth => ({ healthy: false, resultCount: 0 });

export interface SearxngHealth {
  healthy: boolean;
  resultCount: number;
}

export type SearxngFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SearxngRepairContext {
  root: string;
  executor: CommandExecutor;
  endpoint?: string;
  fetcher?: SearxngFetcher;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}

/** Renders the complete, versioned settings file owned by Argus. */
export const renderSearxngSettings = (): string => managedSettings;

/** Checks a JSON search without returning endpoint response data to callers. */
export const checkSearxngHealth = async (
  endpoint: string,
  fetcher: SearxngFetcher = fetch,
): Promise<SearxngHealth> => {
  try {
    const response = await fetcher(searchPath(endpoint), { headers: { accept: "application/json" } });
    if (!response.ok) return unhealthyHealth();
    const body = (await response.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) return unhealthyHealth();
    return { healthy: true, resultCount: body.results.length };
  } catch {
    return unhealthyHealth();
  }
};

const writeManagedSettings = async (root: string): Promise<void> => {
  const path = join(root, "searxng", "settings.yml");
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(temporary, "w", 0o644);
    try {
      await handle.writeFile(renderSearxngSettings(), "utf8");
      await handle.chmod(0o644);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const diagnostic = (
  healthy: boolean,
  code: string,
  message: string,
): DiagnosticReport => ({
  contractVersion: 1,
  healthy,
  checks: [
    {
      component: "searxng",
      status: healthy ? "healthy" : "unhealthy",
      code,
      message,
      ...(healthy
        ? {}
        : {
            recovery: "argus repair searxng",
            logsCommand: "docker compose -p argus logs searxng",
          }),
    },
  ],
});

/** Rewrites managed settings, recreates SearXNG, then polls JSON search a bounded number of times. */
export const repairSearxng = async ({
  root,
  executor,
  endpoint = "http://searxng:8080",
  fetcher = fetch,
  sleep = wait,
  attempts = 3,
}: SearxngRepairContext): Promise<DiagnosticReport> => {
  try {
    await writeManagedSettings(root);
  } catch {
    return diagnostic(false, "SEARXNG_SETTINGS_WRITE_FAILED", "Managed SearXNG settings could not be written.");
  }

  try {
    const recreated = await executor.run(
      "docker",
      ["compose", "-p", "argus", "up", "-d", "--force-recreate", "searxng"],
      { cwd: root },
    );
    if (recreated.exitCode === 0) {
      return await waitForSearxng(endpoint, fetcher, sleep, attempts);
    }
  } catch {
    // Command output and errors may contain credentials; report only the stable diagnostic below.
  }
  return diagnostic(false, "SEARXNG_RECREATE_FAILED", "Managed SearXNG could not be recreated.");
};

const waitForSearxng = async (
  endpoint: string,
  fetcher: SearxngFetcher,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<DiagnosticReport> => {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    if (attempt > 0) await sleep(100 * 2 ** (attempt - 1));
    if ((await checkSearxngHealth(endpoint, fetcher)).healthy) {
      return diagnostic(true, "SEARXNG_HEALTHY", "Managed SearXNG is serving JSON search results.");
    }
  }
  return diagnostic(false, "SEARXNG_HEALTHCHECK_FAILED", "Managed SearXNG did not become healthy.");
};
