import { randomUUID } from "node:crypto";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { RecordEnvelope } from "@argus/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresRepository,
  type PostgresRepository,
} from "../src/index.js";

let container: StartedPostgreSqlContainer;
let repo: PostgresRepository;

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

describe.skipIf(
  !process.env.TEST_DATABASE_URL &&
    process.env.ARGUS_POSTGRES_TEST !== "1" &&
    process.env.CI !== "true",
)("PostgreSQL repository", () => {
  beforeAll(async () => {
    const connectionString =
      process.env.TEST_DATABASE_URL ??
      (await (async () => {
        container = await new PostgreSqlContainer("postgres:17-alpine").start();
        return container.getConnectionUri();
      })());
    repo = await createPostgresRepository({
      connectionString,
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

  it("supports full text filters", async () => {
    expect((await repo.queryRecords({ text: "V1" })).items).toHaveLength(1);
    expect((await repo.queryRecords({ text: "missing" })).items).toHaveLength(0);
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
    expect(await repo.claimJobs("worker-a", 1, 30_000)).toHaveLength(1);
    expect(await repo.claimJobs("worker-b", 1, 30_000)).toHaveLength(0);
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
    expect((await repo.claimJobs("diagnostic-worker", 1, 30_000))[0]?.id).toBe(
      jobId,
    );
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
