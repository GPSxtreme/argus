import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
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

type RecordRow = {
  id: string;
  source: RecordEnvelope["source"];
  target_id: string;
  external_id: string;
  url: string;
  title: string | null;
  text: string;
  author: string | null;
  published_at: string | null;
  raw_json: string;
  metadata_json: string | null;
  watch_ids_json: string;
  content_hash: string;
  ingested_at: string;
};

type RevisionRow = {
  id: string;
  record_id: string;
  content_hash: string;
  title: string | null;
  text: string;
  raw_json: string;
  created_at: string;
};

const mapRecord = (row: RecordRow): RecordEnvelope => ({
  id: row.id,
  source: row.source,
  targetId: row.target_id,
  externalId: row.external_id,
  url: row.url,
  ...(row.title === null ? {} : { title: row.title }),
  text: row.text,
  ...(row.author === null ? {} : { author: row.author }),
  ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
  raw: JSON.parse(row.raw_json) as unknown,
  ...(row.metadata_json === null
    ? {}
    : { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }),
  watchIds: JSON.parse(row.watch_ids_json) as string[],
  contentHash: row.content_hash,
  ingestedAt: row.ingested_at,
});

const mapRevision = (row: RevisionRow): RecordRevision => ({
  id: row.id,
  recordId: row.record_id,
  contentHash: row.content_hash,
  ...(row.title === null ? {} : { title: row.title }),
  text: row.text,
  raw: JSON.parse(row.raw_json) as unknown,
  createdAt: row.created_at,
});

export class SqliteRepository implements StorageRepository {
  constructor(private readonly database: Database.Database) {}

  close(): void {
    this.database.close();
  }

  async upsertRecord(record: RecordEnvelope): Promise<{
    record: RecordEnvelope;
    revision?: RecordRevision;
    created: boolean;
  }> {
    return this.database.transaction(() => this.upsertRecordSync(record))();
  }

