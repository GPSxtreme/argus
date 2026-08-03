import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
  AppliedConfig,
  CreateDiagnosticWatchInput,
  DerivedArtifact,
  DiagnosticWatch,
  IngestionCommit,
  IngestionCommitResult,
  Job,
  Page,
  QueryRecordsInput,
  QueryArtifactsInput,
  RecordEnvelope,
  RecordRevision,
  StorageRepository,
} from "@argus/contracts";
import {
  decodeRecordsCursor,
  encodeRecordsCursor,
  escapeSubstringPattern,
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
    const clauses: string[] = [
      `NOT EXISTS (
        SELECT 1 FROM diagnostic_watches
        WHERE diagnostic_watches.target_id = records.target_id
      )`,
    ];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.sources?.length) clauses.push(`source = ANY(${bind(input.sources)})`);
    if (input.targetIds?.length)
      clauses.push(`target_id = ANY(${bind(input.targetIds)})`);
    if (input.watchIds?.length)
      clauses.push(`watch_ids_json ?| ${bind(input.watchIds)}::text[]`);
    if (input.text) {
      const pattern = `%${escapeSubstringPattern(input.text)}%`;
      clauses.push(
        `(title ILIKE ${bind(pattern)} ESCAPE '\\' OR text ILIKE ${bind(pattern)} ESCAPE '\\')`,
      );
    }
    if (input.since) clauses.push(`ingested_at >= ${bind(input.since)}`);
    if (input.until) clauses.push(`ingested_at <= ${bind(input.until)}`);
    const cursor = decodeRecordsCursor(input.cursor);
    if (cursor) {
      const timestamp = bind(cursor.ingestedAt);
      const id = bind(cursor.id);
      clauses.push(
        `(ingested_at < ${timestamp} OR (ingested_at = ${timestamp} AND id > ${id}))`,
      );
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const limitBind = bind(limit + 1);
    const result = await this.pool.query<Row>(
      `SELECT * FROM records
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY ingested_at DESC, id ASC LIMIT ${limitBind}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(mapRecord);
    const lastItem = items[items.length - 1];
    return {
      items,
      ...(hasMore && lastItem
        ? {
            nextCursor: encodeRecordsCursor(lastItem),
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
       (id,target_id,source,status,attempt,run_at,lease_owner,lease_token,
        lease_expires_at,error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [
        job.id,
        job.targetId,
        job.source,
        job.status,
        job.attempt,
        job.runAt,
        job.leaseOwner ?? null,
        job.leaseToken ?? null,
        job.leaseExpiresAt ?? null,
        job.error ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  async claimJobs(owner: string, limit: number, leaseMs: number): Promise<Job[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE jobs SET status='failed',error='worker lease expired',
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
         WHERE status='running' AND lease_expires_at < now() AND attempt >= 5`,
      );
      const candidates = await client.query<Row>(
        `SELECT * FROM jobs WHERE
         (status='queued' AND run_at <= now())
         OR (status='running' AND lease_expires_at < now() AND attempt < 5)
         ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      const rows: Row[] = [];
      for (const candidate of candidates.rows) {
        const result = await client.query<Row>(
          `UPDATE jobs SET status='running',
           attempt=attempt + CASE WHEN status='running' THEN 1 ELSE 0 END,
           lease_owner=$2,lease_token=$3,
           lease_expires_at=now() + ($4 * interval '1 millisecond')
           WHERE id=$1 RETURNING *`,
          [candidate.id, owner, randomUUID(), leaseMs],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Claimed job disappeared during update");
        rows.push(row);
      }
      await client.query("COMMIT");
      return rows.map(
        (row): Job => ({
          id: row.id as string,
          targetId: row.target_id as string,
          source: row.source as Job["source"],
          status: "running",
          attempt: row.attempt as number,
          runAt: iso(row.run_at),
          leaseOwner: owner,
          leaseToken: row.lease_token as string,
          leaseExpiresAt: iso(row.lease_expires_at),
          ...(row.error == null ? {} : { error: row.error as string }),
        }),
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeJob(
    id: string,
    owner: string,
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs SET status='complete',lease_owner=NULL,lease_token=NULL,
       lease_expires_at=NULL
       WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3`,
      [id, owner, leaseToken],
    );
    return result.rowCount === 1;
  }

  async failJob(
    id: string,
    owner: string,
    leaseToken: string,
    error: string,
    retryAt?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs SET status=$2,error=$3,attempt=attempt+1,run_at=$4,
       lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
       WHERE id=$1 AND status='running' AND lease_owner=$5 AND lease_token=$6`,
      [
        id,
        retryAt ? "queued" : "failed",
        error,
        retryAt ?? new Date(),
        owner,
        leaseToken,
      ],
    );
    return result.rowCount === 1;
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

  async queryArtifacts(
    input: QueryArtifactsInput,
  ): Promise<Page<DerivedArtifact>> {
    const result = await this.pool.query<Row>(
      `SELECT * FROM artifacts ${input.kind ? "WHERE kind=$1" : ""}
       ORDER BY created_at DESC,id LIMIT $${input.kind ? 2 : 1}`,
      [...(input.kind ? [input.kind] : []), input.limit ?? 50],
    );
    const ids = result.rows.flatMap((row) =>
      json<string[]>(row.record_ids_json),
    );
    const visible = ids.length
      ? new Set(
          (
            await this.pool.query<Row>(
              `SELECT records.id FROM records
               LEFT JOIN diagnostic_watches
                 ON diagnostic_watches.target_id=records.target_id
               WHERE records.id=ANY($1::text[])
                 AND diagnostic_watches.target_id IS NULL`,
              [ids],
            )
          ).rows.map((row) => row.id as string),
        )
      : new Set<string>();
    return {
      items: result.rows
        .map((row) => ({
          id: row.id as string,
          recordIds: json<string[]>(row.record_ids_json).filter((id) =>
            visible.has(id),
          ),
          kind: row.kind as string,
          content: row.content as string,
          ...(row.provider == null ? {} : { provider: row.provider as string }),
          ...(row.model == null ? {} : { model: row.model as string }),
          provenance: json<Record<string, unknown>>(row.provenance_json),
          createdAt: iso(row.created_at),
        }))
        .filter(({ recordIds }) => recordIds.length > 0),
    };
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
  async createDiagnosticWatch(input: CreateDiagnosticWatchInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expiresAt =
        input.expiresAt ??
        new Date(new Date(input.createdAt).getTime() + 15 * 60_000).toISOString();
      const watch = await client.query(
        `INSERT INTO diagnostic_watches
         (id,target_id,source,target_json,status,created_at,updated_at,expires_at)
         VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          input.id,
          input.targetId,
          input.source,
          JSON.stringify(input.target),
          input.status,
          input.createdAt,
          input.updatedAt,
          expiresAt,
        ],
      );
      if (!watch.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const job = await client.query(
        `INSERT INTO jobs(id,target_id,source,status,attempt,run_at)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          input.job.id,
          input.job.targetId,
          input.job.source,
          input.job.status,
          input.job.attempt,
          input.job.runAt,
        ],
      );
      if (!job.rowCount) {
        throw new Error("Diagnostic watch job could not be enqueued.");
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getDiagnosticWatch(
    targetId: string,
  ): Promise<DiagnosticWatch | undefined> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM diagnostic_watches WHERE target_id=$1",
      [targetId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id as string,
          targetId: row.target_id as string,
          source: row.source as DiagnosticWatch["source"],
          target: json(row.target_json),
          status: row.status as DiagnosticWatch["status"],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
          expiresAt: iso(row.expires_at),
        }
      : undefined;
  }

  async queryDiagnosticRecords(targetId: string): Promise<RecordEnvelope[]> {
    const result = await this.pool.query<Row>(
      `SELECT records.* FROM records
       JOIN diagnostic_watches
         ON diagnostic_watches.target_id=records.target_id
       WHERE records.target_id=$1
       ORDER BY records.ingested_at DESC,records.id`,
      [targetId],
    );
    return result.rows.map(mapRecord);
  }

  async commitDiagnosticIngestion(
    input: IngestionCommit & {
      jobId: string;
      leaseOwner: string;
      leaseToken: string;
    },
  ): Promise<IngestionCommitResult | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const leased = (
        await client.query<Row>(
          `SELECT 1 FROM jobs WHERE id=$1 AND target_id=$2 AND status='running'
           AND lease_owner=$3 AND lease_token=$4 FOR UPDATE`,
          [input.jobId, input.targetId, input.leaseOwner, input.leaseToken],
        )
      ).rows[0];
      if (!leased) {
        await client.query("COMMIT");
        return undefined;
      }
      const watch = (
        await client.query<Row>(
          `SELECT status FROM diagnostic_watches
           WHERE target_id=$1 AND expires_at>now() FOR UPDATE`,
          [input.targetId],
        )
      ).rows[0];
      if (watch?.status !== "active") {
        await client.query(
          `UPDATE jobs SET status='complete',error='diagnostic cancelled',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
           WHERE id=$1 AND target_id=$2 AND status='running'
           AND lease_owner=$3 AND lease_token=$4`,
          [input.jobId, input.targetId, input.leaseOwner, input.leaseToken],
        );
        await client.query("COMMIT");
        return undefined;
      }
      const result = await this.commitRecords(client, input);
      await client.query(
        `UPDATE jobs SET status='complete',error=NULL,lease_owner=NULL,
         lease_token=NULL,lease_expires_at=NULL
         WHERE id=$1 AND target_id=$2 AND status='running'
         AND lease_owner=$3 AND lease_token=$4`,
        [input.jobId, input.targetId, input.leaseOwner, input.leaseToken],
      );
      await client.query(
        `UPDATE diagnostic_watches SET status='complete',updated_at=now()
         WHERE target_id=$1 AND status='active'`,
        [input.targetId],
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

  private async commitRecords(
    client: PoolClient,
    input: IngestionCommit,
  ): Promise<IngestionCommitResult> {
    const result: IngestionCommitResult = {
      inserted: 0,
      revised: 0,
      duplicates: 0,
    };
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
    return result;
  }

  async cancelDiagnosticWatch(targetId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE diagnostic_watches SET status='cancelled',updated_at=now()
         WHERE target_id=$1 AND status='active'`,
        [targetId],
      );
      await client.query(
        `UPDATE jobs SET status='complete',error='diagnostic cancelled',
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
         WHERE target_id=$1 AND status IN ('queued','running')`,
        [targetId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async cleanupDiagnosticWatchWithClient(
    client: PoolClient,
    targetId: string,
  ): Promise<void> {
    const diagnosticRecordIds = (
      await client.query<Row>("SELECT id FROM records WHERE target_id=$1", [
        targetId,
      ])
    ).rows.map((row) => row.id as string);
    if (diagnosticRecordIds.length > 0) {
      const artifacts = await client.query<Row>(
        "SELECT id,record_ids_json FROM artifacts FOR UPDATE",
      );
      const owned = new Set(diagnosticRecordIds);
      for (const artifact of artifacts.rows) {
        const recordIds = json<string[]>(artifact.record_ids_json);
        const remaining = recordIds.filter((recordId) => !owned.has(recordId));
        if (remaining.length === 0 && remaining.length !== recordIds.length) {
          await client.query("DELETE FROM artifacts WHERE id=$1", [artifact.id]);
        } else if (remaining.length !== recordIds.length) {
          await client.query(
            "UPDATE artifacts SET record_ids_json=$1::jsonb WHERE id=$2",
            [JSON.stringify(remaining), artifact.id],
          );
        }
      }
    }
    await client.query("DELETE FROM records WHERE target_id=$1", [targetId]);
    await client.query("DELETE FROM checkpoints WHERE target_id=$1", [targetId]);
    await client.query("DELETE FROM jobs WHERE target_id=$1", [targetId]);
    await client.query("DELETE FROM diagnostic_watches WHERE target_id=$1", [
      targetId,
    ]);
  }

  async cleanupDiagnosticWatch(targetId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.cleanupDiagnosticWatchWithClient(client, targetId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reapExpiredDiagnosticWatches(now = new Date().toISOString()): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<Row>(
        `SELECT target_id FROM diagnostic_watches
         WHERE expires_at<=$1 FOR UPDATE`,
        [now],
      );
      for (const row of expired.rows) {
        const targetId = row.target_id as string;
        await client.query(
          `UPDATE jobs SET status='complete',error='diagnostic expired',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
           WHERE target_id=$1 AND status IN ('queued','running')`,
          [targetId],
        );
        await this.cleanupDiagnosticWatchWithClient(client, targetId);
      }
      await client.query("COMMIT");
      return expired.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const createPool = (connectionString: string): Pool =>
  new Pool({ connectionString, max: 10 });
