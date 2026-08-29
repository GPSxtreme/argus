import type { ArgusConfig } from "@argus/config";
import type {
  SourceAdapter,
  SourceItem,
  StorageRepository,
} from "@argus/contracts";
import { recordIdentity } from "@argus/contracts";
import { ingestItems } from "@argus/engine";
import { type ScheduledTarget, targetsFromConfig } from "@argus/scheduler";
import { TelegramAdapter } from "@argus/source-telegram";
import {
  createTrustedServiceOrigin,
  WebAdapter,
  type WebAdapterOptions,
} from "@argus/source-web";
import { XAdapter } from "@argus/source-x";

// biome-ignore lint/suspicious/noExplicitAny: Runtime dispatch intentionally erases source-specific adapter types.
type AnyAdapter = SourceAdapter<any, any>;
export type AdapterFactory = (target: ScheduledTarget) => AnyAdapter;

export const createAdapterFactory = (
  config: ArgusConfig,
  webOptions: Omit<WebAdapterOptions, "trustedSearchOrigin"> = {},
): AdapterFactory => {
  const trustedSearchOrigin = config.sources.web.searchEndpoint
    ? createTrustedServiceOrigin(config.sources.web.searchEndpoint)
    : undefined;
  return (target) => {
    if (target.source === "x") return new XAdapter();
    if (target.source === "telegram") return new TelegramAdapter();
    return new WebAdapter({
      ...webOptions,
      ...(trustedSearchOrigin ? { trustedSearchOrigin } : {}),
    });
  };
};

const adapterConfig = (
  target: ScheduledTarget,
  config: ArgusConfig,
): unknown => {
  if (target.source === "x") {
    return {
      endpoint: config.sources.x.endpoint,
      kind: target.kind,
      value: target.value,
    };
  }
  if (target.source === "telegram") return { channel: target.value };
  return {
    kind: target.kind,
    value: target.value,
    userAgent: config.sources.web.userAgent,
  };
};

