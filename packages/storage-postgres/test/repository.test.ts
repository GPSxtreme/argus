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
});
