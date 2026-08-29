import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  AppliedConfig, ConversationSnapshot, ConversationSnapshotItem, ConversationTracking,
  CreateDiagnosticWatchInput, DerivedArtifact, DiagnosticWatch, Engagement,
  IngestionCommit, IngestionCommitResult, IngestionRecord, Job, Page,
  QueryArtifactsInput, QueryRecordsInput, RecordDetail, RecordEnvelope,
  RecordRevision, SourceItem, StorageRepository,
} from "@argus/contracts";
import { decodeRecordsCursor, encodeRecordsCursor, escapeSubstringPattern } from "@argus/contracts";
import { Pool, type PoolClient } from "pg";

type Row = Record<string, unknown>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const digest = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex");
const engagementFields = ["likes", "replies", "reposts", "quotes", "views", "bookmarks"] as const;

const mapRecord = (row: Row): RecordEnvelope => ({
  id: row.id as string, source: row.source as RecordEnvelope["source"],
  externalId: row.external_id as string, url: row.url as string,
  ...(row.title == null ? {} : { title: row.title as string }), text: row.text as string,
  ...(row.author == null ? {} : { author: row.author as string }),
  ...(row.published_at == null ? {} : { publishedAt: iso(row.published_at) }),
  raw: json(row.raw_json),
  ...(row.metadata_json == null ? {} : { metadata: json<Record<string, unknown>>(row.metadata_json) }),
  contentHash: row.content_hash as string, firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at),
});

const sourceSnapshot = (record: IngestionRecord): SourceItem => ({
  externalId: record.externalId, url: record.url,
  ...(record.title === undefined ? {} : { title: record.title }), text: record.text,
  ...(record.author === undefined ? {} : { author: record.author }),
  ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
  ...(record.media === undefined ? {} : { media: record.media }),
  ...(record.relations === undefined ? {} : { relations: record.relations }),
  ...(record.engagement === undefined ? {} : { engagement: record.engagement }),
  raw: record.raw, ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
});

const mapJob = (row: Row): Job => ({
  id: row.id as string, targetId: row.target_id as string, source: row.source as Job["source"],
  status: row.status as Job["status"], attempt: row.attempt as number, runAt: iso(row.run_at),
  ...(row.lease_owner == null ? {} : { leaseOwner: row.lease_owner as string }),
  ...(row.lease_token == null ? {} : { leaseToken: row.lease_token as string }),
  ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: iso(row.lease_expires_at) }),
  ...(row.error == null ? {} : { error: row.error as string }),
});

export class IncompatibleStorageSchemaError extends Error {
  readonly code = "STORAGE_SCHEMA_INCOMPATIBLE";
  constructor(version: number | "unversioned") {
    super(`Argus database schema version ${version} is incompatible with schema version 2; reset the database and re-onboard.`);
    this.name = "IncompatibleStorageSchemaError";
  }
}

export class PostgresRepository implements StorageRepository {
  constructor(private readonly pool: Pool) {}

