import type { ReplyOrdering, SourceItem } from "@argus/contracts";

const HOUR = 60 * 60 * 1000;
export interface ReplyScheduleInput {
  publishedAt: string;
  now: string;
  stopsAt: string;
  previousObservedReplies?: number;
  observedReplies?: number;
  burstUntil?: string;
}

export const nextReplyRun = (input: ReplyScheduleInput): string | undefined => {
  const now = new Date(input.now).getTime(); const published = new Date(input.publishedAt).getTime(); const stops = new Date(input.stopsAt).getTime();
  if (now >= stops) return undefined;
  const previous = input.previousObservedReplies; const observed = input.observedReplies;
  const growth = previous !== undefined && observed !== undefined && observed - previous >= Math.max(1, Math.min(10, Math.ceil(previous * 0.2)));
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
