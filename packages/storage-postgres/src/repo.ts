import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
  AppliedConfig,
  DerivedArtifact,
  IngestionCommit,
  IngestionCommitResult,
  Job,
  Page,
  QueryRecordsInput,
  RecordEnvelope,
  RecordRevision,
  StorageRepository,
} from "@argus/contracts";
import { POSTGRES_SCHEMA } from "./schema.js";

type Row = Record<string, unknown>;
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const json = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;

const mapRecord = (row: Row): RecordEnvelope => ({
  id: row.id as string,
  source: row.source as RecordEnvelope["source"],
  targetId: row.target_id as string,
  externalId: row.external_id as string,
  url: row.url as string,
  ...(row.title == null ? {} : { title: row.title as string }),
  text: row.text as string,
  ...(row.author == null ? {} : { author: row.author as string }),
  ...(row.published_at == null ? {} : { publishedAt: iso(row.published_at) }),
  raw: json(row.raw_json),
  ...(row.metadata_json == null
    ? {}
    : { metadata: json<Record<string, unknown>>(row.metadata_json) }),
  watchIds: json<string[]>(row.watch_ids_json),
  contentHash: row.content_hash as string,
  ingestedAt: iso(row.ingested_at),
});

const mapRevision = (row: Row): RecordRevision => ({
  id: row.id as string,
  recordId: row.record_id as string,
  contentHash: row.content_hash as string,
  ...(row.title == null ? {} : { title: row.title as string }),
  text: row.text as string,
  raw: json(row.raw_json),
  createdAt: iso(row.created_at),
});

