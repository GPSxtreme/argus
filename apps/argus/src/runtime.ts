import { hostname } from "node:os";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig, reconcileConfig, type ArgusConfig } from "@argus/config";
import type { StorageRepository } from "@argus/contracts";
import { backoffDelay, enqueueDueTargets } from "@argus/scheduler";
import pino from "pino";
import { Cron } from "croner";
import { createApp } from "./app.js";
import { runSummaryProcessor } from "./processor.js";
import { openRepository, type RepositoryHandle } from "./repository.js";
import { findTarget, runTarget } from "./worker.js";

const logger = pino({ name: "argus" });

const processJobs = async (
  config: ArgusConfig,
  repository: StorageRepository,
): Promise<void> => {
  const owner = `${hostname()}:${process.pid}`;
  for (const job of await repository.claimJobs(owner, 10, 60_000)) {
    try {
      const target = findTarget(config, job.targetId);
      if (!target) throw new Error(`Unknown target: ${job.targetId}`);
      const result = await runTarget(target, config, repository);
      await repository.completeJob(job.id);
      logger.info({ jobId: job.id, targetId: job.targetId, ...result }, "job complete");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt =
        job.attempt < 5
          ? new Date(
              Date.now() +
                backoffDelay(job.attempt, {
                  baseMs: 5_000,
                  maxMs: 15 * 60_000,
                }),
            ).toISOString()
          : undefined;
      await repository.failJob(job.id, message, retryAt);
      logger.error({ jobId: job.id, error: message }, "job failed");
    }
  }
};

export interface RuntimeHandle {
  config: ArgusConfig;
  repository: RepositoryHandle;
  server?: ServerType;
  stop(): Promise<void>;
}

export const startRuntime = async (configPath: string): Promise<RuntimeHandle> => {
  const loaded = await loadConfig(configPath);
  const requestedRole = process.env.ARGUS_ROLE;
  if (
    requestedRole &&
    !["all", "api", "scheduler", "worker", "processor"].includes(requestedRole)
  ) {
    throw new Error(`Invalid ARGUS_ROLE: ${requestedRole}`);
  }
  const config: ArgusConfig = requestedRole
    ? {
        ...loaded,
        runtime: {
          role: requestedRole as ArgusConfig["runtime"]["role"],
        },
      }
    : loaded;
  const repository = await openRepository(config);
  await reconcileConfig(repository.repository, config);
  const timers: NodeJS.Timeout[] = [];
  const processorJobs: Cron[] = [];
  let server: ServerType | undefined;

  if (config.runtime.role === "all" || config.runtime.role === "api") {
    server = serve({
      fetch: createApp({ config, repository: repository.repository }).fetch,
      hostname: config.api.host,
      port: config.api.port,
    });
    logger.info({ host: config.api.host, port: config.api.port }, "API listening");
  }
  if (config.runtime.role === "all" || config.runtime.role === "scheduler") {
    const tick = () =>
      void enqueueDueTargets(config, repository.repository).catch((error) =>
        logger.error({ error }, "scheduler tick failed"),
      );
    tick();
    timers.push(setInterval(tick, 30_000));
  }
  if (config.runtime.role === "all" || config.runtime.role === "worker") {
    const tick = () =>
      void processJobs(config, repository.repository).catch((error) =>
        logger.error({ error }, "worker tick failed"),
      );
    tick();
    timers.push(setInterval(tick, 5_000));
  }
  if (
    config.intelligence.enabled &&
    (config.runtime.role === "all" || config.runtime.role === "processor")
  ) {
    for (const processor of config.intelligence.processors) {
      if (!processor.schedule) continue;
      processorJobs.push(
        new Cron(processor.schedule, () => {
          void runSummaryProcessor(
            processor,
            config,
            repository.repository,
          ).catch((error) =>
            logger.error(
              { processorId: processor.id, error },
              "summary processor failed",
            ),
          );
        }),
      );
    }
  }

  return {
    config,
    repository,
    ...(server ? { server } : {}),
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const job of processorJobs) job.stop();
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      await repository.close();
    },
  };
};
