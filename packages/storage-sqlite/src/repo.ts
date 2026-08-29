import { createHash, randomUUID } from "node:crypto";
import type {
  AppliedConfig, ConversationSnapshot, ConversationSnapshotItem,
  ConversationTracking, CreateDiagnosticWatchInput, DerivedArtifact,
  DiagnosticWatch, Engagement, IngestionCommit, IngestionCommitResult,
  IngestionRecord, Job, Page, QueryArtifactsInput, QueryRecordsInput,
  RecordDetail, RecordEnvelope, RecordRevision, SourceItem, StorageRepository,
} from "@argus/contracts";
import { decodeRecordsCursor, encodeRecordsCursor, escapeSubstringPattern } from "@argus/contracts";
import type { SQLWrapper } from "drizzle-orm";
import { and, asc, desc, eq, exists, inArray, isNull, lt, lte, notExists, notInArray, or, sql } from "drizzle-orm";
import type { SqliteConnection } from "./db.js";
import {
  appliedConfig, artifactMedia, artifactRecords, artifacts, checkpoints,
  conversationSnapshotItems, conversationSnapshots, conversationTracking,
  diagnosticWatches, engagementSnapshots, jobs, mediaAssets, recordRelations,
  recordRevisions, records, recordWatches,
} from "./schema.js";

type Orm = SqliteConnection["orm"];
type Transaction = Parameters<Parameters<Orm["transaction"]>[0]>[0];
type RecordRow = typeof records.$inferSelect;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value === null ? undefined : (value as Record<string, unknown>);

const mapRecord = (row: RecordRow): RecordEnvelope => ({
  id: row.id,
  source: row.source as RecordEnvelope["source"],
  externalId: row.externalId,
  url: row.url,
  ...(row.title === null ? {} : { title: row.title }),
  text: row.text,
  ...(row.author === null ? {} : { author: row.author }),
  ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt }),
  raw: row.raw,
  ...(row.metadata === null ? {} : { metadata: row.metadata as Record<string, unknown> }),
  contentHash: row.contentHash,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
});

const sourceSnapshot = (record: IngestionRecord): SourceItem => ({
  externalId: record.externalId,
  url: record.url,
  ...(record.title === undefined ? {} : { title: record.title }),
  text: record.text,
  ...(record.author === undefined ? {} : { author: record.author }),
  ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
  ...(record.media === undefined ? {} : { media: record.media }),
  ...(record.relations === undefined ? {} : { relations: record.relations }),
  ...(record.engagement === undefined ? {} : { engagement: record.engagement }),
  raw: record.raw,
  ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
});

const digest = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\0")).digest("hex");

const engagementFields = ["likes", "replies", "reposts", "quotes", "views", "bookmarks"] as const;
const engagementChanged = (previous: typeof engagementSnapshots.$inferSelect | undefined, current: Engagement): boolean =>
  !previous || engagementFields.some((field) => (previous[field] ?? undefined) !== current[field]);

const mapJob = (row: typeof jobs.$inferSelect): Job => ({
  id: row.id, targetId: row.targetId, source: row.source as Job["source"],
  status: row.status as Job["status"], attempt: row.attempt, runAt: row.runAt,
  ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
  ...(row.leaseToken === null ? {} : { leaseToken: row.leaseToken }),
  ...(row.leaseExpiresAt === null ? {} : { leaseExpiresAt: row.leaseExpiresAt }),
  ...(row.error === null ? {} : { error: row.error }),
});

const mapTracking = (row: typeof conversationTracking.$inferSelect): ConversationTracking => ({
  rootRecordId: row.rootRecordId, watchId: row.watchId,
  status: row.status as ConversationTracking["status"],
  orderBy: row.orderBy as ConversationTracking["orderBy"],
  maxPerPost: row.maxPerPost, maxTrackingHours: row.maxTrackingHours,
  publishedAt: row.publishedAt,
  ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
  stopsAt: row.stopsAt,
  ...(row.lastObservedReplies === null ? {} : { lastObservedReplies: row.lastObservedReplies }),
  ...(row.burstUntil === null ? {} : { burstUntil: row.burstUntil }),
  ...(row.lastError === null ? {} : { lastError: row.lastError }),
  updatedAt: row.updatedAt,
});

