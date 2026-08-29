import { randomUUID } from "node:crypto";
import type { ArgusConfig } from "@argus/config";
import {
  type ConversationTracking,
  recordIdentity,
  type SourceItem,
  type StorageRepository,
} from "@argus/contracts";
import { ingestItems } from "@argus/engine";
import {
  conversationTargetId,
  nextReplyRun,
  replyGrowthDetected,
  selectObservedReplies,
} from "@argus/scheduler";
import { FxEmbedClient } from "@argus/source-x";

const MAX_CONVERSATION_PAGES = 10;
const MAX_OBSERVED_REPLIES = 500;

interface ConversationClient {
  conversation(
    id: string,
    cursor?: string,
  ): Promise<{ items: SourceItem[]; cursor?: string }>;
}

export interface ConversationRefreshDependencies {
  client?: ConversationClient;
  now?: () => string;
}

export interface ConversationRefreshResult {
  observed: number;
  retained: number;
  pages: number;
}

export const runConversationRefresh = async (
  config: ArgusConfig,
  repository: StorageRepository,
  tracking: ConversationTracking,
  dependencies: ConversationRefreshDependencies = {},
): Promise<ConversationRefreshResult> => {
  const collectedAt = dependencies.now?.() ?? new Date().toISOString();
  if (collectedAt >= tracking.stopsAt) {
    const { nextRunAt: _nextRunAt, ...withoutNextRun } = tracking;
    await repository.upsertConversationTracking({
      ...withoutNextRun,
      status: "complete",
      updatedAt: collectedAt,
    });
    return { observed: 0, retained: 0, pages: 0 };
  }
  const root = await repository.getRecord(tracking.rootRecordId);
  if (root?.source !== "x") {
    throw new Error(`Tracked X root is unavailable: ${tracking.rootRecordId}`);
  }
  const client =
    dependencies.client ?? new FxEmbedClient(config.sources.x.endpoint);
  const observed: SourceItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await client.conversation(root.externalId, cursor);
    pages += 1;
    for (const item of page.items) {
      if (item.externalId === root.externalId) continue;
      observed.push(item);
      if (observed.length === MAX_OBSERVED_REPLIES) break;
    }
    cursor = page.cursor;
  } while (
    cursor &&
    pages < MAX_CONVERSATION_PAGES &&
    observed.length < MAX_OBSERVED_REPLIES
  );
  const selected = selectObservedReplies(
    observed,
    tracking.orderBy,
    tracking.maxPerPost,
  );
  async function* selectedItems(): AsyncIterable<SourceItem> {
    for (const reply of selected) yield reply.item;
  }
  const targetId = conversationTargetId(tracking.rootRecordId);
  await ingestItems({
    source: "x",
    targetId,
    watchIds: [tracking.watchId],
    keywords: [],
    items: selectedItems(),
    checkpoint: { cursor, observedAt: collectedAt },
    repository,
    now: () => collectedAt,
  });
  const snapshotId = randomUUID();
  const observationTruncated = Boolean(cursor);
  const selectionTruncated = selected.length < observed.length;
  await repository.saveConversationSnapshot({
    snapshot: {
      id: snapshotId,
      rootRecordId: tracking.rootRecordId,
      observedCount: observed.length,
      retainedCount: selected.length,
      orderBy: tracking.orderBy,
      pagesFetched: pages,
      complete: !observationTruncated,
      truncated: observationTruncated || selectionTruncated,
      ...(observationTruncated && cursor
        ? {
            truncationReason: "observation_limit" as const,
            upstreamCursor: cursor,
          }
        : selectionTruncated
          ? { truncationReason: "selection_limit" as const }
          : {}),
      collectedAt,
    },
    items: selected.map(({ item, rank, sortValue }) => ({
      snapshotId,
      replyRecordId: recordIdentity("x", item.externalId),
      rank,
      ...(sortValue === undefined ? {} : { sortValue }),
    })),
  });
  const nextRunAt = nextReplyRun({
    publishedAt: tracking.publishedAt,
    now: collectedAt,
    stopsAt: tracking.stopsAt,
    ...(tracking.lastObservedReplies === undefined
      ? {}
      : { previousObservedReplies: tracking.lastObservedReplies }),
    observedReplies: observed.length,
    ...(tracking.burstUntil === undefined
      ? {}
      : { burstUntil: tracking.burstUntil }),
  });
  const burstUntil = replyGrowthDetected(
    tracking.lastObservedReplies,
    observed.length,
  )
    ? new Date(new Date(collectedAt).getTime() + 6 * 60 * 60 * 1000).toISOString()
    : tracking.burstUntil;
  const {
    nextRunAt: _previousNextRun,
    lastError: _lastError,
    ...trackingBase
  } = tracking;
  await repository.upsertConversationTracking({
    ...trackingBase,
    status: nextRunAt ? "active" : "complete",
    ...(nextRunAt ? { nextRunAt } : {}),
    lastObservedReplies: observed.length,
    ...(burstUntil === undefined ? {} : { burstUntil }),
    updatedAt: collectedAt,
  });
  return { observed: observed.length, retained: selected.length, pages };
};
