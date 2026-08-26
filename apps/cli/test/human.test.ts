import { describe, expect, it } from "vitest";
import {
  renderHumanConfig,
  renderHumanDoctor,
  renderHumanLogs,
  renderHumanPlan,
  renderHumanStatus,
  humanServiceStates,
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

  it("falls back to the runtime state without changing enumerable JSON data", () => {
    const status = {
      state: "running",
      services: { argus: "healthy", searxng: "" },
    };
    Object.defineProperty(status, humanServiceStates, {
      value: { argus: "running", searxng: "running" },
    });

    expect(renderHumanStatus(status)).toContain("searxng: running");
    expect(JSON.stringify(status)).toBe(
      '{"state":"running","services":{"argus":"healthy","searxng":""}}',
    );
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

  it("preserves service attribution across multiline non-JSON output", () => {
    expect(
      renderHumanLogs(
        "searxng-1 | Traceback (most recent call last):\n  File \"search.py\", line 7\nargus-1 | worker recovered",
      ),
    ).toBe(
      '--:--:--  searxng  LOG   Traceback (most recent call last):\n--:--:--  searxng  LOG     File "search.py", line 7\n--:--:--  argus    LOG   worker recovered',
    );
  });

  it.each([
    [10, "TRACE"],
    [20, "DEBUG"],
    [30, "INFO"],
    [40, "WARN"],
    [50, "ERROR"],
    [60, "FATAL"],
  ])("maps Pino level %s to %s", (level, label) => {
    expect(
      renderHumanLogs(`argus-1 | {"level":${level},"msg":"event"}`),
    ).toMatch(new RegExp(`\\s${label}\\s+event$`, "u"));
  });

  it("keeps malformed JSON readable", () => {
    expect(renderHumanLogs('argus-1 | {"level":30')).toBe(
      '--:--:--  argus    LOG   {"level":30',
    );
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

  it("summarizes configuration, onboarding, and rollback plan shapes", () => {
    expect(
      renderHumanPlan({
        operations: [
          { resource: "applied-config", action: "update", toContentHash: "private" },
        ],
      }),
    ).toBe("Plan:\n  - update applied-config");
    expect(renderHumanPlan({ operations: [] })).toBe("Nothing to change.");
    expect(
      renderHumanPlan({
        release: { manifest: "private" },
        plan: {
          deployment: {
            changes: [
              { component: "argus", action: "create", summary: "Create Argus" },
            ],
          },
        },
      }),
    ).toBe("Plan:\n  - Create Argus");
    expect(renderHumanPlan({ snapshot: { release: { manifest: "private" } } })).toBe(
      "Plan:\n  - Restore the verified rollback snapshot",
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