export class SqliteRepository implements StorageRepository {
  private readonly database: SqliteConnection["database"];
  private readonly orm: Orm;

  constructor(connection: SqliteConnection) {
    this.database = connection.database;
    this.orm = connection.orm;
  }

  close(): void { this.database.close(); }

  async upsertRecord(record: IngestionRecord): Promise<{ record: RecordEnvelope; revision?: RecordRevision; created: boolean }> {
    return this.orm.transaction((tx) => this.upsertRecordTx(tx, record));
  }

  private upsertRecordTx(tx: Transaction, record: IngestionRecord): { record: RecordEnvelope; revision?: RecordRevision; created: boolean } {
    const current = tx.select().from(records).where(eq(records.id, record.id)).get();
    const created = current === undefined;
    const changed = current?.contentHash !== record.contentHash;
    const canonical = {
      id: record.id, source: record.source, externalId: record.externalId,
      url: record.url, title: record.title ?? null, text: record.text,
      author: record.author ?? null, publishedAt: record.publishedAt ?? null,
      raw: record.raw, metadata: record.metadata ?? null,
      contentHash: record.contentHash,
      firstSeenAt: current?.firstSeenAt ?? record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
    };
    if (created) tx.insert(records).values(canonical).run();
    else tx.update(records).set(changed ? canonical : { lastSeenAt: record.lastSeenAt }).where(eq(records.id, record.id)).run();

    let revision: RecordRevision | undefined;
    if (changed) {
      revision = { id: randomUUID(), recordId: record.id, contentHash: record.contentHash, snapshot: sourceSnapshot(record), createdAt: record.lastSeenAt };
      tx.insert(recordRevisions).values(revision).onConflictDoNothing().run();
    }

    for (const watchId of record.watchIds) {
      tx.insert(recordWatches).values({ recordId: record.id, watchId, targetId: record.targetId, firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt })
        .onConflictDoUpdate({ target: [recordWatches.recordId, recordWatches.watchId, recordWatches.targetId], set: { lastSeenAt: record.lastSeenAt } }).run();
    }

    const mediaIds = (record.media ?? []).map((media, position) => {
      const id = digest(record.id, media.sourceMediaId ?? "", media.kind, media.url);
      tx.insert(mediaAssets).values({
        id, recordId: record.id, sourceMediaId: media.sourceMediaId ?? null,
        kind: media.kind, url: media.url, previewUrl: media.previewUrl ?? null,
        mimeType: media.mimeType ?? null, width: media.width ?? null,
        height: media.height ?? null, durationMs: media.durationMs ?? null,
        altText: media.altText ?? null, position, metadata: media.metadata ?? null,
        firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt,
      }).onConflictDoUpdate({ target: mediaAssets.id, set: {
        position, url: media.url, previewUrl: media.previewUrl ?? null,
        mimeType: media.mimeType ?? null, width: media.width ?? null,
        height: media.height ?? null, durationMs: media.durationMs ?? null,
        altText: media.altText ?? null, metadata: media.metadata ?? null,
        lastSeenAt: record.lastSeenAt,
      } }).run();
      return id;
    });
    const mediaCondition = eq(mediaAssets.recordId, record.id);
    tx.delete(mediaAssets).where(mediaIds.length ? and(mediaCondition, notInArray(mediaAssets.id, mediaIds)) : mediaCondition).run();

    const relationIds = (record.relations ?? []).map((relation) => {
      const id = digest(record.id, relation.kind, relation.objectSource, relation.objectExternalId);
      const object = tx.select({ id: records.id }).from(records)
        .where(and(eq(records.source, relation.objectSource), eq(records.externalId, relation.objectExternalId))).get();
      tx.insert(recordRelations).values({
        id, subjectRecordId: record.id, kind: relation.kind,
        objectSource: relation.objectSource, objectExternalId: relation.objectExternalId,
        objectRecordId: object?.id ?? null, objectUrl: relation.objectUrl ?? null,
        metadata: relation.metadata ?? null, firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
      }).onConflictDoUpdate({ target: recordRelations.id, set: {
        objectRecordId: object?.id ?? null, objectUrl: relation.objectUrl ?? null,
        metadata: relation.metadata ?? null, lastSeenAt: record.lastSeenAt,
      } }).run();
      return id;
    });
    const relationCondition = eq(recordRelations.subjectRecordId, record.id);
    tx.delete(recordRelations).where(relationIds.length ? and(relationCondition, notInArray(recordRelations.id, relationIds)) : relationCondition).run();
    tx.update(recordRelations).set({ objectRecordId: record.id })
      .where(and(eq(recordRelations.objectSource, record.source), eq(recordRelations.objectExternalId, record.externalId), isNull(recordRelations.objectRecordId))).run();

    if (record.engagement) {
      const previous = tx.select().from(engagementSnapshots).where(eq(engagementSnapshots.recordId, record.id))
        .orderBy(desc(engagementSnapshots.collectedAt), desc(engagementSnapshots.id)).limit(1).get();
      if (engagementChanged(previous, record.engagement)) {
        tx.insert(engagementSnapshots).values({ id: randomUUID(), recordId: record.id,
          likes: record.engagement.likes ?? null, replies: record.engagement.replies ?? null,
          reposts: record.engagement.reposts ?? null, quotes: record.engagement.quotes ?? null,
          views: record.engagement.views ?? null, bookmarks: record.engagement.bookmarks ?? null,
          collectedAt: record.lastSeenAt }).run();
      }
    }
    return { record: mapRecord(canonical), ...(revision ? { revision } : {}), created };
  }

