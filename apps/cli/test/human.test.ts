import { describe, expect, it } from "vitest";
import {
  renderHumanConfig,
  renderHumanDoctor,
  renderHumanLogs,
  renderHumanPlan,
  renderHumanStatus,
} from "../src/human.js";

describe("human CLI renderers", () => {
  it("never prints a blank service state", () => {
    expect(
      renderHumanStatus({
        state: "running",
        services: { argus: "healthy", searxng: "" },
      }),
    ).toBe("Argus: running\nargus: healthy\nsearxng: unknown");
  });

  it("turns Pino compose logs into readable event lines", () => {
    const raw =
      'argus-1  | {"level":30,"time":1787743134312,"pid":7,"hostname":"container","name":"argus","jobId":"private","targetId":"screen-news:web:query:movies","inserted":7,"revised":0,"duplicates":19,"msg":"job complete"}';

    expect(renderHumanLogs(raw)).toBe(
      "11:18:54  argus    INFO  job complete  source=web target=screen-news:web:query:movies inserted=7 revised=0 duplicates=19",
    );
  });

  it("keeps non-JSON service output readable and attributable", () => {
    expect(
      renderHumanLogs("searxng-1  | Too many requests from upstream"),
    ).toBe("--:--:--  searxng  LOG   Too many requests from upstream");
  });

  it("shows retry context without leaking noisy runtime fields", () => {
    const raw =
      'argus-1 | {"level":40,"time":1787743134312,"pid":7,"hostname":"container","name":"argus","targetId":"news:x:account:FilmUpdates","attempt":2,"maxAttempts":4,"retryAt":"2026-08-26T11:20:00.000Z","msg":"source fetch failed; retry scheduled"}';
    const rendered = renderHumanLogs(raw);

    expect(rendered).toContain("WARN  source fetch failed; retry scheduled");
    expect(rendered).toContain("source=x");
    expect(rendered).toContain("attempt=2/4");
    expect(rendered).toContain("retryAt=2026-08-26T11:20:00.000Z");
    expect(rendered).not.toContain("hostname");
    expect(rendered).not.toContain("pid=");
  });

  it("renders redacted configuration as YAML", () => {
    expect(
      renderHumanConfig({
        database: { provider: "sqlite" },
        telegram: { token: "[REDACTED]" },
      }),
    ).toBe(
      'database:\n  provider: sqlite\ntelegram:\n  token: "[REDACTED]"',
    );
  });

  it("summarizes no-op and changed plans", () => {
    expect(
      renderHumanPlan({
        currentVersion: "v0.1.22",
        targetVersion: "v0.1.22",
        noop: true,
        internalState: { rollback: "noise" },
      }),
    ).toBe("Already up to date (v0.1.22).");

    expect(
      renderHumanPlan({
        currentVersion: "v0.1.22",
        targetVersion: "v0.1.23",
        changes: [
          { component: "argus", action: "update", summary: "Update Argus" },
          { component: "searxng", action: "restart", summary: "Restart SearXNG" },
        ],
        internalState: { rollback: "noise" },
      }),
    ).toBe(
      "Plan:\n  v0.1.22 -> v0.1.23\n  - Update Argus\n  - Restart SearXNG",
    );
  });

  it("makes diagnostic recovery steps easy to scan", () => {
    expect(
      renderHumanDoctor({
        contractVersion: 1,
        healthy: false,
        checks: [
          {
            component: "argus",
            status: "unhealthy",
            code: "SERVICE_DOWN",
            message: "The worker is not running.",
            recovery: "Run 'argus repair argus'.",
          },
        ],
      }),
    ).toBe(
      "Argus diagnostics: unhealthy\nargus: unhealthy — The worker is not running.\n  Try: Run 'argus repair argus'.",
    );
  });
});
