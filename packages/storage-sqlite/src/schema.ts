import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => text(name).notNull();
const json = (name: string) => text(name, { mode: "json" }).notNull();
const nullableJson = (name: string) => text(name, { mode: "json" });

export const schemaMeta = sqliteTable("schema_meta", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at"),
});

export const records = sqliteTable(
  "records",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    text: text("text").notNull(),
    author: text("author"),
    publishedAt: text("published_at"),
    raw: json("raw_json"),
    metadata: nullableJson("metadata_json"),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [
    uniqueIndex("records_source_external_idx").on(
      table.source,
      table.externalId,
    ),
    index("records_last_seen_idx").on(table.lastSeenAt, table.id),
    index("records_source_idx").on(table.source),
    check("records_id_sha256", sql`length(${table.id}) = 64`),
  ],
);

export const recordWatches = sqliteTable(
  "record_watches",
  {
    recordId: text("record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    watchId: text("watch_id").notNull(),
    targetId: text("target_id").notNull(),
    firstSeenAt: timestamp("first_seen_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.watchId, table.targetId] }),
    index("record_watches_watch_idx").on(table.watchId, table.lastSeenAt),
    index("record_watches_target_idx").on(table.targetId, table.lastSeenAt),
  ],
);

export const recordRevisions = sqliteTable(
  "record_revisions",
  {
    id: text("id").primaryKey(),
    recordId: text("record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    snapshot: json("snapshot_json"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("record_revisions_record_hash_idx").on(table.recordId, table.contentHash),
    index("record_revisions_record_created_idx").on(table.recordId, table.createdAt),
  ],
);

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    recordId: text("record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    sourceMediaId: text("source_media_id"),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    previewUrl: text("preview_url"),
    mimeType: text("mime_type"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    altText: text("alt_text"),
    position: integer("position").notNull(),
    metadata: nullableJson("metadata_json"),
    firstSeenAt: timestamp("first_seen_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [
    uniqueIndex("media_assets_record_position_idx").on(table.recordId, table.position),
    index("media_assets_record_idx").on(table.recordId),
    check("media_assets_position_nonnegative", sql`${table.position} >= 0`),
  ],
);

export const recordRelations = sqliteTable(
  "record_relations",
  {
    id: text("id").primaryKey(),
    subjectRecordId: text("subject_record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    objectSource: text("object_source").notNull(),
    objectExternalId: text("object_external_id").notNull(),
    objectRecordId: text("object_record_id").references(() => records.id, { onDelete: "set null" }),
    objectUrl: text("object_url"),
    metadata: nullableJson("metadata_json"),
    firstSeenAt: timestamp("first_seen_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [
    uniqueIndex("record_relations_edge_idx").on(table.subjectRecordId, table.kind, table.objectSource, table.objectExternalId),
    index("record_relations_object_idx").on(table.objectSource, table.objectExternalId),
  ],
);

export const engagementSnapshots = sqliteTable(
  "engagement_snapshots",
  {
    id: text("id").primaryKey(),
    recordId: text("record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    likes: integer("likes"),
    replies: integer("replies"),
    reposts: integer("reposts"),
    quotes: integer("quotes"),
    views: integer("views"),
    bookmarks: integer("bookmarks"),
    collectedAt: timestamp("collected_at"),
  },
  (table) => [index("engagement_record_collected_idx").on(table.recordId, table.collectedAt)],
);

export const conversationTracking = sqliteTable(
  "conversation_tracking",
  {
    rootRecordId: text("root_record_id").primaryKey().references(() => records.id, { onDelete: "cascade" }),
    watchId: text("watch_id").notNull(),
    status: text("status").notNull(),
    orderBy: text("order_by").notNull(),
    maxPerPost: integer("max_per_post").notNull(),
    maxTrackingHours: integer("max_tracking_hours").notNull(),
    publishedAt: timestamp("published_at"),
    nextRunAt: text("next_run_at"),
    stopsAt: timestamp("stops_at"),
    lastObservedReplies: integer("last_observed_replies"),
    burstUntil: text("burst_until"),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("conversation_tracking_due_idx").on(table.status, table.nextRunAt)],
);

export const conversationSnapshots = sqliteTable(
  "conversation_snapshots",
  {
    id: text("id").primaryKey(),
    rootRecordId: text("root_record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    observedCount: integer("observed_count").notNull(),
    retainedCount: integer("retained_count").notNull(),
    orderBy: text("order_by").notNull(),
    pagesFetched: integer("pages_fetched").notNull(),
    complete: integer("complete", { mode: "boolean" }).notNull(),
    truncated: integer("truncated", { mode: "boolean" }).notNull(),
    truncationReason: text("truncation_reason"),
    upstreamCursor: text("upstream_cursor"),
    collectedAt: timestamp("collected_at"),
  },
  (table) => [index("conversation_snapshots_root_collected_idx").on(table.rootRecordId, table.collectedAt)],
);

export const conversationSnapshotItems = sqliteTable(
  "conversation_snapshot_items",
  {
    snapshotId: text("snapshot_id").notNull().references(() => conversationSnapshots.id, { onDelete: "cascade" }),
    replyRecordId: text("reply_record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    sortValue: integer("sort_value"),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.replyRecordId] }),
    uniqueIndex("conversation_snapshot_rank_idx").on(table.snapshotId, table.rank),
  ],
);

export const checkpoints = sqliteTable("checkpoints", {
  targetId: text("target_id").primaryKey(),
  value: json("value_json"),
  updatedAt: timestamp("updated_at"),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull(),
    runAt: timestamp("run_at"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    error: text("error"),
  },
  (table) => [index("jobs_due_idx").on(table.status, table.runAt, table.leaseExpiresAt)],
);

export const diagnosticWatches = sqliteTable(
  "diagnostic_watches",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id").notNull().unique(),
    source: text("source").notNull(),
    target: json("target_json"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    expiresAt: timestamp("expires_at"),
  },
  (table) => [index("diagnostic_watches_expiry_idx").on(table.expiresAt)],
);

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  provider: text("provider"),
  model: text("model"),
  provenance: json("provenance_json"),
  createdAt: timestamp("created_at"),
});

export const artifactRecords = sqliteTable(
  "artifact_records",
  {
    artifactId: text("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
    recordId: text("record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.recordId] }),
    uniqueIndex("artifact_records_position_idx").on(table.artifactId, table.position),
  ],
);

export const artifactMedia = sqliteTable(
  "artifact_media",
  {
    artifactId: text("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
    mediaAssetId: text("media_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    disposition: text("disposition").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.mediaAssetId] }),
    uniqueIndex("artifact_media_position_idx").on(table.artifactId, table.position),
  ],
);

export const appliedConfig = sqliteTable("applied_config", {
  id: integer("id").primaryKey(),
  config: json("config_json"),
  contentHash: text("content_hash").notNull(),
  appliedAt: timestamp("applied_at"),
});

export const sqliteSchema = {
  appliedConfig,
  artifactMedia,
  artifactRecords,
  artifacts,
  checkpoints,
  conversationSnapshotItems,
  conversationSnapshots,
  conversationTracking,
  diagnosticWatches,
  engagementSnapshots,
  jobs,
  mediaAssets,
  recordRelations,
  recordRevisions,
  recordWatches,
  records,
  schemaMeta,
};
