import {
  contentHash,
  recordIdentity,
  type RecordEnvelope,
  type SourceItem,
  type SourceName,
} from "@argus/contracts";

export interface NormalizeItemInput {
  source: SourceName;
  targetId: string;
  watchIds: string[];
  item: SourceItem;
  now?: string;
}

export const normalizeItem = (input: NormalizeItemInput): RecordEnvelope => {
  const { item } = input;
  return {
    ...item,
    id: recordIdentity(input.source, item.externalId),
    source: input.source,
    targetId: input.targetId,
    watchIds: [...new Set(input.watchIds)].sort(),
    contentHash: contentHash({
      title: item.title,
      text: item.text,
      author: item.author,
      publishedAt: item.publishedAt,
      media: item.media,
      relations: item.relations,
    }),
    ingestedAt: input.now ?? new Date().toISOString(),
  };
};