  async migrate(migrationFile = fileURLToPath(new URL("../drizzle/0000_schema_v2.sql", import.meta.url))): Promise<void> {
    const client = await this.pool.connect();
    try {
      const tables = (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(({ table_name }) => table_name);
      if (tables.includes("schema_meta")) {
        const version = (await client.query<{ version: number }>("SELECT version FROM schema_meta WHERE id=1")).rows[0]?.version;
        if (version !== 2) throw new IncompatibleStorageSchemaError(version ?? "unversioned");
        return;
      }
      if (tables.length) throw new IncompatibleStorageSchemaError("unversioned");
      await client.query("BEGIN");
      await client.query(
        (await readFile(migrationFile, "utf8"))
          .replaceAll("--> statement-breakpoint", "")
          .replaceAll('"public".', ""),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async upsertRecord(record: IngestionRecord): Promise<{ record: RecordEnvelope; revision?: RecordRevision; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.upsertRecordClient(client, record);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async upsertRecordClient(client: PoolClient, record: IngestionRecord): Promise<{ record: RecordEnvelope; revision?: RecordRevision; created: boolean }> {
    const current = (await client.query<Row>("SELECT * FROM records WHERE id=$1 FOR UPDATE", [record.id])).rows[0];
    const created = current === undefined;
    const changed = current?.content_hash !== record.contentHash;
    await client.query(`INSERT INTO records(id,source,external_id,url,title,text,author,published_at,raw_json,metadata_json,content_hash,first_seen_at,last_seen_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET url=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.url ELSE records.url END,
      title=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.title ELSE records.title END,
      text=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.text ELSE records.text END,
      author=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.author ELSE records.author END,
      published_at=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.published_at ELSE records.published_at END,
      raw_json=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.raw_json ELSE records.raw_json END,
      metadata_json=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.metadata_json ELSE records.metadata_json END,
      content_hash=CASE WHEN records.content_hash<>excluded.content_hash THEN excluded.content_hash ELSE records.content_hash END,
      last_seen_at=excluded.last_seen_at`, [record.id, record.source, record.externalId, record.url, record.title ?? null, record.text, record.author ?? null, record.publishedAt ?? null, record.raw, record.metadata ?? null, record.contentHash, current ? iso(current.first_seen_at) : record.firstSeenAt, record.lastSeenAt]);
    let revision: RecordRevision | undefined;
    if (changed) {
      revision = { id: randomUUID(), recordId: record.id, contentHash: record.contentHash, snapshot: sourceSnapshot(record), createdAt: record.lastSeenAt };
      await client.query("INSERT INTO record_revisions(id,record_id,content_hash,snapshot_json,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [revision.id, revision.recordId, revision.contentHash, revision.snapshot, revision.createdAt]);
    }
    for (const watchId of record.watchIds) await client.query(`INSERT INTO record_watches(record_id,watch_id,target_id,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(record_id,watch_id,target_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`, [record.id, watchId, record.targetId, record.firstSeenAt, record.lastSeenAt]);
    const mediaIds: string[] = [];
    for (const [position, media] of (record.media ?? []).entries()) {
      const id = digest(record.id, media.sourceMediaId ?? "", media.kind, media.url); mediaIds.push(id);
      await client.query(`INSERT INTO media_assets(id,record_id,source_media_id,kind,url,preview_url,mime_type,width,height,duration_ms,alt_text,position,metadata_json,first_seen_at,last_seen_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO UPDATE SET position=excluded.position,url=excluded.url,preview_url=excluded.preview_url,mime_type=excluded.mime_type,width=excluded.width,height=excluded.height,duration_ms=excluded.duration_ms,alt_text=excluded.alt_text,metadata_json=excluded.metadata_json,last_seen_at=excluded.last_seen_at`, [id, record.id, media.sourceMediaId ?? null, media.kind, media.url, media.previewUrl ?? null, media.mimeType ?? null, media.width ?? null, media.height ?? null, media.durationMs ?? null, media.altText ?? null, position, media.metadata ?? null, record.firstSeenAt, record.lastSeenAt]);
    }
    await client.query("DELETE FROM media_assets WHERE record_id=$1 AND NOT(id=ANY($2::text[]))", [record.id, mediaIds]);
    const relationIds: string[] = [];
    for (const relation of record.relations ?? []) {
      const id = digest(record.id, relation.kind, relation.objectSource, relation.objectExternalId); relationIds.push(id);
      const objectId = (await client.query<{ id: string }>("SELECT id FROM records WHERE source=$1 AND external_id=$2", [relation.objectSource, relation.objectExternalId])).rows[0]?.id ?? null;
      await client.query(`INSERT INTO record_relations(id,subject_record_id,kind,object_source,object_external_id,object_record_id,object_url,metadata_json,first_seen_at,last_seen_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET object_record_id=excluded.object_record_id,object_url=excluded.object_url,metadata_json=excluded.metadata_json,last_seen_at=excluded.last_seen_at`, [id, record.id, relation.kind, relation.objectSource, relation.objectExternalId, objectId, relation.objectUrl ?? null, relation.metadata ?? null, record.firstSeenAt, record.lastSeenAt]);
    }
    await client.query("DELETE FROM record_relations WHERE subject_record_id=$1 AND NOT(id=ANY($2::text[]))", [record.id, relationIds]);
    await client.query("UPDATE record_relations SET object_record_id=$1 WHERE object_source=$2 AND object_external_id=$3 AND object_record_id IS NULL", [record.id, record.source, record.externalId]);
    if (record.engagement) {
      const previous = (await client.query<Row>("SELECT * FROM engagement_snapshots WHERE record_id=$1 ORDER BY collected_at DESC,id DESC LIMIT 1", [record.id])).rows[0];
      const changedEngagement = !previous || engagementFields.some((field) => previous[field] !== (record.engagement as Engagement)[field]);
      if (changedEngagement) await client.query("INSERT INTO engagement_snapshots(id,record_id,likes,replies,reposts,quotes,views,bookmarks,collected_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), record.id, record.engagement.likes ?? null, record.engagement.replies ?? null, record.engagement.reposts ?? null, record.engagement.quotes ?? null, record.engagement.views ?? null, record.engagement.bookmarks ?? null, record.lastSeenAt]);
    }
    const stored = (await client.query<Row>("SELECT * FROM records WHERE id=$1", [record.id])).rows[0];
    if (!stored) throw new Error("Stored record disappeared");
    return { record: mapRecord(stored), ...(revision ? { revision } : {}), created };
  }

  private async commitRecords(client: PoolClient, records: IngestionRecord[]): Promise<IngestionCommitResult> {
    const result: IngestionCommitResult = { inserted: 0, revised: 0, duplicates: 0 };
    for (const record of records) { const write = await this.upsertRecordClient(client, record); if (write.created) result.inserted++; else if (write.revision) result.revised++; else result.duplicates++; }
    return result;
  }

  async commitIngestion(input: IngestionCommit): Promise<IngestionCommitResult> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await this.commitRecords(client, input.records); await client.query(`INSERT INTO checkpoints(target_id,value_json,updated_at) VALUES($1,$2,now()) ON CONFLICT(target_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, [input.targetId, input.checkpoint]); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async listRevisions(recordId: string): Promise<Page<RecordRevision>> {
    const rows = (await this.pool.query<Row>("SELECT * FROM record_revisions WHERE record_id=$1 ORDER BY created_at,id", [recordId])).rows;
    return { items: rows.map((row) => ({ id: row.id as string, recordId: row.record_id as string, contentHash: row.content_hash as string, snapshot: json<SourceItem>(row.snapshot_json), createdAt: iso(row.created_at) })) };
  }

  async getRecord(id: string): Promise<RecordDetail | undefined> {
    const row = (await this.pool.query<Row>("SELECT * FROM records WHERE id=$1", [id])).rows[0];
    if (!row) return undefined;
    const watches = (await this.pool.query<Row>("SELECT * FROM record_watches WHERE record_id=$1 ORDER BY watch_id,target_id", [id])).rows.map((item) => ({ recordId: item.record_id as string, watchId: item.watch_id as string, targetId: item.target_id as string, firstSeenAt: iso(item.first_seen_at), lastSeenAt: iso(item.last_seen_at) }));
    const media = (await this.pool.query<Row>("SELECT * FROM media_assets WHERE record_id=$1 ORDER BY position", [id])).rows.map((item) => ({
      id: item.id as string, recordId: item.record_id as string, kind: item.kind as RecordDetail["media"][number]["kind"], url: item.url as string,
      position: item.position as number, firstSeenAt: iso(item.first_seen_at), lastSeenAt: iso(item.last_seen_at),
      ...(item.source_media_id == null ? {} : { sourceMediaId: item.source_media_id as string }),
      ...(item.preview_url == null ? {} : { previewUrl: item.preview_url as string }),
      ...(item.mime_type == null ? {} : { mimeType: item.mime_type as string }),
      ...(item.width == null ? {} : { width: item.width as number }), ...(item.height == null ? {} : { height: item.height as number }),
      ...(item.duration_ms == null ? {} : { durationMs: item.duration_ms as number }), ...(item.alt_text == null ? {} : { altText: item.alt_text as string }),
      ...(item.metadata_json == null ? {} : { metadata: json<Record<string, unknown>>(item.metadata_json) }),
    }));
    const relations = (await this.pool.query<Row>("SELECT * FROM record_relations WHERE subject_record_id=$1 ORDER BY first_seen_at,id", [id])).rows.map((item) => ({
      id: item.id as string, subjectRecordId: item.subject_record_id as string,
      kind: item.kind as RecordDetail["relations"][number]["kind"], objectSource: item.object_source as RecordDetail["relations"][number]["objectSource"],
      objectExternalId: item.object_external_id as string, firstSeenAt: iso(item.first_seen_at), lastSeenAt: iso(item.last_seen_at),
      ...(item.object_record_id == null ? {} : { objectRecordId: item.object_record_id as string }), ...(item.object_url == null ? {} : { objectUrl: item.object_url as string }),
      ...(item.metadata_json == null ? {} : { metadata: json<Record<string, unknown>>(item.metadata_json) }),
    }));
    const engagement = (await this.pool.query<Row>("SELECT * FROM engagement_snapshots WHERE record_id=$1 ORDER BY collected_at DESC,id DESC LIMIT 1", [id])).rows[0];
    const latestEngagement = engagement ? { id: engagement.id as string, recordId: engagement.record_id as string, collectedAt: iso(engagement.collected_at), ...Object.fromEntries(engagementFields.flatMap((field) => engagement[field] == null ? [] : [[field, engagement[field]]])) } : undefined;
    return { ...mapRecord(row), watches, media, relations, ...(latestEngagement ? { latestEngagement } : {}) } as RecordDetail;
  }

  async queryRecords(input: QueryRecordsInput): Promise<Page<RecordEnvelope>> {
    const values: unknown[] = [];
    const bind = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    const watchClauses = ["rw.record_id=records.id", "NOT EXISTS (SELECT 1 FROM diagnostic_watches dw WHERE dw.target_id=rw.target_id)"];
    if (input.targetIds?.length) watchClauses.push(`rw.target_id=ANY(${bind(input.targetIds)}::text[])`);
    if (input.watchIds?.length) watchClauses.push(`rw.watch_id=ANY(${bind(input.watchIds)}::text[])`);
    const clauses = [`EXISTS (SELECT 1 FROM record_watches rw WHERE ${watchClauses.join(" AND ")})`];
    if (input.sources?.length) clauses.push(`source=ANY(${bind(input.sources)}::text[])`);
    if (input.text) { const pattern = `%${escapeSubstringPattern(input.text)}%`; clauses.push(`(title ILIKE ${bind(pattern)} ESCAPE '\\' OR text ILIKE ${bind(pattern)} ESCAPE '\\')`); }
    if (input.since) clauses.push(`last_seen_at>=${bind(input.since)}`);
    if (input.until) clauses.push(`last_seen_at<=${bind(input.until)}`);
    const cursor = decodeRecordsCursor(input.cursor);
    if (cursor) { const seen = bind(cursor.lastSeenAt); const id = bind(cursor.id); clauses.push(`(last_seen_at<${seen} OR (last_seen_at=${seen} AND id>${id}))`); }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const result = await this.pool.query<Row>(`SELECT * FROM records WHERE ${clauses.join(" AND ")} ORDER BY last_seen_at DESC,id ASC LIMIT ${bind(limit + 1)}`, values);
    const items = result.rows.slice(0, limit).map(mapRecord); const last = items.at(-1);
    return { items, ...(result.rows.length > limit && last ? { nextCursor: encodeRecordsCursor(last) } : {}) };
  }

  async getCheckpoint<T>(targetId: string): Promise<T | undefined> { const row = (await this.pool.query<Row>("SELECT value_json FROM checkpoints WHERE target_id=$1", [targetId])).rows[0]; return row ? json<T>(row.value_json) : undefined; }
  async setCheckpoint<T>(targetId: string, checkpoint: T): Promise<void> { await this.pool.query("INSERT INTO checkpoints(target_id,value_json,updated_at) VALUES($1,$2,now()) ON CONFLICT(target_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", [targetId, checkpoint]); }

  async upsertConversationTracking(value: ConversationTracking): Promise<void> {
    await this.pool.query(`INSERT INTO conversation_tracking(root_record_id,watch_id,status,order_by,max_per_post,max_tracking_hours,published_at,next_run_at,stops_at,last_observed_replies,burst_until,last_error,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(root_record_id) DO UPDATE SET watch_id=excluded.watch_id,status=excluded.status,order_by=excluded.order_by,max_per_post=excluded.max_per_post,max_tracking_hours=excluded.max_tracking_hours,published_at=excluded.published_at,next_run_at=excluded.next_run_at,stops_at=excluded.stops_at,last_observed_replies=excluded.last_observed_replies,burst_until=excluded.burst_until,last_error=excluded.last_error,updated_at=excluded.updated_at`, [value.rootRecordId, value.watchId, value.status, value.orderBy, value.maxPerPost, value.maxTrackingHours, value.publishedAt, value.nextRunAt ?? null, value.stopsAt, value.lastObservedReplies ?? null, value.burstUntil ?? null, value.lastError ?? null, value.updatedAt]);
  }
  async getConversationTracking(rootRecordId: string): Promise<ConversationTracking | undefined> {
    const row = (await this.pool.query<Row>("SELECT * FROM conversation_tracking WHERE root_record_id=$1", [rootRecordId])).rows[0];
    return row ? { rootRecordId: row.root_record_id as string, watchId: row.watch_id as string, status: row.status as ConversationTracking["status"], orderBy: row.order_by as ConversationTracking["orderBy"], maxPerPost: row.max_per_post as number, maxTrackingHours: row.max_tracking_hours as number, publishedAt: iso(row.published_at), ...(row.next_run_at == null ? {} : { nextRunAt: iso(row.next_run_at) }), stopsAt: iso(row.stops_at), ...(row.last_observed_replies == null ? {} : { lastObservedReplies: row.last_observed_replies as number }), ...(row.burst_until == null ? {} : { burstUntil: iso(row.burst_until) }), ...(row.last_error == null ? {} : { lastError: row.last_error as string }), updatedAt: iso(row.updated_at) } : undefined;
  }
  async listDueConversationTracking(now: string, limit: number): Promise<ConversationTracking[]> {
    const rows = (await this.pool.query<Row>("SELECT * FROM conversation_tracking WHERE status='active' AND next_run_at<=$1 ORDER BY next_run_at,root_record_id LIMIT $2", [now, Math.max(0, limit)])).rows;
    return rows.map((row) => ({ rootRecordId: row.root_record_id as string, watchId: row.watch_id as string, status: row.status as ConversationTracking["status"], orderBy: row.order_by as ConversationTracking["orderBy"], maxPerPost: row.max_per_post as number, maxTrackingHours: row.max_tracking_hours as number, publishedAt: iso(row.published_at), ...(row.next_run_at == null ? {} : { nextRunAt: iso(row.next_run_at) }), stopsAt: iso(row.stops_at), ...(row.last_observed_replies == null ? {} : { lastObservedReplies: row.last_observed_replies as number }), ...(row.burst_until == null ? {} : { burstUntil: iso(row.burst_until) }), ...(row.last_error == null ? {} : { lastError: row.last_error as string }), updatedAt: iso(row.updated_at) }));
  }
  async saveConversationSnapshot(input: { snapshot: ConversationSnapshot; items: ConversationSnapshotItem[] }): Promise<void> {
    const client = await this.pool.connect(); try { await client.query("BEGIN"); const s = input.snapshot; await client.query("INSERT INTO conversation_snapshots(id,root_record_id,observed_count,retained_count,order_by,pages_fetched,complete,truncated,truncation_reason,upstream_cursor,collected_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [s.id,s.rootRecordId,s.observedCount,s.retainedCount,s.orderBy,s.pagesFetched,s.complete,s.truncated,s.truncationReason ?? null,s.upstreamCursor ?? null,s.collectedAt]); for (const item of input.items) await client.query("INSERT INTO conversation_snapshot_items(snapshot_id,reply_record_id,rank,sort_value) VALUES($1,$2,$3,$4)", [item.snapshotId,item.replyRecordId,item.rank,item.sortValue ?? null]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async queryConversationSnapshots(rootRecordId: string): Promise<Page<ConversationSnapshot & { items: ConversationSnapshotItem[] }>> {
    const rows = (await this.pool.query<Row>("SELECT * FROM conversation_snapshots WHERE root_record_id=$1 ORDER BY collected_at DESC,id DESC", [rootRecordId])).rows; const result = [];
    for (const row of rows) { const members = (await this.pool.query<Row>("SELECT * FROM conversation_snapshot_items WHERE snapshot_id=$1 ORDER BY rank", [row.id])).rows; result.push({ id: row.id as string, rootRecordId: row.root_record_id as string, observedCount: row.observed_count as number, retainedCount: row.retained_count as number, orderBy: row.order_by as ConversationSnapshot["orderBy"], pagesFetched: row.pages_fetched as number, complete: row.complete as boolean, truncated: row.truncated as boolean, ...(row.truncation_reason == null ? {} : { truncationReason: row.truncation_reason as NonNullable<ConversationSnapshot["truncationReason"]> }), ...(row.upstream_cursor == null ? {} : { upstreamCursor: row.upstream_cursor as string }), collectedAt: iso(row.collected_at), items: members.map((item) => ({ snapshotId: item.snapshot_id as string, replyRecordId: item.reply_record_id as string, rank: item.rank as number, ...(item.sort_value == null ? {} : { sortValue: item.sort_value as number }) })) }); }
    return { items: result };
  }

  async enqueueJob(job: Job): Promise<boolean> { const result = await this.pool.query("INSERT INTO jobs(id,target_id,source,status,attempt,run_at,lease_owner,lease_token,lease_expires_at,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", [job.id,job.targetId,job.source,job.status,job.attempt,job.runAt,job.leaseOwner ?? null,job.leaseToken ?? null,job.leaseExpiresAt ?? null,job.error ?? null]); return result.rowCount === 1; }
  async claimJobs(owner: string, limit: number, leaseMs: number): Promise<Job[]> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("UPDATE jobs SET status='failed',error='worker lease expired',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE status='running' AND lease_expires_at<now() AND attempt>=5"); const candidates = await client.query<Row>("SELECT * FROM jobs WHERE (status='queued' AND run_at<=now()) OR (status='running' AND lease_expires_at<now() AND attempt<5) ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT $1", [limit]); const claimed = [];
      for (const candidate of candidates.rows) { const row = (await client.query<Row>("UPDATE jobs SET status='running',attempt=attempt+CASE WHEN status='running' THEN 1 ELSE 0 END,lease_owner=$2,lease_token=$3,lease_expires_at=now()+($4*interval '1 millisecond') WHERE id=$1 RETURNING *", [candidate.id,owner,randomUUID(),leaseMs])).rows[0]; if (row) claimed.push(mapJob(row)); }
      await client.query("COMMIT"); return claimed;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async completeJob(id: string, owner: string, leaseToken: string): Promise<boolean> { const result = await this.pool.query("UPDATE jobs SET status='complete',error=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3", [id,owner,leaseToken]); return result.rowCount === 1; }
  async failJob(id: string, owner: string, leaseToken: string, error: string, retryAt?: string): Promise<boolean> { const result = await this.pool.query("UPDATE jobs SET status=$2,error=$3,attempt=attempt+1,run_at=$4,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND status='running' AND lease_owner=$5 AND lease_token=$6", [id,retryAt ? "queued" : "failed",error,retryAt ?? new Date(),owner,leaseToken]); return result.rowCount === 1; }

  async saveArtifact(artifact: DerivedArtifact): Promise<void> {
    const client = await this.pool.connect(); try { await client.query("BEGIN"); await client.query(`INSERT INTO artifacts(id,kind,content,provider,model,provenance_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,content=excluded.content,provider=excluded.provider,model=excluded.model,provenance_json=excluded.provenance_json,created_at=excluded.created_at`, [artifact.id,artifact.kind,artifact.content,artifact.provider ?? null,artifact.model ?? null,artifact.provenance,artifact.createdAt]); await client.query("DELETE FROM artifact_records WHERE artifact_id=$1", [artifact.id]); await client.query("DELETE FROM artifact_media WHERE artifact_id=$1", [artifact.id]); for (const [position, recordId] of artifact.recordIds.entries()) await client.query("INSERT INTO artifact_records(artifact_id,record_id,position) VALUES($1,$2,$3)", [artifact.id,recordId,position]); for (const [position, media] of (artifact.media ?? []).entries()) await client.query("INSERT INTO artifact_media(artifact_id,media_asset_id,position,disposition) VALUES($1,$2,$3,$4)", [artifact.id,media.mediaAssetId,position,media.disposition]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async queryArtifacts(input: QueryArtifactsInput): Promise<Page<DerivedArtifact>> {
    const rows = (await this.pool.query<Row>(`SELECT * FROM artifacts ${input.kind ? "WHERE kind=$1" : ""} ORDER BY created_at DESC,id LIMIT $${input.kind ? 2 : 1}`, [...(input.kind ? [input.kind] : []), Math.min(Math.max(input.limit ?? 50,1),200)])).rows; const result: DerivedArtifact[] = [];
    for (const row of rows) { const recordIds = (await this.pool.query<{ record_id: string }>(`SELECT ar.record_id FROM artifact_records ar WHERE ar.artifact_id=$1 AND EXISTS(SELECT 1 FROM record_watches rw WHERE rw.record_id=ar.record_id AND NOT EXISTS(SELECT 1 FROM diagnostic_watches dw WHERE dw.target_id=rw.target_id)) ORDER BY ar.position`, [row.id])).rows.map(({record_id}) => record_id); if (!recordIds.length) continue; const media = (await this.pool.query<{ media_asset_id: string; disposition: string }>("SELECT media_asset_id,disposition FROM artifact_media WHERE artifact_id=$1 ORDER BY position", [row.id])).rows.map(({media_asset_id,disposition}) => ({mediaAssetId: media_asset_id,disposition})); result.push({ id: row.id as string,recordIds,media,kind: row.kind as string,content: row.content as string,...(row.provider == null ? {} : {provider: row.provider as string}),...(row.model == null ? {} : {model: row.model as string}),provenance: json(row.provenance_json),createdAt: iso(row.created_at) }); }
    return { items: result };
  }
  async getAppliedConfig(): Promise<AppliedConfig | undefined> { const row = (await this.pool.query<Row>("SELECT * FROM applied_config WHERE id=1")).rows[0]; return row ? { config: json(row.config_json), contentHash: row.content_hash as string, appliedAt: iso(row.applied_at) } : undefined; }
  async applyConfig(value: AppliedConfig): Promise<void> { await this.pool.query("INSERT INTO applied_config(id,config_json,content_hash,applied_at) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,content_hash=excluded.content_hash,applied_at=excluded.applied_at", [value.config,value.contentHash,value.appliedAt]); }

  async createDiagnosticWatch(input: CreateDiagnosticWatchInput): Promise<boolean> {
    const client = await this.pool.connect(); try { await client.query("BEGIN"); const expiresAt = input.expiresAt ?? new Date(new Date(input.createdAt).getTime()+15*60_000).toISOString(); const watch = await client.query("INSERT INTO diagnostic_watches(id,target_id,source,target_json,status,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [input.id,input.targetId,input.source,input.target,input.status,input.createdAt,input.updatedAt,expiresAt]); if (!watch.rowCount) { await client.query("ROLLBACK"); return false; } const job = await client.query("INSERT INTO jobs(id,target_id,source,status,attempt,run_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [input.job.id,input.job.targetId,input.job.source,input.job.status,input.job.attempt,input.job.runAt]); if (!job.rowCount) throw new Error("Diagnostic watch job could not be enqueued."); await client.query("COMMIT"); return true; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async getDiagnosticWatch(targetId: string): Promise<DiagnosticWatch | undefined> { const row = (await this.pool.query<Row>("SELECT * FROM diagnostic_watches WHERE target_id=$1", [targetId])).rows[0]; return row ? { id: row.id as string,targetId: row.target_id as string,source: row.source as DiagnosticWatch["source"],target: json(row.target_json),status: row.status as DiagnosticWatch["status"],createdAt: iso(row.created_at),updatedAt: iso(row.updated_at),expiresAt: iso(row.expires_at) } : undefined; }
  async queryDiagnosticRecords(targetId: string): Promise<RecordEnvelope[]> { return (await this.pool.query<Row>("SELECT DISTINCT records.* FROM records JOIN record_watches rw ON rw.record_id=records.id WHERE rw.target_id=$1 ORDER BY records.last_seen_at DESC,records.id", [targetId])).rows.map(mapRecord); }
  async commitDiagnosticIngestion(input: IngestionCommit & { jobId: string; leaseOwner: string; leaseToken: string }): Promise<IngestionCommitResult | undefined> {
    const client = await this.pool.connect(); try { await client.query("BEGIN"); const lease = (await client.query("SELECT 1 FROM jobs WHERE id=$1 AND target_id=$2 AND status='running' AND lease_owner=$3 AND lease_token=$4 FOR UPDATE", [input.jobId,input.targetId,input.leaseOwner,input.leaseToken])).rows[0]; if (!lease) { await client.query("COMMIT"); return undefined; } const watch = (await client.query<Row>("SELECT status FROM diagnostic_watches WHERE target_id=$1 AND expires_at>now() FOR UPDATE", [input.targetId])).rows[0]; if (watch?.status !== "active") { await client.query("UPDATE jobs SET status='complete',error='diagnostic cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [input.jobId]); await client.query("COMMIT"); return undefined; } const result = await this.commitRecords(client,input.records); await client.query("INSERT INTO checkpoints(target_id,value_json,updated_at) VALUES($1,$2,now()) ON CONFLICT(target_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", [input.targetId,input.checkpoint]); await client.query("UPDATE jobs SET status='complete',error=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [input.jobId]); await client.query("UPDATE diagnostic_watches SET status='complete',updated_at=now() WHERE target_id=$1", [input.targetId]); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async cancelDiagnosticWatch(targetId: string): Promise<void> { const client = await this.pool.connect(); try { await client.query("BEGIN"); await client.query("UPDATE diagnostic_watches SET status='cancelled',updated_at=now() WHERE target_id=$1 AND status='active'", [targetId]); await client.query("UPDATE jobs SET status='complete',error='diagnostic cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE target_id=$1 AND status IN ('queued','running')", [targetId]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
  private async cleanupDiagnosticClient(client: PoolClient,targetId: string): Promise<void> { const affected = (await client.query<{record_id:string}>("SELECT record_id FROM record_watches WHERE target_id=$1", [targetId])).rows.map(({record_id}) => record_id); await client.query("DELETE FROM record_watches WHERE target_id=$1", [targetId]); for (const id of affected) await client.query("DELETE FROM records WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM record_watches WHERE record_id=$1)", [id]); await client.query("DELETE FROM checkpoints WHERE target_id=$1", [targetId]); await client.query("DELETE FROM jobs WHERE target_id=$1", [targetId]); await client.query("DELETE FROM diagnostic_watches WHERE target_id=$1", [targetId]); }
  async cleanupDiagnosticWatch(targetId: string): Promise<void> { const client = await this.pool.connect(); try { await client.query("BEGIN"); await this.cleanupDiagnosticClient(client,targetId); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
  async reapExpiredDiagnosticWatches(now=new Date().toISOString()): Promise<number> { const client = await this.pool.connect(); try { await client.query("BEGIN"); const expired = await client.query<{target_id:string}>("SELECT target_id FROM diagnostic_watches WHERE expires_at<=$1 FOR UPDATE", [now]); for (const {target_id} of expired.rows) await this.cleanupDiagnosticClient(client,target_id); await client.query("COMMIT"); return expired.rows.length; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
}

export const createPool = (connectionString: string): Pool => new Pool({ connectionString });