  private commitRecordsTx(tx: Transaction, input: IngestionRecord[]): IngestionCommitResult {
    const result: IngestionCommitResult = { inserted: 0, revised: 0, duplicates: 0 };
    for (const record of input) {
      const write = this.upsertRecordTx(tx, record);
      if (write.created) result.inserted += 1;
      else if (write.revision) result.revised += 1;
      else result.duplicates += 1;
    }
    return result;
  }

  async commitIngestion(input: IngestionCommit): Promise<IngestionCommitResult> {
    return this.orm.transaction((tx) => {
      const result = this.commitRecordsTx(tx, input.records);
      const updatedAt = new Date().toISOString();
      tx.insert(checkpoints).values({ targetId: input.targetId, value: input.checkpoint, updatedAt })
        .onConflictDoUpdate({ target: checkpoints.targetId, set: { value: input.checkpoint, updatedAt } }).run();
      return result;
    });
  }

  async listRevisions(recordId: string): Promise<Page<RecordRevision>> {
    const rows = this.orm.select().from(recordRevisions).where(eq(recordRevisions.recordId, recordId))
      .orderBy(asc(recordRevisions.createdAt), asc(recordRevisions.id)).all();
    return { items: rows.map((row) => ({ ...row, snapshot: row.snapshot as SourceItem })) };
  }

