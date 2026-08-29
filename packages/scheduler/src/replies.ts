import {
  contentHash,
  type Job,
  type ReplyOrdering,
  type SourceItem,
  type StorageRepository,
} from "@argus/contracts";

export const X_CONVERSATION_TARGET_PREFIX = "__argus_x_conversation:";

export const conversationTargetId = (rootRecordId: string): string =>
  `${X_CONVERSATION_TARGET_PREFIX}${rootRecordId}`;

export const conversationRootRecordId = (
  targetId: string,
): string | undefined =>
  targetId.startsWith(X_CONVERSATION_TARGET_PREFIX)
    ? targetId.slice(X_CONVERSATION_TARGET_PREFIX.length) || undefined
    : undefined;

export const enqueueDueConversationTracking = async (
  repository: StorageRepository,
  now = new Date(),
  limit = 100,
): Promise<number> => {
  let queued = 0;
  const due = await repository.listDueConversationTracking(
    now.toISOString(),
    limit,
  );
  for (const tracking of due) {
    if (!tracking.nextRunAt) continue;
    const targetId = conversationTargetId(tracking.rootRecordId);
    const job: Job = {
      id: contentHash({ targetId, runAt: tracking.nextRunAt }).slice(0, 32),
      targetId,
      source: "x",
      status: "queued",
      attempt: 0,
      runAt: tracking.nextRunAt,
    };
    if (await repository.enqueueJob(job)) queued += 1;
  }
  return queued;
};

const HOUR = 60 * 60 * 1000;
export interface ReplyScheduleInput {
  publishedAt: string;
  now: string;
  stopsAt: string;
  previousObservedReplies?: number;
  observedReplies?: number;
  burstUntil?: string;
}

export const replyGrowthDetected = (
  previous: number | undefined,
  observed: number | undefined,
): boolean =>
  previous !== undefined &&
  observed !== undefined &&
  observed - previous >=
    Math.max(1, Math.min(10, Math.ceil(previous * 0.2)));

export const nextReplyRun = (input: ReplyScheduleInput): string | undefined => {
  const now = new Date(input.now).getTime(); const published = new Date(input.publishedAt).getTime(); const stops = new Date(input.stopsAt).getTime();
  if (now >= stops) return undefined;
  const previous = input.previousObservedReplies; const observed = input.observedReplies;
  const growth = replyGrowthDetected(previous, observed);
  const activeBurst = input.burstUntil ? now < new Date(input.burstUntil).getTime() : false;
  const age = Math.max(0, now - published);
  const interval = growth || activeBurst ? HOUR : age < HOUR ? HOUR / 4 : age < 6 * HOUR ? HOUR : age < 24 * HOUR ? 6 * HOUR : age < 72 * HOUR ? 24 * HOUR : 72 * HOUR;
  return new Date(Math.min(now + interval, stops)).toISOString();
};

export interface SelectedReply { item: SourceItem; rank: number; sortValue?: number }
const metric = (item: SourceItem, orderBy: ReplyOrdering): number | undefined => orderBy === "likes" ? item.engagement?.likes : orderBy === "replies" ? item.engagement?.replies : orderBy === "reposts" ? item.engagement?.reposts : orderBy === "views" ? item.engagement?.views : undefined;

export const selectObservedReplies = (items: SourceItem[], orderBy: ReplyOrdering, limit: number): SelectedReply[] => {
  const unique = items.filter((item, index) => items.findIndex(({ externalId }) => externalId === item.externalId) === index).map((item, sourceIndex) => ({ item, sourceIndex }));
  unique.sort((left, right) => {
    if (orderBy === "source") return left.sourceIndex - right.sourceIndex;
    const leftTime = new Date(left.item.publishedAt ?? 0).getTime(); const rightTime = new Date(right.item.publishedAt ?? 0).getTime();
    if (orderBy === "newest" && leftTime !== rightTime) return rightTime - leftTime;
    if (orderBy === "oldest" && leftTime !== rightTime) return leftTime - rightTime;
    if (!["newest", "oldest"].includes(orderBy)) {
      const leftMetric = metric(left.item, orderBy); const rightMetric = metric(right.item, orderBy);
      if (leftMetric === undefined && rightMetric !== undefined) return 1;
      if (leftMetric !== undefined && rightMetric === undefined) return -1;
      if (leftMetric !== rightMetric) return (rightMetric ?? 0) - (leftMetric ?? 0);
    }
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.item.externalId.localeCompare(right.item.externalId);
  });
  return unique.slice(0, Math.max(0, limit)).map(({ item }, index) => ({ item, rank: index + 1, ...(metric(item, orderBy) === undefined ? {} : { sortValue: metric(item, orderBy) }) } as SelectedReply));
};
