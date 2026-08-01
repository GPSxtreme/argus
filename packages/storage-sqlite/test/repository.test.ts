import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordEnvelope } from "@argus/contracts";
import {
  createSqliteRepository,
  SqliteRepository,
} from "../src/index.js";
import { openSqlite } from "../src/db.js";

const repositories: SqliteRepository[] = [];
const temporaryDirectories: string[] = [];

const record = (hash: string, text = "Solana release"): RecordEnvelope => ({
  id: "x:target-1:post-9",
  source: "x",
  targetId: "target-1",
  externalId: "post-9",
  url: "https://x.com/argus/status/post-9",
  title: "Update",
  text,
  raw: { text },
  watchIds: ["markets"],
  contentHash: hash,
  ingestedAt: "2026-07-31T00:00:00.000Z",
});

const createRepo = async (): Promise<SqliteRepository> => {
  const repo = await createSqliteRepository({ filename: ":memory:" });
  repositories.push(repo);
  return repo;
};

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite repository", () => {
  it("creates a missing database parent directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-sqlite-"));
    temporaryDirectories.push(directory);
    const repo = await createSqliteRepository({
      filename: join(directory, "nested", "argus.db"),
    });
    repositories.push(repo);
    await expect(repo.queryRecords({})).resolves.toMatchObject({ items: [] });
  });

  it("adds diagnostic expiry to an existing database", () => {
    const directory = mkdtempSync(join(tmpdir(), "argus-sqlite-migration-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "argus.db");
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE diagnostic_watches (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        target_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO diagnostic_watches
        (id,target_id,source,target_json,status,created_at,updated_at)
      VALUES
        ('legacy','__argus_doctor:legacy','web','{}','active',
         '2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = openSqlite(filename);
    const row = migrated
      .prepare(
        "SELECT expires_at FROM diagnostic_watches WHERE id='legacy'",
      )
      .get() as { expires_at: string };
    expect(row.expires_at).toBe("2026-08-01T00:15:00.000Z");
    migrated.close();
  });

  it("deduplicates records and preserves revisions when content changes", async () => {
    const repo = await createRepo();
    const first = await repo.upsertRecord(record("a"));
    const duplicate = await repo.upsertRecord(record("a"));
    const edited = await repo.upsertRecord(record("b", "Solana security release"));

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.revision).toBeUndefined();
    expect(edited.revision?.contentHash).toBe("b");
    expect((await repo.listRevisions(first.record.id)).items).toHaveLength(2);
  });

  it("queries text and paginates deterministically", async () => {
    const repo = await createRepo();
    await repo.upsertRecord(record("a"));
    await repo.upsertRecord({
      ...record("b", "Ethereum roadmap"),
      id: "web:target-2:page-2",
      source: "web",
      targetId: "target-2",
      externalId: "page-2",
    });

    expect((await repo.queryRecords({ text: "Solana" })).items).toHaveLength(1);
    const page = await repo.queryRecords({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const nextCursor = page.nextCursor;
    if (!nextCursor) throw new Error("Expected a cursor for the next page");
    expect(
      (await repo.queryRecords({ limit: 1, cursor: nextCursor })).items,
    ).toHaveLength(1);
  });

  it("leases due jobs to only one worker", async () => {
    const repo = await createRepo();
    await repo.enqueueJob({
      id: randomUUID(),
      targetId: "target-1",
      source: "x",
      status: "queued",
      attempt: 0,
      runAt: "2026-07-31T00:00:00.000Z",
    });

    expect(await repo.claimJobs("worker-a", 10, 30_000)).toHaveLength(1);
    expect(await repo.claimJobs("worker-b", 10, 30_000)).toHaveLength(0);
  });

  it("commits records and checkpoint as one ingestion unit", async () => {
    const repo = await createRepo();
    const result = await repo.commitIngestion({
      records: [record("atomic")],
      targetId: "target-1",
      checkpoint: { latestId: "post-9" },
    });

    expect(result).toEqual({ inserted: 1, revised: 0, duplicates: 0 });
    expect(await repo.getCheckpoint("target-1")).toEqual({ latestId: "post-9" });
  });

  it("stores and lists derived artifacts separately from source records", async () => {
    const repo = await createRepo();
    await repo.upsertRecord(record("artifact-source"));
    await repo.saveArtifact({
      id: "summary-1",
      recordIds: ["x:target-1:post-9"],
      kind: "summary",
      content: "A sourced summary",
      provider: "openrouter",
      model: "model",
      provenance: { sources: [1] },
      createdAt: "2026-07-31T01:00:00.000Z",
    });
    expect((await repo.queryArtifacts({ kind: "summary" })).items[0]).toMatchObject({
      id: "summary-1",
      content: "A sourced summary",
    });
  });

  it("owns diagnostic lifecycle rows separately and cleans only its target", async () => {
    const repo = await createRepo();
    const now = new Date().toISOString();
    expect(await repo.createDiagnosticWatch({ id: "diagnostic-1", targetId: "__diagnostic:1", source: "web", target: { kind: "url", value: "https://example.test" }, status: "active", createdAt: now, updatedAt: now, job: { id: "diagnostic-job", targetId: "__diagnostic:1", source: "web", status: "queued", attempt: 0, runAt: now } })).toBe(true);
    await repo.cancelDiagnosticWatch("__diagnostic:1");
    expect((await repo.getDiagnosticWatch("__diagnostic:1"))?.status).toBe("cancelled");
    await repo.cleanupDiagnosticWatch("__diagnostic:1");
    await repo.cleanupDiagnosticWatch("__diagnostic:1");
    expect(await repo.getDiagnosticWatch("__diagnostic:1")).toBeUndefined();
  });

  it("rolls back a diagnostic watch when its job ID conflicts", async () => {
    const repo = await createRepo();
    const now = new Date().toISOString();
    await repo.enqueueJob({
      id: "conflicting-job",
      targetId: "user-target",
      source: "web",
      status: "queued",
      attempt: 0,
      runAt: now,
    });

    await expect(
      repo.createDiagnosticWatch({
        id: "diagnostic-conflict",
        targetId: "__argus_doctor:conflict",
        source: "web",
        target: { kind: "url", value: "https://example.test" },
        status: "active",
        createdAt: now,
        updatedAt: now,
        job: {
          id: "conflicting-job",
          targetId: "__argus_doctor:conflict",
          source: "web",
          status: "queued",
          attempt: 0,
          runAt: now,
        },
      }),
    ).rejects.toThrow();
    expect(
      await repo.getDiagnosticWatch("__argus_doctor:conflict"),
    ).toBeUndefined();
  });

  it("terminally cancels a claimed diagnostic job and cleanup is idempotent", async () => {
    const database = openSqlite(":memory:");
    const repo = new SqliteRepository(database);
    repositories.push(repo);
    const now = new Date().toISOString();
    await repo.createDiagnosticWatch({
      id: "claimed",
      targetId: "__argus_doctor:claimed",
      source: "web",
      target: { kind: "url", value: "https://example.test" },
      status: "active",
      createdAt: now,
      updatedAt: now,
      job: {
        id: "claimed-job",
        targetId: "__argus_doctor:claimed",
        source: "web",
        status: "queued",
        attempt: 0,
        runAt: now,
      },
    });
    expect(await repo.claimJobs("worker", 1, 30_000)).toHaveLength(1);

    await repo.cancelDiagnosticWatch("__argus_doctor:claimed");
    expect(
      database
        .prepare(
          "SELECT status, lease_owner, lease_expires_at FROM jobs WHERE id=?",
        )
        .get("claimed-job"),
    ).toEqual({
      status: "complete",
      lease_owner: null,
      lease_expires_at: null,
    });
    await repo.cleanupDiagnosticWatch("__argus_doctor:claimed");
    await repo.cleanupDiagnosticWatch("__argus_doctor:claimed");
    expect(
      database.prepare("SELECT id FROM jobs WHERE id=?").get("claimed-job"),
    ).toBeUndefined();
  });

  it("atomically rejects a diagnostic ingestion after cancellation", async () => {
    const repo = await createRepo();
    const now = new Date().toISOString();
    const targetId = "__argus_doctor:atomic";
    await repo.createDiagnosticWatch({
      id: "atomic",
      targetId,
      source: "web",
      target: {
        kind: "url",
        value: "https://example.test",
        watchId: targetId,
      },
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      job: {
        id: "atomic-job",
        targetId,
        source: "web",
        status: "queued",
        attempt: 0,
        runAt: now,
      },
    });
    await repo.cancelDiagnosticWatch(targetId);

    expect(
      await repo.commitDiagnosticIngestion({
        jobId: "atomic-job",
        targetId,
        records: [{ ...record("diagnostic"), id: "diagnostic", targetId }],
        checkpoint: { lastId: "post-9" },
      }),
    ).toBeUndefined();
    expect(await repo.queryDiagnosticRecords(targetId)).toEqual([]);
    expect(await repo.getCheckpoint(targetId)).toBeUndefined();
  });

  it("hides diagnostic records and strips their IDs from mixed artifacts", async () => {
    const repo = await createRepo();
    const now = new Date().toISOString();
    const targetId = "__argus_doctor:isolation";
    await repo.createDiagnosticWatch({
      id: "isolation",
      targetId,
      source: "web",
      target: {
        kind: "url",
        value: "https://example.test",
        watchId: targetId,
      },
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      job: {
        id: "isolation-job",
        targetId,
        source: "web",
        status: "queued",
        attempt: 0,
        runAt: now,
      },
    });
    await repo.commitDiagnosticIngestion({
      jobId: "isolation-job",
      targetId,
      records: [{ ...record("diagnostic"), id: "diagnostic", targetId }],
      checkpoint: {},
    });
    await repo.upsertRecord(record("user"));
    await repo.saveArtifact({
      id: "mixed",
      recordIds: ["x:target-1:post-9", "diagnostic"],
      kind: "summary",
      content: "mixed",
      provenance: {},
      createdAt: now,
    });

    expect((await repo.queryRecords({})).items.map(({ id }) => id)).toEqual([
      "x:target-1:post-9",
    ]);
    expect((await repo.queryRecords({ targetIds: [targetId] })).items).toEqual(
      [],
    );
    expect((await repo.queryDiagnosticRecords(targetId)).map(({ id }) => id)).toEqual([
      "diagnostic",
    ]);

    await repo.cleanupDiagnosticWatch(targetId);
    expect((await repo.queryArtifacts({})).items[0]?.recordIds).toEqual([
      "x:target-1:post-9",
    ]);
  });

  it("reaps expired diagnostics idempotently without touching user data", async () => {
    const repo = await createRepo();
    const targetId = "__argus_doctor:expired";
    await repo.upsertRecord(record("user"));
    await repo.createDiagnosticWatch({
      id: "expired",
      targetId,
      source: "web",
      target: {
        kind: "url",
        value: "https://example.test",
        watchId: targetId,
      },
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:01:00.000Z",
      job: {
        id: "expired-job",
        targetId,
        source: "web",
        status: "queued",
        attempt: 0,
        runAt: "2026-08-01T00:00:00.000Z",
      },
    });

    expect(
      await repo.reapExpiredDiagnosticWatches("2026-08-01T00:02:00.000Z"),
    ).toBe(1);
    expect(
      await repo.reapExpiredDiagnosticWatches("2026-08-01T00:02:00.000Z"),
    ).toBe(0);
    expect(await repo.getDiagnosticWatch(targetId)).toBeUndefined();
    expect((await repo.queryRecords({})).items.map(({ id }) => id)).toEqual([
      "x:target-1:post-9",
    ]);
  });
});
