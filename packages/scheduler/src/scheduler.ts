import { contentHash, type Job, type SourceName, type StorageRepository } from "@argus/contracts";
import type { ArgusConfig } from "@argus/config";
import { Cron } from "croner";

type Watch = ArgusConfig["watches"][number];

export interface ScheduledTarget {
  id: string;
  source: SourceName;
  watchId: string;
  schedule: string;
  kind: "account" | "query" | "channel" | "url" | "feed";
  value: string;
  keywords: string[];
}

const target = (
  watch: Watch,
  source: SourceName,
  kind: ScheduledTarget["kind"],
  value: string,
): ScheduledTarget => ({
  id: `${watch.id}:${source}:${kind}:${encodeURIComponent(value)}`,
  source,
  watchId: watch.id,
  schedule: watch.schedule,
  kind,
  value,
  keywords: watch.classify.keywords,
});

export const expandWatchTargets = (watch: Watch): ScheduledTarget[] => [
  ...(watch.inputs.x?.accounts ?? []).map((value) =>
    target(watch, "x", "account", value),
  ),
  ...(watch.inputs.x?.queries ?? []).map((value) =>
    target(watch, "x", "query", value),
  ),
  ...(watch.inputs.telegram?.channels ?? []).map((value) =>
    target(watch, "telegram", "channel", value),
  ),
  ...(watch.inputs.web?.urls ?? []).map((value) =>
    target(watch, "web", "url", value),
  ),
  ...(watch.inputs.web?.feeds ?? []).map((value) =>
    target(watch, "web", "feed", value),
  ),
  ...(watch.inputs.web?.queries ?? []).map((value) =>
    target(watch, "web", "query", value),
  ),
];

export const targetsFromConfig = (config: ArgusConfig): ScheduledTarget[] =>
  config.watches.filter((watch) => watch.enabled).flatMap(expandWatchTargets);

export const enqueueDueTargets = async (
  config: ArgusConfig,
  repository: StorageRepository,
  now = new Date(),
): Promise<number> => {
  let queued = 0;
  for (const scheduled of targetsFromConfig(config)) {
    const previousMinute = new Date(now.getTime() - 60_000);
    const next = new Cron(scheduled.schedule, { paused: true }).nextRun(previousMinute);
    if (!next || next > now) continue;
    const runAt = next.toISOString();
    const job: Job = {
      id: contentHash({ targetId: scheduled.id, runAt }).slice(0, 32),
      targetId: scheduled.id,
      source: scheduled.source,
      status: "queued",
      attempt: 0,
      runAt,
    };
    if (await repository.enqueueJob(job)) queued += 1;
  }
  return queued;
};
