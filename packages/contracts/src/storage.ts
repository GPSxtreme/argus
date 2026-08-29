import type {
  ConversationSnapshot,
  ConversationSnapshotItem,
  ConversationTracking,
  DerivedArtifact,
  IngestionRecord,
  RecordDetail,
  RecordEnvelope,
  RecordRevision,
  SourceName,
} from "./domain.js";

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface QueryRecordsInput {
  sources?: SourceName[];
  targetIds?: string[];
  watchIds?: string[];
  text?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface IngestionCommit {
  records: IngestionRecord[];
  targetId: string;
  checkpoint: unknown;
}

export interface IngestionCommitResult {
  inserted: number;
  revised: number;
  duplicates: number;
}

export interface AppliedConfig {
  config: unknown;
  contentHash: string;
  appliedAt: string;
}

export interface QueryArtifactsInput {
  kind?: string;
  limit?: number;
}

export interface Job {
  id: string;
  targetId: string;
  source: SourceName;
  status: "queued" | "running" | "complete" | "failed";
  attempt: number;
  runAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  error?: string;
}

export class InvalidRecordsCursorError extends Error {
  readonly code = "RECORDS_CURSOR_INVALID";

  constructor() {
    super("Invalid records cursor");
    this.name = "InvalidRecordsCursorError";
  }
}

export interface RecordsCursorV2 {
  v: 2;
  lastSeenAt: string;
  id: string;
}

export const encodeRecordsCursor = (
  record: Pick<RecordEnvelope, "lastSeenAt" | "id">,
): string =>
  Buffer.from(
    JSON.stringify({ v: 2, lastSeenAt: record.lastSeenAt, id: record.id }),
  ).toString("base64url");

export const decodeRecordsCursor = (
  cursor?: string,
): RecordsCursorV2 | undefined => {
  if (!cursor) return undefined;
  try {
    if (
      cursor.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    ) {
      throw new Error("invalid encoding");
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("non-canonical");
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 3
    ) {
      throw new Error("invalid shape");
    }
    const value = parsed as Partial<RecordsCursorV2>;
    if (
      value.v !== 2 ||
      typeof value.lastSeenAt !== "string" ||
      new Date(value.lastSeenAt).toISOString() !== value.lastSeenAt ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) {
      throw new Error("invalid value");
    }
    return value as RecordsCursorV2;
  } catch {
    throw new InvalidRecordsCursorError();
  }
};
export interface DiagnosticWatch {
  id: string; targetId: string; source: SourceName; target: Record<string, unknown>;
  status: "active" | "cancelled" | "complete"; createdAt: string; updatedAt: string;
  expiresAt: string;
}
export type CreateDiagnosticWatchInput = Omit<DiagnosticWatch, "expiresAt"> & {
  expiresAt?: string;
  job: Job;
};

export interface StorageRepository {
  upsertRecord(
    record: IngestionRecord,
  ): Promise<{ record: RecordEnvelope; revision?: RecordRevision; created: boolean }>;
  commitIngestion(input: IngestionCommit): Promise<IngestionCommitResult>;
  listRevisions(recordId: string): Promise<Page<RecordRevision>>;
  queryRecords(input: QueryRecordsInput): Promise<Page<RecordEnvelope>>;
  getRecord(id: string): Promise<RecordDetail | undefined>;
  getConversationTracking(
    rootRecordId: string,
  ): Promise<ConversationTracking | undefined>;
  upsertConversationTracking(tracking: ConversationTracking): Promise<void>;
  listDueConversationTracking(
    now: string,
    limit: number,
  ): Promise<ConversationTracking[]>;
  saveConversationSnapshot(input: {
    snapshot: ConversationSnapshot;
    items: ConversationSnapshotItem[];
  }): Promise<void>;
  queryConversationSnapshots(
    rootRecordId: string,
  ): Promise<Page<ConversationSnapshot & { items: ConversationSnapshotItem[] }>>;
  getCheckpoint<T>(targetId: string): Promise<T | undefined>;
  setCheckpoint<T>(targetId: string, checkpoint: T): Promise<void>;
  enqueueJob(job: Job): Promise<boolean>;
  claimJobs(owner: string, limit: number, leaseMs: number): Promise<Job[]>;
  completeJob(id: string, owner: string, leaseToken: string): Promise<boolean>;
  failJob(
    id: string,
    owner: string,
    leaseToken: string,
    error: string,
    retryAt?: string,
  ): Promise<boolean>;
  saveArtifact(artifact: DerivedArtifact): Promise<void>;
  queryArtifacts(input: QueryArtifactsInput): Promise<Page<DerivedArtifact>>;
  getAppliedConfig(): Promise<AppliedConfig | undefined>;
  applyConfig(snapshot: AppliedConfig): Promise<void>;
  createDiagnosticWatch(input: CreateDiagnosticWatchInput): Promise<boolean>;
  getDiagnosticWatch(targetId: string): Promise<DiagnosticWatch | undefined>;
  queryDiagnosticRecords(targetId: string): Promise<RecordEnvelope[]>;
  commitDiagnosticIngestion(
    input: IngestionCommit & {
      jobId: string;
      leaseOwner: string;
      leaseToken: string;
    },
  ): Promise<IngestionCommitResult | undefined>;
  cancelDiagnosticWatch(targetId: string): Promise<void>;
  cleanupDiagnosticWatch(targetId: string): Promise<void>;
  reapExpiredDiagnosticWatches(now?: string): Promise<number>;
}
