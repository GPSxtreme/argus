import type { ArgusConfig } from "@argus/config";
import type {
  SourceAdapter,
  SourceItem,
  StorageRepository,
} from "@argus/contracts";
import { ingestItems } from "@argus/engine";
import { type ScheduledTarget, targetsFromConfig } from "@argus/scheduler";
import { TelegramAdapter } from "@argus/source-telegram";
import { WebAdapter } from "@argus/source-web";
import { XAdapter } from "@argus/source-x";

// biome-ignore lint/suspicious/noExplicitAny: Runtime dispatch intentionally erases source-specific adapter types.
type AnyAdapter = SourceAdapter<any, any>;

const adapterFor = (target: ScheduledTarget): AnyAdapter => {
  if (target.source === "x") return new XAdapter();
  if (target.source === "telegram") return new TelegramAdapter();
  return new WebAdapter();
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
    searchEndpoint: config.sources.web.searchEndpoint,
    userAgent: config.sources.web.userAgent,
  };
};

export const runTarget = async (
  target: ScheduledTarget,
  config: ArgusConfig,
  repository: StorageRepository,
  adapter: AnyAdapter = adapterFor(target),
): Promise<{ inserted: number; revised: number; duplicates: number }> => {
  const checkpoint = await repository.getCheckpoint<{ lastId?: string }>(
    target.id,
  );
  const items: SourceItem[] = [];
  for await (const item of adapter.pull({
    targetId: target.id,
    config: adapterConfig(target, config),
    ...(checkpoint ? { checkpoint } : {}),
  })) {
    items.push(item);
  }
  async function* sourceItems(): AsyncIterable<SourceItem> {
    yield* items;
  }
  return ingestItems({
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
  });
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
  return { id: targetId, source: state.source, kind: target.kind as ScheduledTarget["kind"], value: target.value, watchId: target.watchId, schedule: "* * * * *", keywords: Array.isArray(target.keywords) ? target.keywords.filter((x): x is string => typeof x === "string") : [] };
};
