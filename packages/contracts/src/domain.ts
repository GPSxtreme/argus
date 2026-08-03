import { createHash } from "node:crypto";

export const SOURCE_NAMES = ["x", "telegram", "web"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export interface SourceItem {
  externalId: string;
  url: string;
  title?: string;
  text: string;
  author?: string;
  publishedAt?: string;
  raw: unknown;
  metadata?: Record<string, unknown>;
}

export interface RecordEnvelope extends SourceItem {
  id: string;
  source: SourceName;
  targetId: string;
  watchIds: string[];
  contentHash: string;
  ingestedAt: string;
}

export interface RecordRevision {
  id: string;
  recordId: string;
  contentHash: string;
  title?: string;
  text: string;
  raw: unknown;
  createdAt: string;
}

export interface DerivedArtifact {
  id: string;
  recordIds: string[];
  kind: string;
  content: string;
  provider?: string;
  model?: string;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export const canonicalIdentity = (
  source: SourceName,
  targetId: string,
  externalId: string,
): string => `${source}:${targetId}:${externalId}`;

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