  private upsertRecordSync(record: RecordEnvelope): {
    record: RecordEnvelope;
    revision?: RecordRevision;
    created: boolean;
  } {
      const current = this.database
        .prepare("SELECT * FROM records WHERE id = ?")
        .get(record.id) as RecordRow | undefined;
      if (current?.content_hash === record.contentHash) {
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

      this.database
        .prepare(
          `INSERT INTO records (
            id, source, target_id, external_id, url, title, text, author,
            published_at, raw_json, metadata_json, watch_ids_json, content_hash,
            ingested_at
          ) VALUES (
            @id, @source, @targetId, @externalId, @url, @title, @text, @author,
            @publishedAt, @rawJson, @metadataJson, @watchIdsJson, @contentHash,
            @ingestedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            url=excluded.url, title=excluded.title, text=excluded.text,
            author=excluded.author, published_at=excluded.published_at,
            raw_json=excluded.raw_json, metadata_json=excluded.metadata_json,
            watch_ids_json=excluded.watch_ids_json,
            content_hash=excluded.content_hash, ingested_at=excluded.ingested_at`,
        )
        .run({
          ...record,
          title: record.title ?? null,
          author: record.author ?? null,
          publishedAt: record.publishedAt ?? null,
          rawJson: JSON.stringify(record.raw),
          metadataJson:
            record.metadata === undefined ? null : JSON.stringify(record.metadata),
          watchIdsJson: JSON.stringify(record.watchIds),
        });
      this.database
        .prepare(
          `INSERT OR IGNORE INTO revisions
          (id, record_id, content_hash, title, text, raw_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.id,
          revision.recordId,
          revision.contentHash,
          revision.title ?? null,
          revision.text,
          JSON.stringify(revision.raw),
          revision.createdAt,
        );
      return {
        record,
        revision,
        created: current === undefined,
      };
  }

  async commitIngestion(
    input: IngestionCommit,
  ): Promise<IngestionCommitResult> {
    return this.database.transaction(() => {
      const result: IngestionCommitResult = {
        inserted: 0,
        revised: 0,
        duplicates: 0,
      };
      for (const record of input.records) {
        const write = this.upsertRecordSync(record);
        if (write.created) result.inserted += 1;
        else if (write.revision) result.revised += 1;
        else result.duplicates += 1;
      }
      this.database
        .prepare(
          `INSERT INTO checkpoints(target_id, value_json, updated_at)
           VALUES (?, ?, ?) ON CONFLICT(target_id) DO UPDATE SET
           value_json=excluded.value_json, updated_at=excluded.updated_at`,
        )
        .run(
          input.targetId,
          JSON.stringify(input.checkpoint),
          new Date().toISOString(),
        );
      return result;
    })();
  }

  async listRevisions(recordId: string): Promise<Page<RecordRevision>> {
    const rows = this.database
      .prepare(
        "SELECT * FROM revisions WHERE record_id = ? ORDER BY created_at, id",
      )
      .all(recordId) as RevisionRow[];
    return { items: rows.map(mapRevision) };
  }

  async queryRecords(input: QueryRecordsInput): Promise<Page<RecordEnvelope>> {
    const conditions: string[] = [
      `NOT EXISTS (
        SELECT 1 FROM diagnostic_watches
        WHERE diagnostic_watches.target_id = records.target_id
      )`,
    ];
    const parameters: unknown[] = [];
    if (input.sources?.length) {
      conditions.push(`source IN (${input.sources.map(() => "?").join(",")})`);
      parameters.push(...input.sources);
    }
    if (input.targetIds?.length) {
      conditions.push(
        `target_id IN (${input.targetIds.map(() => "?").join(",")})`,
      );
      parameters.push(...input.targetIds);
    }
    if (input.watchIds?.length) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM json_each(records.watch_ids_json)
          WHERE value IN (${input.watchIds.map(() => "?").join(",")})
        )`,
      );
      parameters.push(...input.watchIds);
    }
    if (input.text) {
      const pattern = `%${escapeSubstringPattern(input.text)}%`;
      conditions.push(
        "(title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')",
      );
      parameters.push(pattern, pattern);
    }
    if (input.since) {
      conditions.push("ingested_at >= ?");
      parameters.push(input.since);
    }
    if (input.until) {
      conditions.push("ingested_at <= ?");
      parameters.push(input.until);
    }
    const cursor = decodeRecordsCursor(input.cursor);
    if (cursor) {
      conditions.push(
        "(ingested_at < ? OR (ingested_at = ? AND id > ?))",
      );
      parameters.push(cursor.ingestedAt, cursor.ingestedAt, cursor.id);
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT * FROM records ${where}
         ORDER BY ingested_at DESC, id ASC LIMIT ?`,
      )
      .all(...parameters, limit + 1) as RecordRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapRecord);
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
    const row = this.database
      .prepare("SELECT value_json FROM checkpoints WHERE target_id = ?")
      .get(targetId) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  async setCheckpoint<T>(targetId: string, checkpoint: T): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO checkpoints(target_id, value_json, updated_at)
         VALUES (?, ?, ?) ON CONFLICT(target_id) DO UPDATE SET
         value_json=excluded.value_json, updated_at=excluded.updated_at`,
      )
      .run(targetId, JSON.stringify(checkpoint), new Date().toISOString());
  }