  async getRecord(id: string): Promise<RecordDetail | undefined> {
    const row = this.orm.select().from(records).where(eq(records.id, id)).get();
    if (!row) return undefined;
    const watches = this.orm.select().from(recordWatches).where(eq(recordWatches.recordId, id)).orderBy(asc(recordWatches.watchId), asc(recordWatches.targetId)).all();
    const media = this.orm.select().from(mediaAssets).where(eq(mediaAssets.recordId, id)).orderBy(asc(mediaAssets.position)).all().map((item) => ({
      id: item.id, recordId: item.recordId, kind: item.kind as RecordDetail["media"][number]["kind"], url: item.url,
      position: item.position, firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt,
      ...(item.sourceMediaId === null ? {} : { sourceMediaId: item.sourceMediaId }),
      ...(item.previewUrl === null ? {} : { previewUrl: item.previewUrl }),
      ...(item.mimeType === null ? {} : { mimeType: item.mimeType }),
      ...(item.width === null ? {} : { width: item.width }),
      ...(item.height === null ? {} : { height: item.height }),
      ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
      ...(item.altText === null ? {} : { altText: item.altText }),
      ...(item.metadata === null ? {} : { metadata: asObject(item.metadata) }),
    }));
    const relations = this.orm.select().from(recordRelations).where(eq(recordRelations.subjectRecordId, id)).orderBy(asc(recordRelations.firstSeenAt), asc(recordRelations.id)).all().map((item) => ({
      id: item.id, subjectRecordId: item.subjectRecordId,
      kind: item.kind as RecordDetail["relations"][number]["kind"],
      objectSource: item.objectSource as RecordDetail["relations"][number]["objectSource"],
      objectExternalId: item.objectExternalId, firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt,
      ...(item.objectRecordId === null ? {} : { objectRecordId: item.objectRecordId }),
      ...(item.objectUrl === null ? {} : { objectUrl: item.objectUrl }),
      ...(item.metadata === null ? {} : { metadata: asObject(item.metadata) }),
    }));
    const engagement = this.orm.select().from(engagementSnapshots).where(eq(engagementSnapshots.recordId, id))
      .orderBy(desc(engagementSnapshots.collectedAt), desc(engagementSnapshots.id)).limit(1).get();
    const latestEngagement = engagement ? {
      id: engagement.id, recordId: engagement.recordId, collectedAt: engagement.collectedAt,
      ...Object.fromEntries(engagementFields.flatMap((field) => engagement[field] === null ? [] : [[field, engagement[field]]])),
    } : undefined;
    return { ...mapRecord(row), watches, media, relations, ...(latestEngagement ? { latestEngagement } : {}) } as RecordDetail;
  }

