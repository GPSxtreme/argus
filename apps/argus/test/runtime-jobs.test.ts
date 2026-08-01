import { validateConfig } from "@argus/config";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { describe, expect, it } from "vitest";
import { SAFE_HTTP_MAX_TIMEOUT_MS } from "@argus/source-web";
import { JOB_LEASE_MS, processNextJob } from "../src/runtime.js";

const config = validateConfig({ version: 1, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [{ id: "watch", schedule: "* * * * *", inputs: { web: { urls: ["https://example.com"] } } }] });

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
});
