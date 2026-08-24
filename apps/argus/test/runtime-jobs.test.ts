import { validateConfig } from "@argus/config";
import { SAFE_HTTP_MAX_TIMEOUT_MS } from "@argus/source-web";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { describe, expect, it } from "vitest";
import { JOB_LEASE_MS, processNextJob } from "../src/runtime.js";

const config = validateConfig({ version: 1, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [{ id: "watch", schedule: "* * * * *", inputs: { web: { urls: ["https://example.com"] } } }] });

const captureJobLogs = () => {
  const entries: Array<{
    level: "info" | "warn" | "error";
    bindings: Record<string, unknown>;
    message: string;
  }> = [];
  return {
    entries,
    logger: {
      info: (bindings: Record<string, unknown>, message: string) =>
        entries.push({ level: "info", bindings, message }),
      warn: (bindings: Record<string, unknown>, message: string) =>
        entries.push({ level: "warn", bindings, message }),
      error: (bindings: Record<string, unknown>, message: string) =>
        entries.push({ level: "error", bindings, message }),
    },
  };
};

describe("processNextJob", () => {
  it("keeps the job lease safely beyond the maximum web request deadline", () => {
    expect(JOB_LEASE_MS).toBeGreaterThan(SAFE_HTTP_MAX_TIMEOUT_MS * 2);
  });
  it("returns idle when no job exists", async () => {
    const repo = await createSqliteRepository({ filename: ":memory:" });
    expect(await processNextJob(config, repo)).toEqual({ status: "idle" });
    repo.close();
  });
  it("processes an active diagnostic job with its injected runner", async () => {
    const repo = await createSqliteRepository({ filename: ":memory:" });
    const now = new Date().toISOString();
    await repo.createDiagnosticWatch({ id: "d", targetId: "__argus_doctor:d", source: "web", target: { kind: "url", value: "https://example.com", watchId: "d", keywords: [] }, status: "active", createdAt: now, updatedAt: now, job: { id: "j", targetId: "__argus_doctor:d", source: "web", status: "queued", attempt: 0, runAt: now } });
    let calls = 0;
    expect(await processNextJob(config, repo, { runTarget: async () => { calls += 1; return { inserted: 0, revised: 0, duplicates: 0 }; } })).toEqual({ status: "complete" });
    expect(calls).toBe(1);
    repo.close();
  });
  it("settles a cancelled diagnostic job without invoking the runner", async () => {
    const repo = await createSqliteRepository({ filename: ":memory:" });
    const now = new Date().toISOString();
    await repo.createDiagnosticWatch({ id: "d", targetId: "__argus_doctor:d", source: "web", target: { kind: "url", value: "https://example.com", watchId: "d", keywords: [] }, status: "active", createdAt: now, updatedAt: now, job: { id: "j", targetId: "__argus_doctor:d", source: "web", status: "queued", attempt: 0, runAt: now } });
    await repo.cancelDiagnosticWatch("__argus_doctor:d");
    expect(await processNextJob(config, repo, { runTarget: async () => { throw new Error("must not run"); } })).toEqual({ status: "idle" });
    repo.close();
  });

  it("warns when a failed job is scheduled for retry", async () => {
    const repo = await createSqliteRepository({ filename: ":memory:" });
    await repo.enqueueJob({
      id: "retry-job",
      targetId: "watch:web:url:https%3A%2F%2Fexample.com",
      source: "web",
      status: "queued",
      attempt: 0,
      runAt: new Date().toISOString(),
    });
    const captured = captureJobLogs();

    expect(
      await processNextJob(config, repo, {
        logger: captured.logger,
        runTarget: async () => {
          throw new Error("temporary outage");
        },
      }),
    ).toEqual({ status: "failed" });
    expect(captured.entries).toEqual([
      {
        level: "warn",
        bindings: {
          jobId: "retry-job",
          targetId: "watch:web:url:https%3A%2F%2Fexample.com",
          source: "web",
          attempt: 1,
          maxAttempts: 6,
          retryAt: expect.any(String),
          error: "temporary outage",
        },
        message: "job retry scheduled",
      },
    ]);
    repo.close();
  });

  it("logs an error only when the retry budget is exhausted", async () => {
    const repo = await createSqliteRepository({ filename: ":memory:" });
    await repo.enqueueJob({
      id: "terminal-job",
      targetId: "watch:web:url:https%3A%2F%2Fexample.com",
      source: "web",
      status: "queued",
      attempt: 5,
      runAt: new Date().toISOString(),
    });
    const captured = captureJobLogs();

    expect(
      await processNextJob(config, repo, {
        logger: captured.logger,
        runTarget: async () => {
          throw new Error("persistent outage");
        },
      }),
    ).toEqual({ status: "failed" });
    expect(captured.entries).toEqual([
      {
        level: "error",
        bindings: {
          jobId: "terminal-job",
          targetId: "watch:web:url:https%3A%2F%2Fexample.com",
          source: "web",
          attempt: 6,
          maxAttempts: 6,
          error: "persistent outage",
        },
        message: "job failed permanently",
      },
    ]);
    repo.close();
  });

  it("warns without claiming a retry when failure settlement loses its lease", async () => {
    const repo = await createSqliteRepository({ filename: ":memory:" });
    await repo.enqueueJob({
      id: "stale-job",
      targetId: "watch:web:url:https%3A%2F%2Fexample.com",
      source: "web",
      status: "queued",
      attempt: 0,
      runAt: new Date().toISOString(),
    });
    const captured = captureJobLogs();
    const expiringLeaseRepo = new Proxy(repo, {
      get(target, property, receiver) {
        if (property === "claimJobs") {
          return (owner: string, limit: number) =>
            target.claimJobs(owner, limit, 1);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(
      await processNextJob(config, expiringLeaseRepo, {
        logger: captured.logger,
        workerId: "stale-worker",
        runTarget: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(await repo.claimJobs("replacement-worker", 1, 30_000)).toHaveLength(1);
          throw new Error("stale worker failure");
        },
      }),
    ).toEqual({ status: "failed" });
    expect(captured.entries).toEqual([
      {
        level: "warn",
        bindings: {
          jobId: "stale-job",
          targetId: "watch:web:url:https%3A%2F%2Fexample.com",
          source: "web",
          attempt: 1,
          error: "stale worker failure",
        },
        message: "job failure settlement lost lease",
      },
    ]);
    repo.close();
  });
});