export const runTarget = async (
  target: ScheduledTarget,
  config: ArgusConfig,
  repository: StorageRepository,
  adapter?: AnyAdapter,
  isActive: (() => Promise<boolean>) | undefined = undefined,
  diagnosticJobId?: string,
  diagnosticLease?: { owner: string; token: string },
): Promise<{
  inserted: number;
  revised: number;
  duplicates: number;
  diagnosticCommitted?: boolean;
  replyTrackingStarted?: number;
  replyTrackingFailed?: number;
}> => {
  const sourceAdapter = adapter ?? createAdapterFactory(config)(target);
  if (isActive && !(await isActive())) return { inserted: 0, revised: 0, duplicates: 0 };
  const checkpoint = await repository.getCheckpoint<{ lastId?: string }>(
    target.id,
  );
  const items: SourceItem[] = [];
  for await (const item of sourceAdapter.pull({
    targetId: target.id,
    config: adapterConfig(target, config),
    ...(checkpoint ? { checkpoint } : {}),
  })) {
    items.push(item);
  }
  async function* sourceItems(): AsyncIterable<SourceItem> {
    yield* items;
  }
  if (isActive && !(await isActive())) return { inserted: 0, revised: 0, duplicates: 0 };
  const result = await ingestItems({
    source: target.source,
    targetId: target.id,
    watchIds: [target.watchId],
    keywords: target.keywords,
    items: sourceItems(),
    checkpoint: {
      ...(items[0]
        ? {
            lastId:
              target.source === "telegram"
                ? (items.at(-1) ?? items[0]).externalId
                : items[0].externalId,
          }
        : checkpoint),
      observedAt: new Date().toISOString(),
    },
    repository,
    ...(diagnosticJobId && diagnosticLease
      ? {
          diagnosticJobId,
          diagnosticLeaseOwner: diagnosticLease.owner,
          diagnosticLeaseToken: diagnosticLease.token,
        }
      : {}),
  });
  let replyTrackingStarted = 0;
  let replyTrackingFailed = 0;
  if (
    !diagnosticJobId &&
    target.source === "x" &&
    config.sources.x.replies.enabled
  ) {
    const observedAt = new Date();
    for (const item of items) {
      const isReply = item.relations?.some(
        (relation) => relation.kind === "reply_to",
      );
      const isRepost = item.relations?.some(
        (relation) => relation.kind === "repost_of",
      );
      if (isReply || isRepost) continue;
      const rootRecordId = recordIdentity("x", item.externalId);
      try {
        const existing = await repository.getConversationTracking(rootRecordId);
        if (existing) {
          const observedReplies = item.engagement?.replies;
          if (
            existing.status === "complete" &&
            observedReplies !== undefined &&
            observedReplies > (existing.lastObservedReplies ?? 0)
          ) {
            const now = observedAt.toISOString();
            const { nextRunAt: _nextRunAt, lastError: _lastError, ...base } = existing;
            await repository.upsertConversationTracking({
              ...base,
              status: "active",
              nextRunAt: now,
              stopsAt: new Date(observedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
              updatedAt: now,
            });
            replyTrackingStarted += 1;
          }
          continue;
        }
        const parsedPublishedAt = item.publishedAt
          ? new Date(item.publishedAt)
          : observedAt;
        const publishedAt = Number.isNaN(parsedPublishedAt.getTime())
          ? observedAt.toISOString()
          : parsedPublishedAt.toISOString();
        const stopsAt = new Date(
          new Date(publishedAt).getTime() +
            config.sources.x.replies.maxTrackingHours * 60 * 60 * 1000,
        ).toISOString();
        const effectiveStopsAt =
          stopsAt <= observedAt.toISOString()
            ? observedAt.toISOString()
            : stopsAt;
        await repository.upsertConversationTracking({
          rootRecordId,
          watchId: target.watchId,
          status: "active",
          orderBy: config.sources.x.replies.orderBy,
          maxPerPost: config.sources.x.replies.maxPerPost,
          maxTrackingHours: config.sources.x.replies.maxTrackingHours,
          publishedAt,
          nextRunAt: observedAt.toISOString(),
          stopsAt: effectiveStopsAt,
          updatedAt: observedAt.toISOString(),
        });
        replyTrackingStarted += 1;
      } catch {
        replyTrackingFailed += 1;
      }
    }
  }
  if (!diagnosticJobId) {
    return {
      ...result,
      ...(replyTrackingStarted > 0 ? { replyTrackingStarted } : {}),
      ...(replyTrackingFailed > 0 ? { replyTrackingFailed } : {}),
    };
  }
  return {
    ...result,
    diagnosticCommitted:
      (await repository.getDiagnosticWatch(target.id))?.status === "complete",
  };
};

export const findTarget = (
  config: ArgusConfig,
  targetId: string,
): ScheduledTarget | undefined =>
  targetsFromConfig(config).find((target) => target.id === targetId);

/** Resolves a server-owned temporary diagnostic target persisted in shared storage. */
export const findDiagnosticTarget = async (
  repository: StorageRepository,
  targetId: string,
): Promise<ScheduledTarget | undefined> => {
  if (!targetId.startsWith("__argus_doctor:")) return undefined;
  const state = await repository.getDiagnosticWatch(targetId);
  if (state?.status !== "active") return undefined;
  const target = state.target;
  if (typeof target.kind !== "string" || typeof target.value !== "string" || typeof target.watchId !== "string") return undefined;
  const allowed = state.source === "telegram" ? ["channel"] : state.source === "x" ? ["account", "query"] : ["url", "feed", "query"];
  if (!allowed.includes(target.kind) || Object.keys(target).some((key) => !["kind", "value", "keywords", "watchId"].includes(key))) return undefined;
  return { id: targetId, source: state.source, kind: target.kind as ScheduledTarget["kind"], value: target.value, watchId: target.watchId, schedule: "* * * * *", keywords: Array.isArray(target.keywords) ? target.keywords.filter((x): x is string => typeof x === "string") : [] };
};
