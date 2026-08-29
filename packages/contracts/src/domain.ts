import { createHash } from "node:crypto";

export const SOURCE_NAMES = ["x", "telegram", "web"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export const MEDIA_KINDS = ["image", "video", "audio", "document"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const RELATION_KINDS = [
  "reply_to",
  "quote_of",
  "repost_of",
  "thread_parent",
  "links_to",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export interface SourceMedia {
  sourceMediaId?: string;
  kind: MediaKind;
  url: string;
  previewUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceRelation {
  kind: RelationKind;
  objectSource: SourceName;
  objectExternalId: string;
  objectUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface Engagement {
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  views?: number;
  bookmarks?: number;
}

export interface SourceItem {
  externalId: string;
  url: string;
  title?: string;
  text: string;
  author?: string;
  publishedAt?: string;
  media?: SourceMedia[];
  relations?: SourceRelation[];
  engagement?: Engagement;
  raw: unknown;
  metadata?: Record<string, unknown>;
}

export interface RecordEnvelope extends SourceItem {
  id: string;
  source: SourceName;
  contentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface IngestionRecord extends RecordEnvelope {
  targetId: string;
  watchIds: string[];
}

export interface RecordRevision {
  id: string;
  recordId: string;
  contentHash: string;
  snapshot: SourceItem;
  createdAt: string;
}

export interface RecordWatch {
  recordId: string;
  watchId: string;
  targetId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MediaAsset extends SourceMedia {
  id: string;
  recordId: string;
  position: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RecordRelation extends SourceRelation {
  id: string;
  subjectRecordId: string;
  objectRecordId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EngagementSnapshot extends Engagement {
  id: string;
  recordId: string;
  collectedAt: string;
}

export const REPLY_ORDERINGS = [
  "likes",
  "newest",
  "oldest",
  "replies",
  "reposts",
  "views",
  "source",
] as const;
export type ReplyOrdering = (typeof REPLY_ORDERINGS)[number];

export interface ConversationTracking {
  rootRecordId: string;
  watchId: string;
  status: "active" | "complete" | "failed";
  orderBy: ReplyOrdering;
  maxPerPost: number;
  maxTrackingHours: number;
  publishedAt: string;
  nextRunAt?: string;
  stopsAt: string;
  lastObservedReplies?: number;
  burstUntil?: string;
  lastError?: string;
  updatedAt: string;
}

export type ConversationTruncationReason =
  | "selection_limit"
  | "observation_limit"
  | "upstream_cursor_failure"
  | "upstream_unavailable";

export interface ConversationSnapshot {
  id: string;
  rootRecordId: string;
  observedCount: number;
  retainedCount: number;
  orderBy: ReplyOrdering;
  pagesFetched: number;
  complete: boolean;
  truncated: boolean;
  truncationReason?: ConversationTruncationReason;
  upstreamCursor?: string;
  collectedAt: string;
}

export interface ConversationSnapshotItem {
  snapshotId: string;
  replyRecordId: string;
  rank: number;
  sortValue?: number;
}

export type RecordDetail = Omit<
  RecordEnvelope,
  "media" | "relations" | "engagement"
> & {
  watches: RecordWatch[];
  media: MediaAsset[];
  relations: RecordRelation[];
  latestEngagement?: EngagementSnapshot;
};

export interface DerivedArtifact {
  id: string;
  recordIds: string[];
  media?: Array<{
    mediaAssetId: string;
    disposition: string;
  }>;
  kind: string;
  content: string;
  provider?: string;
  model?: string;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export const recordIdentity = (
  source: SourceName,
  externalId: string,
): string =>
  createHash("sha256").update(`${source}\0${externalId}`).digest("hex");

const sortRecursively = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, entry]) => [key, sortRecursively(entry)]),
    );
  }
  return value;
};

export const contentHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(sortRecursively(value)))
    .digest("hex");

/** Escapes LIKE/ILIKE wildcards so user input matches literally in both storage adapters. */
export const escapeSubstringPattern = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
