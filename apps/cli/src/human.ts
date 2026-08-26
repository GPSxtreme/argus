import type { DiagnosticReport } from "@argus/deployment";
import { stringify } from "yaml";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

export const humanServiceStates = Symbol("argus.humanServiceStates");

export const renderHumanStatus = (status: unknown): string => {
  const value = record(status);
  if (!value) return "Argus status unavailable.";

  const lines = [`Argus: ${text(value.state) ?? "unknown"}`];
  const services = record(value.services);
  const serviceStates = record(
    (value as Record<PropertyKey, unknown>)[humanServiceStates],
  );
  if (services) {
    for (const [service, state] of Object.entries(services)) {
      lines.push(
        `${service}: ${text(state) ?? text(serviceStates?.[service]) ?? "unknown"}`,
      );
    }
  }
  return lines.join("\n");
};

const pinoLevels: Readonly<Record<number, string>> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

const logTime = (value: unknown): string => {
  const date =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string"
        ? new Date(value)
        : undefined;
  if (!date || Number.isNaN(date.getTime())) return "--:--:--";
  return date.toISOString().slice(11, 19);
};

const logLevel = (value: unknown): string => {
  if (typeof value === "number") return pinoLevels[value] ?? "LOG";
  return text(value)?.toUpperCase() ?? "LOG";
};

const logDetails = (value: Record<string, unknown>): string[] => {
  const target = text(value.targetId);
  const source = text(value.source) ?? target?.split(":")[1];
  const details: string[] = [];
  if (source) details.push(`source=${source}`);
  if (target) details.push(`target=${target}`);

  if (value.attempt !== undefined) {
    const maximum = value.maxAttempts;
    details.push(
      `attempt=${String(value.attempt)}${maximum === undefined ? "" : `/${String(maximum)}`}`,
    );
  }
  if (value.retryAt !== undefined) details.push(`retryAt=${String(value.retryAt)}`);

  for (const key of ["inserted", "revised", "duplicates"] as const) {
    if (value[key] !== undefined) details.push(`${key}=${String(value[key])}`);
  }
  return details;
};

const renderLogLine = (
  line: string,
  previousService: string,
): { rendered: string; service: string } => {
  const compose = line.match(/^(.+?)-\d+\s+\|\s?(.*)$/u);
  const service = text(compose?.[1]) ?? previousService;
  const content = compose?.[2] ?? line;

  try {
    const parsed = record(JSON.parse(content));
    if (parsed) {
      const message = text(parsed.msg) ?? text(parsed.message) ?? "event";
      const details = logDetails(parsed);
      return {
        rendered: `${logTime(parsed.time)}  ${service.padEnd(7)}  ${logLevel(parsed.level).padEnd(4)}  ${message}${details.length > 0 ? `  ${details.join(" ")}` : ""}`,
        service,
      };
    }
  } catch {
    // Service output is commonly plain text. It is still useful once its
    // Compose prefix is normalized.
  }

  return {
    rendered: `--:--:--  ${service.padEnd(7)}  LOG   ${content}`,
    service,
  };
};

export const renderHumanLogs = (raw: string): string => {
  let service = "argus";
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const result = renderLogLine(line, service);
      service = result.service;
      return result.rendered;
    })
    .join("\n");
};

export const renderHumanConfig = (value: unknown): string =>
  stringify(value).trimEnd();

export const renderHumanPlan = (plan: unknown): string => {
  const container = record(plan);
  if (!container) return "Plan unavailable.";
  const value = record(container.plan) ?? container;

  const current = text(value.currentVersion);
  const target = text(value.targetVersion);
  if (value.noop === true) {
    const version = target ?? current;
    return version ? `Already up to date (${version}).` : "Nothing to change.";
  }

  const deployment = record(value.deployment);
  const hasChangeCollection =
    Array.isArray(value.changes) ||
    Array.isArray(value.operations) ||
    Array.isArray(deployment?.changes);
  const changes = Array.isArray(value.changes)
    ? value.changes
    : Array.isArray(value.operations)
      ? value.operations
      : Array.isArray(deployment?.changes)
        ? deployment.changes
        : [];
  if (hasChangeCollection && changes.length === 0) return "Nothing to change.";

  const lines = ["Plan:"];
  if (current || target) {
    lines.push(`  ${current ?? "unknown"} -> ${target ?? "unknown"}`);
  }
  if (changes.length > 0) {
    for (const change of changes) {
      const item = record(change);
      if (!item) continue;
      const summary = text(item.summary);
      const fallback = [
        text(item.action),
        text(item.component) ?? text(item.resource),
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`  - ${(summary ?? fallback) || "Change deployment"}`);
    }
  } else if (value.snapshot !== undefined) {
    lines.push("  - Restore the verified rollback snapshot");
  } else if (text(value.action)) {
    lines.push(`  - ${text(value.action)}`);
  }
  if (lines.length === 1) lines.push("  - Apply configuration changes");
  return lines.join("\n");
};

export const renderHumanDoctor = (report: DiagnosticReport): string =>
  [
    `Argus diagnostics: ${report.healthy ? "healthy" : "unhealthy"}`,
    ...report.checks.map(
      (check) =>
        `${check.component}: ${check.status} — ${check.message}${
          check.recovery ? `\n  Try: ${check.recovery}` : ""
        }`,
    ),
  ].join("\n");