export class PostgresRepository implements StorageRepository {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertRecord(record: RecordEnvelope): Promise<{
    record: RecordEnvelope;
    revision?: RecordRevision;
    created: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<Row>(
        "SELECT * FROM records WHERE id=$1 FOR UPDATE",
        [record.id],
      );
      const current = currentResult.rows[0];
      if (current?.content_hash === record.contentHash) {
        await client.query("COMMIT");
        return { record: mapRecord(current), created: false };
      }
      const revision: RecordRevision = {
        id: randomUUID(),
        recordId: record.id,
        contentHash: record.contentHash,
        ...(record.title === undefined ? {} : { title: record.title }),
        text: record.text,
        raw: record.raw,
        createdAt: record.ingestedAt,
      };
      await client.query(
        `INSERT INTO records (
          id, source, target_id, external_id, url, title, text, author,
          published_at, raw_json, metadata_json, watch_ids_json, content_hash,
          ingested_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14
        ) ON CONFLICT(id) DO UPDATE SET
          url=excluded.url, title=excluded.title, text=excluded.text,
          author=excluded.author, published_at=excluded.published_at,
          raw_json=excluded.raw_json, metadata_json=excluded.metadata_json,
          watch_ids_json=excluded.watch_ids_json, content_hash=excluded.content_hash,
          ingested_at=excluded.ingested_at`,
        [
          record.id,
          record.source,
          record.targetId,
          record.externalId,
          record.url,
          record.title ?? null,
          record.text,
          record.author ?? null,
          record.publishedAt ?? null,
          JSON.stringify(record.raw),
          record.metadata === undefined ? null : JSON.stringify(record.metadata),
          JSON.stringify(record.watchIds),
          record.contentHash,
          record.ingestedAt,
        ],
      );
      await client.query(
        `INSERT INTO revisions
        (id, record_id, content_hash, title, text, raw_json, created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`,
        [
          revision.id,
          revision.recordId,
          revision.contentHash,
          revision.title ?? null,
          revision.text,
          JSON.stringify(revision.raw),
          revision.createdAt,
        ],
      );
      await client.query("COMMIT");
      return { record, revision, created: current === undefined };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRevisions(recordId: string): Promise<Page<RecordRevision>> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM revisions WHERE record_id=$1 ORDER BY created_at, id",
      [recordId],
    );
    return { items: result.rows.map(mapRevision) };
  }

  async commitIngestion(
    input: IngestionCommit,
  ): Promise<IngestionCommitResult> {
    const client = await this.pool.connect();
    const result: IngestionCommitResult = {
      inserted: 0,
      revised: 0,
      duplicates: 0,
    };
    try {
      await client.query("BEGIN");
      for (const record of input.records) {
        const current = (
          await client.query<Row>(
            "SELECT content_hash FROM records WHERE id=$1 FOR UPDATE",
            [record.id],
          )
        ).rows[0];
        if (current?.content_hash === record.contentHash) {
          result.duplicates += 1;
          continue;
        }
        await client.query(
          `INSERT INTO records (
            id,source,target_id,external_id,url,title,text,author,published_at,
            raw_json,metadata_json,watch_ids_json,content_hash,ingested_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14
          ) ON CONFLICT(id) DO UPDATE SET
            url=excluded.url,title=excluded.title,text=excluded.text,
            author=excluded.author,published_at=excluded.published_at,
            raw_json=excluded.raw_json,metadata_json=excluded.metadata_json,
            watch_ids_json=excluded.watch_ids_json,
            content_hash=excluded.content_hash,ingested_at=excluded.ingested_at`,
          [
            record.id,
            record.source,
            record.targetId,
            record.externalId,
            record.url,
            record.title ?? null,
            record.text,
            record.author ?? null,
            record.publishedAt ?? null,
            JSON.stringify(record.raw),
            record.metadata === undefined ? null : JSON.stringify(record.metadata),
            JSON.stringify(record.watchIds),
            record.contentHash,
            record.ingestedAt,
          ],
        );
        await client.query(
          `INSERT INTO revisions
           (id,record_id,content_hash,title,text,raw_json,created_at)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            record.id,
            record.contentHash,
            record.title ?? null,
            record.text,
            JSON.stringify(record.raw),
            record.ingestedAt,
          ],
        );
        if (current) result.revised += 1;
        else result.inserted += 1;
      }
      await client.query(
        `INSERT INTO checkpoints(target_id,value_json,updated_at)
         VALUES($1,$2::jsonb,now()) ON CONFLICT(target_id) DO UPDATE SET
         value_json=excluded.value_json,updated_at=excluded.updated_at`,
        [input.targetId, JSON.stringify(input.checkpoint)],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async queryRecords(input: QueryRecordsInput): Promise<Page<RecordEnvelope>> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.sources?.length) clauses.push(`source = ANY(${bind(input.sources)})`);
    if (input.targetIds?.length)
      clauses.push(`target_id = ANY(${bind(input.targetIds)})`);
    if (input.text)
      clauses.push(
        `search_document @@ websearch_to_tsquery('simple', ${bind(input.text)})`,
      );
    if (input.since) clauses.push(`ingested_at >= ${bind(input.since)}`);
    if (input.until) clauses.push(`ingested_at <= ${bind(input.until)}`);
    const offset = input.cursor
      ? Number(Buffer.from(input.cursor, "base64url").toString("utf8"))
      : 0;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const limitBind = bind(limit + 1);
    const offsetBind = bind(Number.isSafeInteger(offset) && offset >= 0 ? offset : 0);
    const result = await this.pool.query<Row>(
      `SELECT * FROM records
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY ingested_at DESC, id ASC LIMIT ${limitBind} OFFSET ${offsetBind}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    return {
      items: result.rows.slice(0, limit).map(mapRecord),
      ...(hasMore
        ? {
            nextCursor: Buffer.from(String(offset + limit)).toString("base64url"),
          }
        : {}),
    };
  }

  async getCheckpoint<T>(targetId: string): Promise<T | undefined> {
    const result = await this.pool.query<Row>(
      "SELECT value_json FROM checkpoints WHERE target_id=$1",
      [targetId],
    );
    return result.rows[0] ? json<T>(result.rows[0].value_json) : undefined;
  }

  async setCheckpoint<T>(targetId: string, checkpoint: T): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkpoints(target_id,value_json,updated_at)
       VALUES($1,$2::jsonb,now()) ON CONFLICT(target_id) DO UPDATE SET
       value_json=excluded.value_json,updated_at=excluded.updated_at`,
      [targetId, JSON.stringify(checkpoint)],
    );
  }

  async enqueueJob(job: Job): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO jobs
       (id,target_id,source,status,attempt,run_at,lease_owner,lease_expires_at,error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        job.id,
        job.targetId,
        job.source,
        job.status,
        job.attempt,
        job.runAt,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.error ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  async claimJobs(owner: string, limit: number, leaseMs: number): Promise<Job[]> {
    const result = await this.pool.query<Row>(
      `WITH claimed AS (
        SELECT id FROM jobs WHERE status='queued' AND run_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT $2
      )
      UPDATE jobs SET status='running',lease_owner=$1,
        lease_expires_at=now() + ($3 * interval '1 millisecond')
      WHERE id IN (SELECT id FROM claimed) RETURNING *`,
      [owner, limit, leaseMs],
    );
    return result.rows.map(
      (row): Job => ({
        id: row.id as string,
        targetId: row.target_id as string,
        source: row.source as Job["source"],
        status: "running",
        attempt: row.attempt as number,
        runAt: iso(row.run_at),
        leaseOwner: owner,
        leaseExpiresAt: iso(row.lease_expires_at),
        ...(row.error == null ? {} : { error: row.error as string }),
      }),
    );
  }

  async completeJob(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE jobs SET status='complete',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [id],
    );
  }

  async failJob(id: string, error: string, retryAt?: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status=$2,error=$3,attempt=attempt+1,run_at=$4,
       lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
      [id, retryAt ? "queued" : "failed", error, retryAt ?? new Date()],
    );
  }

  async saveArtifact(artifact: DerivedArtifact): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifacts
       (id,record_ids_json,kind,content,provider,model,provenance_json,created_at)
       VALUES($1,$2::jsonb,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content,
       provenance_json=excluded.provenance_json`,
      [
        artifact.id,
        JSON.stringify(artifact.recordIds),
        artifact.kind,
        artifact.content,
        artifact.provider ?? null,
        artifact.model ?? null,
        JSON.stringify(artifact.provenance),
        artifact.createdAt,
      ],
    );
  }

  async getAppliedConfig(): Promise<AppliedConfig | undefined> {
    const result = await this.pool.query<Row>(
      "SELECT config_json,content_hash,applied_at FROM applied_config WHERE id=1",
    );
    const row = result.rows[0];
    return row
      ? {
          config: json(row.config_json),
          contentHash: row.content_hash as string,
          appliedAt: iso(row.applied_at),
        }
      : undefined;
  }

  async applyConfig(snapshot: AppliedConfig): Promise<void> {
    await this.pool.query(
      `INSERT INTO applied_config(id,config_json,content_hash,applied_at)
       VALUES(1,$1::jsonb,$2,$3) ON CONFLICT(id) DO UPDATE SET
       config_json=excluded.config_json,content_hash=excluded.content_hash,
       applied_at=excluded.applied_at`,
      [JSON.stringify(snapshot.config), snapshot.contentHash, snapshot.appliedAt],
    );
  }
}

export const createPool = (connectionString: string): Pool =>
  new Pool({ connectionString, max: 10 });