  async queryRecords(input: QueryRecordsInput): Promise<Page<RecordEnvelope>> {
    const watchFilters = [
      eq(recordWatches.recordId, records.id),
      notExists(
        this.orm.select({ one: sql`1` }).from(diagnosticWatches)
          .where(eq(diagnosticWatches.targetId, recordWatches.targetId)),
      ),
    ];
    if (input.targetIds?.length) watchFilters.push(inArray(recordWatches.targetId, input.targetIds));
    if (input.watchIds?.length) watchFilters.push(inArray(recordWatches.watchId, input.watchIds));
    const filters = [
      exists(this.orm.select({ one: sql`1` }).from(recordWatches).where(and(...watchFilters))),
    ];
    if (input.sources?.length) filters.push(inArray(records.source, input.sources));
    if (input.text) {
      const pattern = `%${escapeSubstringPattern(input.text)}%`;
      filters.push(sql`(${records.title} LIKE ${pattern} ESCAPE '\\' OR ${records.text} LIKE ${pattern} ESCAPE '\\')`);
    }
    if (input.since) filters.push(sql`${records.lastSeenAt} >= ${input.since}`);
    if (input.until) filters.push(sql`${records.lastSeenAt} <= ${input.until}`);
    const cursor = decodeRecordsCursor(input.cursor);
    if (cursor) {
      const cursorFilter = or(
        lt(records.lastSeenAt, cursor.lastSeenAt),
        and(
          eq(records.lastSeenAt, cursor.lastSeenAt),
          sql`${records.id} > ${cursor.id}`,
        ),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = this.orm.select().from(records).where(and(...filters)).orderBy(desc(records.lastSeenAt), asc(records.id)).limit(limit + 1).all();
    const items = rows.slice(0, limit).map(mapRecord);
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: encodeRecordsCursor(last) } : {}) };
  }

  async getCheckpoint<T>(targetId: string): Promise<T | undefined> {
    return this.orm.select({ value: checkpoints.value }).from(checkpoints).where(eq(checkpoints.targetId, targetId)).get()?.value as T | undefined;
  }

  async setCheckpoint<T>(targetId: string, checkpoint: T): Promise<void> {
    const updatedAt = new Date().toISOString();
    this.orm.insert(checkpoints).values({ targetId, value: checkpoint, updatedAt })
      .onConflictDoUpdate({ target: checkpoints.targetId, set: { value: checkpoint, updatedAt } }).run();
  }

  async upsertConversationTracking(tracking: ConversationTracking): Promise<void> {
    const row = { ...tracking, nextRunAt: tracking.nextRunAt ?? null, lastObservedReplies: tracking.lastObservedReplies ?? null, burstUntil: tracking.burstUntil ?? null, lastError: tracking.lastError ?? null };
    this.orm.insert(conversationTracking).values(row).onConflictDoUpdate({ target: conversationTracking.rootRecordId, set: row }).run();
  }

  async getConversationTracking(
    rootRecordId: string,
  ): Promise<ConversationTracking | undefined> {
    const row = this.orm
      .select()
      .from(conversationTracking)
      .where(eq(conversationTracking.rootRecordId, rootRecordId))
      .get();
    return row ? mapTracking(row) : undefined;
  }

  async listDueConversationTracking(now: string, limit: number): Promise<ConversationTracking[]> {
    return this.orm.select().from(conversationTracking)
      .where(and(eq(conversationTracking.status, "active"), lte(conversationTracking.nextRunAt, now)))
      .orderBy(asc(conversationTracking.nextRunAt), asc(conversationTracking.rootRecordId))
      .limit(Math.max(0, limit)).all().map(mapTracking);
  }

  async saveConversationSnapshot(input: { snapshot: ConversationSnapshot; items: ConversationSnapshotItem[] }): Promise<void> {
    this.orm.transaction((tx) => {
      tx.insert(conversationSnapshots).values({ ...input.snapshot, truncationReason: input.snapshot.truncationReason ?? null, upstreamCursor: input.snapshot.upstreamCursor ?? null }).run();
      if (input.items.length) tx.insert(conversationSnapshotItems).values(input.items.map((item) => ({ ...item, sortValue: item.sortValue ?? null }))).run();
    });
  }

  async queryConversationSnapshots(rootRecordId: string): Promise<Page<ConversationSnapshot & { items: ConversationSnapshotItem[] }>> {
    const snapshots = this.orm.select().from(conversationSnapshots).where(eq(conversationSnapshots.rootRecordId, rootRecordId))
      .orderBy(desc(conversationSnapshots.collectedAt), desc(conversationSnapshots.id)).all();
    return { items: snapshots.map((snapshot) => ({
      id: snapshot.id, rootRecordId: snapshot.rootRecordId,
      observedCount: snapshot.observedCount, retainedCount: snapshot.retainedCount,
      orderBy: snapshot.orderBy as ConversationSnapshot["orderBy"], pagesFetched: snapshot.pagesFetched,
      complete: snapshot.complete, truncated: snapshot.truncated, collectedAt: snapshot.collectedAt,
      ...(snapshot.truncationReason === null ? {} : { truncationReason: snapshot.truncationReason as NonNullable<ConversationSnapshot["truncationReason"]> }),
      ...(snapshot.upstreamCursor === null ? {} : { upstreamCursor: snapshot.upstreamCursor }),
      items: this.orm.select().from(conversationSnapshotItems).where(eq(conversationSnapshotItems.snapshotId, snapshot.id))
        .orderBy(asc(conversationSnapshotItems.rank)).all().map((item) => ({ snapshotId: item.snapshotId, replyRecordId: item.replyRecordId, rank: item.rank, ...(item.sortValue === null ? {} : { sortValue: item.sortValue }) })),
    })) };
  }

  async enqueueJob(job: Job): Promise<boolean> {
    return this.orm.insert(jobs).values({ ...job, leaseOwner: job.leaseOwner ?? null, leaseToken: job.leaseToken ?? null, leaseExpiresAt: job.leaseExpiresAt ?? null, error: job.error ?? null })
      .onConflictDoNothing().run().changes === 1;
  }

  async claimJobs(owner: string, limit: number, leaseMs: number): Promise<Job[]> {
    return this.orm.transaction((tx) => {
      const now = new Date().toISOString();
      tx.update(jobs).set({ status: "failed", error: "worker lease expired", leaseOwner: null, leaseToken: null, leaseExpiresAt: null })
        .where(and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, now), sql`${jobs.attempt} >= 5`)).run();
      const due = tx.select().from(jobs).where(or(
        and(eq(jobs.status, "queued"), lte(jobs.runAt, now)),
        and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, now), sql`${jobs.attempt} < 5`),
      )).orderBy(asc(jobs.runAt), asc(jobs.id)).limit(limit).all();
      const expires = new Date(Date.now() + leaseMs).toISOString();
      return due.map((row) => {
        const leaseToken = randomUUID();
        const attempt = row.attempt + (row.status === "running" ? 1 : 0);
        tx.update(jobs).set({ status: "running", attempt, leaseOwner: owner, leaseToken, leaseExpiresAt: expires }).where(eq(jobs.id, row.id)).run();
        return mapJob({ ...row, status: "running", attempt, leaseOwner: owner, leaseToken, leaseExpiresAt: expires });
      });
    });
  }

  async completeJob(id: string, owner: string, leaseToken: string): Promise<boolean> {
    return this.orm.update(jobs).set({ status: "complete", error: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null })
      .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.leaseOwner, owner), eq(jobs.leaseToken, leaseToken))).run().changes === 1;
  }

  async failJob(id: string, owner: string, leaseToken: string, error: string, retryAt?: string): Promise<boolean> {
    return this.orm.update(jobs).set({ status: retryAt ? "queued" : "failed", error, attempt: sql`${jobs.attempt} + 1`, runAt: retryAt ?? new Date().toISOString(), leaseOwner: null, leaseToken: null, leaseExpiresAt: null })
      .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.leaseOwner, owner), eq(jobs.leaseToken, leaseToken))).run().changes === 1;
  }

  async saveArtifact(artifact: DerivedArtifact): Promise<void> {
    this.orm.transaction((tx) => {
      const row = { id: artifact.id, kind: artifact.kind, content: artifact.content, provider: artifact.provider ?? null, model: artifact.model ?? null, provenance: artifact.provenance, createdAt: artifact.createdAt };
      tx.insert(artifacts).values(row).onConflictDoUpdate({ target: artifacts.id, set: row }).run();
      tx.delete(artifactRecords).where(eq(artifactRecords.artifactId, artifact.id)).run();
      tx.delete(artifactMedia).where(eq(artifactMedia.artifactId, artifact.id)).run();
      if (artifact.recordIds.length) tx.insert(artifactRecords).values(artifact.recordIds.map((recordId, position) => ({ artifactId: artifact.id, recordId, position }))).run();
      if (artifact.media?.length) tx.insert(artifactMedia).values(artifact.media.map((media, position) => ({ artifactId: artifact.id, mediaAssetId: media.mediaAssetId, disposition: media.disposition, position }))).run();
    });
  }

  async queryArtifacts(input: QueryArtifactsInput): Promise<Page<DerivedArtifact>> {
    const rows = this.orm.select().from(artifacts).where(input.kind ? eq(artifacts.kind, input.kind) : undefined)
      .orderBy(desc(artifacts.createdAt), asc(artifacts.id)).limit(Math.min(Math.max(input.limit ?? 50, 1), 200)).all();
    const visibleRecord = (recordId: SQLWrapper) =>
      exists(
        this.orm.select({ one: sql`1` }).from(recordWatches).where(
          and(
            eq(recordWatches.recordId, recordId),
            notExists(
              this.orm.select({ one: sql`1` }).from(diagnosticWatches).where(
                eq(diagnosticWatches.targetId, recordWatches.targetId),
              ),
            ),
          ),
        ),
      );
    return {
      items: rows.flatMap((row) => {
        const recordIds = this.orm
          .select({ id: artifactRecords.recordId })
          .from(artifactRecords)
          .where(
            and(
              eq(artifactRecords.artifactId, row.id),
              visibleRecord(artifactRecords.recordId),
            ),
          )
          .orderBy(asc(artifactRecords.position))
          .all()
          .map(({ id }) => id);
        if (!recordIds.length) return [];
        const media = this.orm
          .select({
            mediaAssetId: artifactMedia.mediaAssetId,
            disposition: artifactMedia.disposition,
          })
          .from(artifactMedia)
          .innerJoin(mediaAssets, eq(mediaAssets.id, artifactMedia.mediaAssetId))
          .where(
            and(
              eq(artifactMedia.artifactId, row.id),
              visibleRecord(mediaAssets.recordId),
            ),
          )
          .orderBy(asc(artifactMedia.position))
          .all();
        return [{
          id: row.id,
          kind: row.kind,
          content: row.content,
          ...(row.provider === null ? {} : { provider: row.provider }),
          ...(row.model === null ? {} : { model: row.model }),
          provenance: row.provenance as Record<string, unknown>,
          createdAt: row.createdAt,
          recordIds,
          media,
        }];
      }),
    };
  }

  async getAppliedConfig(): Promise<AppliedConfig | undefined> {
    const row = this.orm.select().from(appliedConfig).where(eq(appliedConfig.id, 1)).get();
    return row ? { config: row.config, contentHash: row.contentHash, appliedAt: row.appliedAt } : undefined;
  }

  async applyConfig(snapshot: AppliedConfig): Promise<void> {
    this.orm.insert(appliedConfig).values({ id: 1, ...snapshot }).onConflictDoUpdate({ target: appliedConfig.id, set: snapshot }).run();
  }

  async createDiagnosticWatch(input: CreateDiagnosticWatchInput): Promise<boolean> {
    return this.orm.transaction((tx) => {
      const expiresAt = input.expiresAt ?? new Date(new Date(input.createdAt).getTime() + 15 * 60_000).toISOString();
      const created = tx.insert(diagnosticWatches).values({ id: input.id, targetId: input.targetId, source: input.source, target: input.target, status: input.status, createdAt: input.createdAt, updatedAt: input.updatedAt, expiresAt }).onConflictDoNothing().run().changes === 1;
      if (!created) return false;
      const queued = tx.insert(jobs).values({ ...input.job, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, error: null }).onConflictDoNothing().run().changes === 1;
      if (!queued) throw new Error("Diagnostic watch job could not be enqueued.");
      return true;
    });
  }

  async getDiagnosticWatch(targetId: string): Promise<DiagnosticWatch | undefined> {
    const row = this.orm.select().from(diagnosticWatches).where(eq(diagnosticWatches.targetId, targetId)).get();
    return row ? { ...row, source: row.source as DiagnosticWatch["source"], target: row.target as Record<string, unknown>, status: row.status as DiagnosticWatch["status"] } : undefined;
  }

  async queryDiagnosticRecords(targetId: string): Promise<RecordEnvelope[]> {
    return this.orm.select({ record: records }).from(records).innerJoin(recordWatches, eq(recordWatches.recordId, records.id))
      .where(eq(recordWatches.targetId, targetId)).orderBy(desc(records.lastSeenAt), asc(records.id)).all().map(({ record }) => mapRecord(record));
  }

  async commitDiagnosticIngestion(input: IngestionCommit & { jobId: string; leaseOwner: string; leaseToken: string }): Promise<IngestionCommitResult | undefined> {
    return this.orm.transaction((tx) => {
      const leased = tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.targetId, input.targetId), eq(jobs.status, "running"), eq(jobs.leaseOwner, input.leaseOwner), eq(jobs.leaseToken, input.leaseToken))).get();
      if (!leased) return undefined;
      const watch = tx.select().from(diagnosticWatches).where(and(eq(diagnosticWatches.targetId, input.targetId), sql`${diagnosticWatches.expiresAt} > ${new Date().toISOString()}`)).get();
      if (watch?.status !== "active") {
        tx.update(jobs).set({ status: "complete", error: "diagnostic cancelled", leaseOwner: null, leaseToken: null, leaseExpiresAt: null }).where(eq(jobs.id, input.jobId)).run();
        return undefined;
      }
      const result = this.commitRecordsTx(tx, input.records);
      const updatedAt = new Date().toISOString();
      tx.insert(checkpoints).values({ targetId: input.targetId, value: input.checkpoint, updatedAt }).onConflictDoUpdate({ target: checkpoints.targetId, set: { value: input.checkpoint, updatedAt } }).run();
      tx.update(jobs).set({ status: "complete", error: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null }).where(eq(jobs.id, input.jobId)).run();
      tx.update(diagnosticWatches).set({ status: "complete", updatedAt }).where(eq(diagnosticWatches.targetId, input.targetId)).run();
      return result;
    });
  }

  async cancelDiagnosticWatch(targetId: string): Promise<void> {
    this.orm.transaction((tx) => {
      const updatedAt = new Date().toISOString();
      tx.update(diagnosticWatches).set({ status: "cancelled", updatedAt }).where(and(eq(diagnosticWatches.targetId, targetId), eq(diagnosticWatches.status, "active"))).run();
      tx.update(jobs).set({ status: "complete", error: "diagnostic cancelled", leaseOwner: null, leaseToken: null, leaseExpiresAt: null }).where(and(eq(jobs.targetId, targetId), inArray(jobs.status, ["queued", "running"]))).run();
    });
  }

  async cleanupDiagnosticWatch(targetId: string): Promise<void> {
    this.orm.transaction((tx) => this.cleanupDiagnosticTx(tx, targetId));
  }

  private cleanupDiagnosticTx(tx: Transaction, targetId: string): void {
    const affected = tx.select({ id: recordWatches.recordId }).from(recordWatches).where(eq(recordWatches.targetId, targetId)).all().map(({ id }) => id);
    tx.delete(recordWatches).where(eq(recordWatches.targetId, targetId)).run();
    for (const id of affected) {
      const remaining = tx.select({ id: recordWatches.recordId }).from(recordWatches).where(eq(recordWatches.recordId, id)).limit(1).get();
      if (!remaining) tx.delete(records).where(eq(records.id, id)).run();
    }
    tx.delete(checkpoints).where(eq(checkpoints.targetId, targetId)).run();
    tx.delete(jobs).where(eq(jobs.targetId, targetId)).run();
    tx.delete(diagnosticWatches).where(eq(diagnosticWatches.targetId, targetId)).run();
  }

  async reapExpiredDiagnosticWatches(now = new Date().toISOString()): Promise<number> {
    return this.orm.transaction((tx) => {
      const expired = tx.select({ targetId: diagnosticWatches.targetId }).from(diagnosticWatches).where(lte(diagnosticWatches.expiresAt, now)).all();
      for (const { targetId } of expired) this.cleanupDiagnosticTx(tx, targetId);
      return expired.length;
    });
  }
}
