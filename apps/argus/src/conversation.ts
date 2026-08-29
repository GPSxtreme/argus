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
  const root = await repository.getRecord(tracking.rootRecordId);
  if (root?.source !== "x") {
    throw new Error(`Tracked X root is unavailable: ${tracking.rootRecordId}`);
  }
  const client =
    dependencies.client ?? new FxEmbedClient(config.sources.x.endpoint);
  const observed = new Map<string, SourceItem>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let continuationError: unknown;
  do {
    let page: { items: SourceItem[]; cursor?: string };
    try {
      page = await client.conversation(root.externalId, cursor);
    } catch (error) {
      if (pages === 0) throw error;
      continuationError = error;
      break;
    }
    pages += 1;
    for (const item of page.items) {
      if (item.externalId === root.externalId) continue;
      observed.set(item.externalId, item);
      if (observed.size === MAX_OBSERVED_REPLIES) break;
    }
    cursor = page.cursor;
    if (cursor && seenCursors.has(cursor)) {
      continuationError = new Error("FxEmbed conversation cursor repeated");
      break;
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor && observed.size < MAX_OBSERVED_REPLIES);
  const observedItems = [...observed.values()];
  const selected = selectObservedReplies(
    observedItems,
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
  const cursorFailed = continuationError !== undefined;
  const observationTruncated = !cursorFailed && Boolean(cursor) && observed.size >= MAX_OBSERVED_REPLIES;
  const selectionTruncated = selected.length < observed.size;
  await repository.saveConversationSnapshot({
    snapshot: {
      id: snapshotId,
      rootRecordId: tracking.rootRecordId,
      observedCount: observed.size,
      retainedCount: selected.length,
      orderBy: tracking.orderBy,
      pagesFetched: pages,
      complete: !cursorFailed && !observationTruncated,
      truncated: cursorFailed || observationTruncated || selectionTruncated,
      ...(cursorFailed
        ? {
            truncationReason: "upstream_cursor_failure" as const,
            ...(cursor ? { upstreamCursor: cursor } : {}),
          }
        : observationTruncated && cursor
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
  if (continuationError !== undefined) throw continuationError;
  const nextRunAt = nextReplyRun({
    publishedAt: tracking.publishedAt,
    now: collectedAt,
    stopsAt: tracking.stopsAt,
    ...(tracking.lastObservedReplies === undefined
      ? {}
      : { previousObservedReplies: tracking.lastObservedReplies }),
    observedReplies: observed.size,
    ...(tracking.burstUntil === undefined
      ? {}
      : { burstUntil: tracking.burstUntil }),
  });
  const burstUntil = replyGrowthDetected(
    tracking.lastObservedReplies,
    observed.size,
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
    lastObservedReplies: observed.size,
    ...(burstUntil === undefined ? {} : { burstUntil }),
    updatedAt: collectedAt,
  });
  return { observed: observed.size, retained: selected.length, pages };
};
