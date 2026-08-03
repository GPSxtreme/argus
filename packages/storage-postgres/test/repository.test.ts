import { randomUUID } from "node:crypto";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { RecordEnvelope } from "@argus/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresRepository,
  type PostgresRepository,
} from "../src/index.js";

let container: StartedPostgreSqlContainer;
let repo: PostgresRepository;
let testConnectionString: string;

const record = (hash: string, text = "Argus data layer"): RecordEnvelope => ({
  id: "web:site:article",
  source: "web",
  targetId: "site",
  externalId: "article",
  url: "https://example.com/article",
  title: "Argus",
  text,
  raw: { text },
  watchIds: ["argus"],
  contentHash: hash,
  ingestedAt: "2026-07-31T00:00:00.000Z",
});

const recordAt = (
  suffix: string,
  id: string,
  ingestedAt: string,
): RecordEnvelope => ({
  ...record(`${suffix}:${id}`, id),
  id: `${suffix}:${id}`,
  targetId: suffix,
  externalId: id,
  ingestedAt,
});

describe.skipIf(
  !process.env.TEST_DATABASE_URL &&
    process.env.ARGUS_POSTGRES_TEST !== "1" &&
    process.env.CI !== "true",
)("PostgreSQL repository", () => {
  beforeAll(async () => {
    testConnectionString =
      process.env.TEST_DATABASE_URL ??
      (await (async () => {
        container = await new PostgreSqlContainer("postgres:17-alpine").start();
        return container.getConnectionUri();
      })());
    repo = await createPostgresRepository({
      connectionString: testConnectionString,
    });
  }, 120_000);

  afterAll(async () => {
    await repo?.close();
    if (container) await container.stop();
  });

  it("deduplicates records and preserves revisions", async () => {
    expect((await repo.upsertRecord(record("a"))).created).toBe(true);
    expect((await repo.upsertRecord(record("a"))).created).toBe(false);
    expect((await repo.upsertRecord(record("b", "Argus V1"))).revision).toBeTruthy();
    expect((await repo.listRevisions(record("a").id)).items).toHaveLength(2);
  });

  it("adds lease fencing to an existing jobs table without losing jobs", async () => {
    const client = new Pool({ connectionString: testConnectionString });
    const id = randomUUID();
    try {
      await client.query(
        `INSERT INTO jobs(id,target_id,source,status,attempt,run_at)
         VALUES($1,'legacy-target','web','queued',0,now())`,
        [id],
      );
      await client.query("ALTER TABLE jobs DROP COLUMN lease_token");
      await repo.migrate();
      const result = await client.query(
        `SELECT id,lease_token FROM jobs WHERE id=$1`,
        [id],
      );
      expect(result.rows).toEqual([{ id, lease_token: null }]);
      await client.query("DELETE FROM jobs WHERE id=$1", [id]);
    } finally {
      await client.end();
    }
  });

  it("supports full text filters", async () => {
    expect((await repo.queryRecords({ text: "V1" })).items).toHaveLength(1);
    expect((await repo.queryRecords({ text: "missing" })).items).toHaveLength(0);
  });

  it("matches LIKE wildcards literally in search text", async () => {
    const suffix = randomUUID();
    await repo.upsertRecord({
      ...record(`${suffix}:a`, "100% battery life"),
      id: `web:${suffix}:page-1`,
      targetId: suffix,
      externalId: "page-1",
    });
    await repo.upsertRecord({
      ...record(`${suffix}:b`, "underscore_test value"),
      id: `web:${suffix}:page-2`,
      targetId: suffix,
      externalId: "page-2",
    });
    expect(
      (await repo.queryRecords({ text: "100%" })).items.map(({ id }) => id),
    ).toEqual([`web:${suffix}:page-1`]);
    expect(
      (await repo.queryRecords({ text: "underscore_test" })).items.map(
        ({ id }) => id,
      ),
    ).toEqual([`web:${suffix}:page-2`]);
    expect(
      (await repo.queryRecords({ text: "100%_anything" })).items,
    ).toHaveLength(0);
  });

  it("uses a strict keyset cursor across inserts and equal timestamps", async () => {
    const suffix = randomUUID();
    await Promise.all([
      repo.upsertRecord(recordAt(suffix, "a", "2026-08-01T03:00:00.000Z")),
      repo.upsertRecord(recordAt(suffix, "b", "2026-08-01T02:00:00.000Z")),
      repo.upsertRecord(recordAt(suffix, "c", "2026-08-01T02:00:00.000Z")),
      repo.upsertRecord(recordAt(suffix, "d", "2026-08-01T01:00:00.000Z")),
    ]);
    const first = await repo.queryRecords({ targetIds: [suffix], limit: 2 });
    expect(first.items.map(({ externalId }) => externalId)).toEqual(["a", "b"]);
    if (!first.nextCursor) throw new Error("Expected a keyset cursor");
    await repo.upsertRecord(
      recordAt(suffix, "newer", "2026-08-01T04:00:00.000Z"),
    );
    const second = await repo.queryRecords({
      targetIds: [suffix],
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map(({ externalId }) => externalId)).toEqual(["c", "d"]);
  });

  it("fails closed for malformed and version-mismatched record cursors", async () => {
    for (const cursor of [
      Buffer.from("1").toString("base64url"),
      Buffer.from(
        JSON.stringify({
          v: 2,
          ingestedAt: "2026-08-01T00:00:00.000Z",
          id: "a",
        }),
      ).toString("base64url"),
    ]) {
      await expect(repo.queryRecords({ cursor })).rejects.toMatchObject({
        code: "RECORDS_CURSOR_INVALID",
      });
    }
  });

  it("claims a job once across workers", async () => {
    await repo.enqueueJob({
      id: randomUUID(),
      targetId: "site",
      source: "web",
      status: "queued",
      attempt: 0,
      runAt: "2026-07-31T00:00:00.000Z",
    });
    const claims = await Promise.all([
      repo.claimJobs("worker-a", 1, 30_000),
      repo.claimJobs("worker-b", 1, 30_000),
    ]);
    expect(claims.flat()).toHaveLength(1);
  });

  it("reclaims expired leases and fences stale owners", async () => {
    const id = randomUUID();
    await repo.enqueueJob({
      id,
      targetId: "site",
      source: "web",
      status: "queued",
      attempt: 0,
      runAt: "2026-07-31T00:00:00.000Z",
    });
    const original = (await repo.claimJobs("worker-a", 1, 1))[0];
    if (!original?.leaseToken) throw new Error("Expected a fenced lease");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimed = (await repo.claimJobs("worker-b", 1, 30_000))[0];
    if (!reclaimed?.leaseToken) throw new Error("Expected a reclaimed lease");
    expect(reclaimed.attempt).toBe(1);
    await expect(
      repo.completeJob(id, "worker-a", original.leaseToken),
    ).resolves.toBe(false);
    await expect(
      repo.failJob(
        id,
        "worker-a",
        original.leaseToken,
        "stale failure",
      ),
    ).resolves.toBe(false);
    await expect(
      repo.failJob(
        id,
        "worker-b",
        reclaimed.leaseToken,
        "retry",
        "2026-07-31T00:00:00.000Z",
      ),
    ).resolves.toBe(true);
    expect((await repo.claimJobs("worker-c", 1, 30_000))[0]?.attempt).toBe(2);
  });

  it("does not reclaim an expired job after its retry budget is exhausted", async () => {
    await repo.enqueueJob({
      id: randomUUID(),
      targetId: randomUUID(),
      source: "web",
      status: "running",
      attempt: 5,
      runAt: "2026-07-31T00:00:00.000Z",
      leaseOwner: "crashed-worker",
      leaseToken: randomUUID(),
      leaseExpiresAt: "2026-07-31T00:00:00.000Z",
    });
    await expect(repo.claimJobs("replacement", 1, 30_000)).resolves.toEqual([]);
  });

  it("isolates, atomically commits, cleans, and expires diagnostics", async () => {
    const suffix = randomUUID();
    const targetId = `__argus_doctor:${suffix}`;
    const jobId = `diagnostic-job:${suffix}`;
    const now = new Date().toISOString();
    const userRecord = {
      ...record(`user-${suffix}`),
      id: `web:user:${suffix}`,
      targetId: `user:${suffix}`,
      externalId: suffix,
    };
    await repo.upsertRecord(userRecord);
    await repo.createDiagnosticWatch({
      id: suffix,
      targetId,
      source: "web",
      target: {
        kind: "url",
        value: "https://example.com/article",
        watchId: targetId,
      },
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      job: {
        id: jobId,
        targetId,
        source: "web",
        status: "queued",
        attempt: 0,
        runAt: now,
      },
    });
    const lease = (await repo.claimJobs("diagnostic-worker", 1, 30_000))[0];
    expect(lease?.id).toBe(jobId);
    if (!lease?.leaseToken) throw new Error("Expected diagnostic lease");
    const diagnosticRecord = {
      ...record(`diagnostic-${suffix}`),
      id: `web:diagnostic:${suffix}`,
      targetId,
      externalId: suffix,
      watchIds: [targetId],
    };
    expect(
      await repo.commitDiagnosticIngestion({
        jobId,
        leaseOwner: "diagnostic-worker",
        leaseToken: lease.leaseToken,
        targetId,
        records: [diagnosticRecord],
        checkpoint: { lastId: suffix },
      }),
    ).toMatchObject({ inserted: 1 });
    expect((await repo.queryRecords({ targetIds: [targetId] })).items).toEqual(
      [],
    );
    expect(await repo.queryDiagnosticRecords(targetId)).toHaveLength(1);
    await repo.saveArtifact({
      id: `mixed:${suffix}`,
      recordIds: [userRecord.id, diagnosticRecord.id],
      kind: "summary",
      content: "mixed",
      provenance: {},
      createdAt: now,
    });

    await repo.cleanupDiagnosticWatch(targetId);
    expect(
      (await repo.queryArtifacts({})).items.find(
        ({ id }) => id === `mixed:${suffix}`,
      )?.recordIds,
    ).toEqual([userRecord.id]);

    const expiredTargetId = `__argus_doctor:expired:${suffix}`;
    await repo.createDiagnosticWatch({
      id: `expired:${suffix}`,
      targetId: expiredTargetId,
      source: "web",
      target: {
        kind: "url",
        value: "https://example.com/article",
        watchId: expiredTargetId,
      },
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:01:00.000Z",
      job: {
        id: `expired-job:${suffix}`,
        targetId: expiredTargetId,
        source: "web",
        status: "queued",
        attempt: 0,
        runAt: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(
      await repo.reapExpiredDiagnosticWatches("2026-08-01T00:02:00.000Z"),
    ).toBeGreaterThanOrEqual(1);
    expect(await repo.getDiagnosticWatch(expiredTargetId)).toBeUndefined();
    expect(
      (await repo.queryRecords({ targetIds: [userRecord.targetId] })).items,
    ).toHaveLength(1);
  });
});
