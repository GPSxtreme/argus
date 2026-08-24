import { hostname } from "node:os";
import { type ArgusConfig, loadConfig, reconcileConfig } from "@argus/config";
import type { StorageRepository } from "@argus/contracts";
import { backoffDelay, enqueueDueTargets } from "@argus/scheduler";
import { SAFE_HTTP_MAX_TIMEOUT_MS } from "@argus/source-web";
import { type ServerType, serve } from "@hono/node-server";
import { Cron } from "croner";
import pino from "pino";
import { createApp } from "./app.js";
import { runSummaryProcessor } from "./processor.js";
import { openRepository, type RepositoryHandle } from "./repository.js";
import { type AdapterFactory, createAdapterFactory, findDiagnosticTarget, findTarget, runTarget } from "./worker.js";

const logger = pino({ name: "argus" });
export const JOB_LEASE_MS = SAFE_HTTP_MAX_TIMEOUT_MS * 3;

interface JobLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

const isLoopbackHost = (host: string): boolean =>
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "::ffff:127.0.0.1" ||
  host === "localhost";

export const assertApiBindGuard = (config: ArgusConfig): void => {
  if (!config.api.token && !isLoopbackHost(config.api.host)) {
    throw new Error(
      "api.token is required when the API binds a non-loopback host",
    );
  }
};

export interface MigrationRuntimeDependencies {
  loadConfig?: typeof loadConfig;
  openRepository?: typeof openRepository;
}

/** Opens and closes the configured repository so its storage implementation applies migrations. */
export const migrateRuntime = async (
  configPath: string,
  environment: Record<string, string | undefined> = process.env,
  { loadConfig: load = loadConfig, openRepository: open = openRepository }: MigrationRuntimeDependencies = {},
): Promise<void> => {
  const config = await load(configPath, environment);
  const repository = await open(config);
  await repository.close();
};

export const resolveRuntimeRole = (
  config: ArgusConfig,
  requestedRole?: string,
): ArgusConfig => {
  if (!requestedRole) return config;
  if (
    !["all", "api", "scheduler", "worker", "processor"].includes(requestedRole)
  ) {
    throw new Error(`Invalid ARGUS_ROLE: ${requestedRole}`);
  }
  if (config.storage.adapter === "sqlite" && requestedRole !== "all") {
    throw new Error("SQLite requires runtime.role to be 'all'");
  }
  return {
    ...config,
    runtime: { role: requestedRole as ArgusConfig["runtime"]["role"] },
  };
};

export interface ProcessNextJobDependencies {
  runTarget?: typeof runTarget;
  adapterFactory?: AdapterFactory;
  workerId?: string;
  logger?: JobLogger;
}

export const processNextJob = async (
  config: ArgusConfig,
  repository: StorageRepository,
  {
    runTarget: execute = runTarget,
    adapterFactory,
    workerId = `${hostname()}:${process.pid}`,
    logger: jobLogger = logger,
  }: ProcessNextJobDependencies = {},
): Promise<{ status: "idle" | "complete" | "failed" | "cancelled" }> => {
  const adapters = adapterFactory ?? createAdapterFactory(config);
  const job = (await repository.claimJobs(workerId, 1, JOB_LEASE_MS))[0];
  if (!job) return { status: "idle" };
  if (!job.leaseToken) throw new Error("Claimed job is missing its lease token");
  const isDiagnostic = job.targetId.startsWith("__argus_doctor:");
  const diagnostic = await repository.getDiagnosticWatch(job.targetId);
  if (isDiagnostic && diagnostic?.status !== "active") {
    await repository.completeJob(job.id, workerId, job.leaseToken);
    return { status: "cancelled" };
  }
  try {
    const target =
      findTarget(config, job.targetId) ??
      (await findDiagnosticTarget(repository, job.targetId));
    if (!target) throw new Error(`Unknown target: ${job.targetId}`);
    const result = await execute(
      target,
      config,
      repository,
      adapters(target),
      diagnostic
        ? async () =>
            (await repository.getDiagnosticWatch(job.targetId))?.status ===
            "active"
        : undefined,
      isDiagnostic ? job.id : undefined,
      isDiagnostic ? { owner: workerId, token: job.leaseToken } : undefined,
    );
    if (diagnostic && result.diagnosticCommitted === false) {
      return { status: "cancelled" };
    }
    if (
      isDiagnostic &&
      result.diagnosticCommitted === undefined &&
      (await repository.getDiagnosticWatch(job.targetId))?.status !== "active"
    ) {
      await repository.completeJob(job.id, workerId, job.leaseToken);
      return { status: "cancelled" };
    }
    if (!isDiagnostic || result.diagnosticCommitted === undefined) {
      await repository.completeJob(job.id, workerId, job.leaseToken);
    }
    jobLogger.info(
      { jobId: job.id, targetId: job.targetId, ...result },
      "job complete",
    );
    return { status: "complete" };
  } catch (error) {
    if (
      isDiagnostic &&
      (await repository.getDiagnosticWatch(job.targetId))?.status !== "active"
    ) {
      await repository.completeJob(job.id, workerId, job.leaseToken);
      return { status: "cancelled" };
    }
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
    const failureSettled = await repository.failJob(
      job.id,
      workerId,
      job.leaseToken,
      message,
      retryAt,
    );
    if (!failureSettled) {
      jobLogger.warn(
        {
          jobId: job.id,
          targetId: job.targetId,
          source: job.source,
          attempt: job.attempt + 1,
          error: message,
        },
        "job failure settlement lost lease",
      );
      return { status: "failed" };
    }
    const logContext = {
      jobId: job.id,
      targetId: job.targetId,
      source: job.source,
      attempt: job.attempt + 1,
      maxAttempts: 6,
      ...(retryAt ? { retryAt } : {}),
      error: message,
    };
    if (retryAt) {
      jobLogger.warn(logContext, "job retry scheduled");
    } else {
      jobLogger.error(logContext, "job failed permanently");
    }
    return { status: "failed" };
  }
};

const processJobs = async (
  config: ArgusConfig,
  repository: StorageRepository,
  adapterFactory: AdapterFactory,
): Promise<void> => {
  await repository.reapExpiredDiagnosticWatches();
  for (let index = 0; index < 10; index += 1) if ((await processNextJob(config, repository, { adapterFactory })).status === "idle") return;
};

export interface RuntimeHandle {
  config: ArgusConfig;
  repository: RepositoryHandle;
  server?: ServerType;
  stop(): Promise<void>;
}

export const startRuntime = async (
  configPath: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<RuntimeHandle> => {
  const loaded = await loadConfig(configPath, environment);
  const config = resolveRuntimeRole(loaded, process.env.ARGUS_ROLE);
  const adapterFactory =
    config.runtime.role === "all" || config.runtime.role === "worker"
      ? createAdapterFactory(config)
      : undefined;
  const repository = await openRepository(config);
  await reconcileConfig(repository.repository, config);
  await repository.repository.reapExpiredDiagnosticWatches();
  const timers: NodeJS.Timeout[] = [];
  const processorJobs: Cron[] = [];
  let server: ServerType | undefined;

  if (config.runtime.role === "all" || config.runtime.role === "api") {
    assertApiBindGuard(config);
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
    if (!adapterFactory) throw new Error("Worker adapter factory is unavailable");
    const tick = () =>
      void processJobs(config, repository.repository, adapterFactory).catch((error) =>
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