  async enqueueJob(job: Job): Promise<boolean> {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO jobs
          (id, target_id, source, status, attempt, run_at, lease_owner,
           lease_token, lease_expires_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        ).changes === 1
    );
  }

  async claimJobs(owner: string, limit: number, leaseMs: number): Promise<Job[]> {
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE jobs SET status='failed',error='worker lease expired',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
           WHERE status='running' AND lease_expires_at < ? AND attempt >= 5`,
        )
        .run(now);
      const rows = this.database
        .prepare(
          `SELECT * FROM jobs WHERE
           (status='queued' AND run_at <= ?)
           OR (status='running' AND lease_expires_at < ? AND attempt < 5)
           ORDER BY run_at, id LIMIT ?`,
        )
        .all(now, now, limit) as Array<Record<string, unknown>>;
      const expires = new Date(Date.now() + leaseMs).toISOString();
      const update = this.database.prepare(
        `UPDATE jobs SET status='running',attempt=?,
         lease_owner=?,lease_token=?,lease_expires_at=? WHERE id=?`,
      );
      const claimed = rows.map((row) => {
        const leaseToken = randomUUID();
        const attempt =
          (row.attempt as number) + (row.status === "running" ? 1 : 0);
        update.run(attempt, owner, leaseToken, expires, row.id);
        return { row, leaseToken, attempt };
      });
      return claimed.map(({ row, leaseToken, attempt }): Job => ({
        id: row.id as string,
        targetId: row.target_id as string,
        source: row.source as Job["source"],
        status: "running",
        attempt,
        runAt: row.run_at as string,
        leaseOwner: owner,
        leaseToken,
        leaseExpiresAt: expires,
        ...(row.error ? { error: row.error as string } : {}),
      }));
    })();
  }

  async completeJob(
    id: string,
    owner: string,
    leaseToken: string,
  ): Promise<boolean> {
    return this.database
      .prepare(
        `UPDATE jobs SET status='complete',lease_owner=NULL,lease_token=NULL,
         lease_expires_at=NULL
         WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?`,
      )
      .run(id, owner, leaseToken).changes === 1;
  }

  async failJob(
    id: string,
    owner: string,
    leaseToken: string,
    error: string,
    retryAt?: string,
  ): Promise<boolean> {
    return this.database
      .prepare(
        `UPDATE jobs SET status=?, error=?, attempt=attempt+1, run_at=?,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
         WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?`,
      )
      .run(
        retryAt ? "queued" : "failed",
        error,
        retryAt ?? new Date().toISOString(),
        id,
        owner,
        leaseToken,
      ).changes === 1;
  }

  async saveArtifact(artifact: DerivedArtifact): Promise<void> {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO artifacts
        (id, record_ids_json, kind, content, provider, model, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        JSON.stringify(artifact.recordIds),
        artifact.kind,
        artifact.content,
        artifact.provider ?? null,
        artifact.model ?? null,
        JSON.stringify(artifact.provenance),
        artifact.createdAt,
      );
  }

  async queryArtifacts(
    input: QueryArtifactsInput,
  ): Promise<Page<DerivedArtifact>> {
    const conditions = [
      `EXISTS (
        SELECT 1
        FROM json_each(artifacts.record_ids_json) AS artifact_record
        JOIN records ON records.id = artifact_record.value
        LEFT JOIN diagnostic_watches
          ON diagnostic_watches.target_id = records.target_id
        WHERE diagnostic_watches.target_id IS NULL
      )`,
    ];
    const parameters: unknown[] = [];
    if (input.kind) {
      conditions.push("kind = ?");
      parameters.push(input.kind);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM artifacts WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(...parameters, input.limit ?? 50) as Array<
      Record<string, unknown>
    >;
    return {
      items: rows.map((row) => {
        const recordIds = JSON.parse(row.record_ids_json as string) as string[];
        const visibleRecordIds = recordIds.filter((recordId) =>
          this.database
            .prepare(
              `SELECT 1 FROM records
               LEFT JOIN diagnostic_watches
                 ON diagnostic_watches.target_id = records.target_id
               WHERE records.id=? AND diagnostic_watches.target_id IS NULL`,
            )
            .get(recordId),
        );
        return {
          id: row.id as string,
          recordIds: visibleRecordIds,
          kind: row.kind as string,
          content: row.content as string,
          ...(row.provider ? { provider: row.provider as string } : {}),
          ...(row.model ? { model: row.model as string } : {}),
          provenance: JSON.parse(row.provenance_json as string) as Record<
            string,
            unknown
          >,
          createdAt: row.created_at as string,
        };
      }),
    };
  }

  async getAppliedConfig(): Promise<AppliedConfig | undefined> {
    const row = this.database
      .prepare("SELECT config_json, content_hash, applied_at FROM applied_config WHERE id=1")
      .get() as
      | { config_json: string; content_hash: string; applied_at: string }
      | undefined;
    return row
      ? {
          config: JSON.parse(row.config_json) as unknown,
          contentHash: row.content_hash,
          appliedAt: row.applied_at,
        }
      : undefined;
  }

  async applyConfig(snapshot: AppliedConfig): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO applied_config(id,config_json,content_hash,applied_at)
           VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET
           config_json=excluded.config_json,content_hash=excluded.content_hash,
           applied_at=excluded.applied_at`,
        )
        .run(
          JSON.stringify(snapshot.config),
          snapshot.contentHash,
          snapshot.appliedAt,
        );
    })();
  }

  async createDiagnosticWatch(input: CreateDiagnosticWatchInput): Promise<boolean> {
    return this.database.transaction(() => {
      const expiresAt =
        input.expiresAt ??
        new Date(new Date(input.createdAt).getTime() + 15 * 60_000).toISOString();
      const created = this.database.prepare("INSERT INTO diagnostic_watches(id,target_id,source,target_json,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(input.id, input.targetId, input.source, JSON.stringify(input.target), input.status, input.createdAt, input.updatedAt, expiresAt).changes === 1;
      if (!created) return false;
      const queued = this.database.prepare("INSERT INTO jobs(id,target_id,source,status,attempt,run_at,lease_owner,lease_token,lease_expires_at,error) VALUES(?,?,?,?,?,?,?,?,?,?)").run(input.job.id, input.job.targetId, input.job.source, input.job.status, input.job.attempt, input.job.runAt, null, null, null, null).changes === 1;
      if (!queued) throw new Error("Diagnostic watch job could not be enqueued.");
      return true;
    })();
  }
  async getDiagnosticWatch(targetId: string): Promise<DiagnosticWatch | undefined> {
    const row = this.database.prepare("SELECT * FROM diagnostic_watches WHERE target_id=?").get(targetId) as { id: string; target_id: string; source: string; target_json: string; status: string; created_at: string; updated_at: string; expires_at: string } | undefined;
    return row ? { id: row.id, targetId: row.target_id, source: row.source as DiagnosticWatch["source"], target: JSON.parse(row.target_json) as Record<string, unknown>, status: row.status as DiagnosticWatch["status"], createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at } : undefined;
  }
  async queryDiagnosticRecords(targetId: string): Promise<RecordEnvelope[]> {
    const rows = this.database
      .prepare(
        `SELECT records.* FROM records
         JOIN diagnostic_watches
           ON diagnostic_watches.target_id = records.target_id
         WHERE records.target_id=?
         ORDER BY records.ingested_at DESC, records.id`,
      )
      .all(targetId) as RecordRow[];
    return rows.map(mapRecord);
  }
  async commitDiagnosticIngestion(
    input: IngestionCommit & {
      jobId: string;
      leaseOwner: string;
      leaseToken: string;
    },
  ): Promise<IngestionCommitResult | undefined> {
    return this.database.transaction(() => {
      const leased = this.database
        .prepare(
          `SELECT 1 FROM jobs WHERE id=? AND target_id=? AND status='running'
           AND lease_owner=? AND lease_token=?`,
        )
        .get(
          input.jobId,
          input.targetId,
          input.leaseOwner,
          input.leaseToken,
        );
      if (!leased) return undefined;
      const watch = this.database
        .prepare(
          "SELECT status FROM diagnostic_watches WHERE target_id=? AND expires_at>?",
        )
        .get(input.targetId, new Date().toISOString()) as
        | { status: string }
        | undefined;
      if (watch?.status !== "active") {
        this.database
          .prepare(
            `UPDATE jobs SET status='complete',error='diagnostic cancelled',
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
             WHERE id=? AND target_id=? AND status='running'
             AND lease_owner=? AND lease_token=?`,
          )
          .run(
            input.jobId,
            input.targetId,
            input.leaseOwner,
            input.leaseToken,
          );
        return undefined;
      }
      const result: IngestionCommitResult = {
        inserted: 0,
        revised: 0,
        duplicates: 0,
      };
      for (const record of input.records) {
        const write = this.upsertRecordSync(record);
        if (write.created) result.inserted += 1;
        else if (write.revision) result.revised += 1;
        else result.duplicates += 1;
      }
      this.database
        .prepare(
          `INSERT INTO checkpoints(target_id,value_json,updated_at)
           VALUES(?,?,?) ON CONFLICT(target_id) DO UPDATE SET
           value_json=excluded.value_json,updated_at=excluded.updated_at`,
        )
        .run(
          input.targetId,
          JSON.stringify(input.checkpoint),
          new Date().toISOString(),
        );
      this.database
        .prepare(
          `UPDATE jobs SET status='complete',error=NULL,lease_owner=NULL,
           lease_token=NULL,lease_expires_at=NULL
           WHERE id=? AND target_id=? AND status='running'
           AND lease_owner=? AND lease_token=?`,
        )
        .run(
          input.jobId,
          input.targetId,
          input.leaseOwner,
          input.leaseToken,
        );
      this.database
        .prepare(
          "UPDATE diagnostic_watches SET status='complete',updated_at=? WHERE target_id=? AND status='active'",
        )
        .run(new Date().toISOString(), input.targetId);
      return result;
    })();
  }
  async cancelDiagnosticWatch(targetId: string): Promise<void> { this.database.transaction(() => { this.database.prepare("UPDATE diagnostic_watches SET status='cancelled',updated_at=? WHERE target_id=? AND status='active'").run(new Date().toISOString(), targetId); this.database.prepare("UPDATE jobs SET status='complete',error='diagnostic cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE target_id=? AND status IN ('queued','running')").run(targetId); })(); }
  async cleanupDiagnosticWatch(targetId: string): Promise<void> {
    this.database.transaction(() => {
      this.cleanupDiagnosticWatchSync(targetId);
    })();
  }

  private cleanupDiagnosticWatchSync(targetId: string): void {
    const diagnosticRecordIds = new Set(
      (
        this.database
          .prepare("SELECT id FROM records WHERE target_id=?")
          .all(targetId) as Array<{ id: string }>
      ).map(({ id }) => id),
    );
    if (diagnosticRecordIds.size > 0) {
      const artifacts = this.database
        .prepare("SELECT id, record_ids_json FROM artifacts")
        .all() as Array<{ id: string; record_ids_json: string }>;
      const removeArtifact = this.database.prepare(
        "DELETE FROM artifacts WHERE id=?",
      );
      const updateArtifact = this.database.prepare(
        "UPDATE artifacts SET record_ids_json=? WHERE id=?",
      );
      for (const artifact of artifacts) {
        const recordIds = JSON.parse(artifact.record_ids_json) as string[];
        const remaining = recordIds.filter(
          (recordId) => !diagnosticRecordIds.has(recordId),
        );
        if (remaining.length === 0 && remaining.length !== recordIds.length) {
          removeArtifact.run(artifact.id);
        } else if (remaining.length !== recordIds.length) {
          updateArtifact.run(JSON.stringify(remaining), artifact.id);
        }
      }
    }
    this.database.prepare("DELETE FROM records WHERE target_id=?").run(targetId);
    this.database.prepare("DELETE FROM checkpoints WHERE target_id=?").run(targetId);
    this.database.prepare("DELETE FROM jobs WHERE target_id=?").run(targetId);
    this.database.prepare("DELETE FROM diagnostic_watches WHERE target_id=?").run(targetId);
  }

  async reapExpiredDiagnosticWatches(
    now = new Date().toISOString(),
  ): Promise<number> {
    return this.database.transaction(() => {
      const expired = this.database
        .prepare("SELECT target_id FROM diagnostic_watches WHERE expires_at<=?")
        .all(now) as Array<{ target_id: string }>;
      for (const { target_id: targetId } of expired) {
        this.database
          .prepare(
            `UPDATE jobs SET status='complete',error='diagnostic expired',
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
             WHERE target_id=? AND status IN ('queued','running')`,
          )
          .run(targetId);
        this.cleanupDiagnosticWatchSync(targetId);
      }
      return expired.length;
    })();
  }
}
