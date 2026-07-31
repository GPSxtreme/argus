import type {
  DerivedArtifact,
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

export interface Job {
  id: string;
  targetId: string;
  source: SourceName;
  status: "queued" | "running" | "complete" | "failed";
  attempt: number;
  runAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  error?: string;
}

export interface StorageRepository {
  upsertRecord(
    record: RecordEnvelope,
  ): Promise<{ record: RecordEnvelope; revision?: RecordRevision; created: boolean }>;
  listRevisions(recordId: string): Promise<Page<RecordRevision>>;
  queryRecords(input: QueryRecordsInput): Promise<Page<RecordEnvelope>>;
  getCheckpoint<T>(targetId: string): Promise<T | undefined>;
  setCheckpoint<T>(targetId: string, checkpoint: T): Promise<void>;
  enqueueJob(job: Job): Promise<boolean>;
  claimJobs(owner: string, limit: number, leaseMs: number): Promise<Job[]>;
  completeJob(id: string): Promise<void>;
  failJob(id: string, error: string, retryAt?: string): Promise<void>;
  saveArtifact(artifact: DerivedArtifact): Promise<void>;
}
