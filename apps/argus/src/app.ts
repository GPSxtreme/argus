import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ArgusConfig } from "@argus/config";
import {
  InvalidRecordsCursorError,
  type StorageRepository,
} from "@argus/contracts";
import { OpenRouterClient } from "@argus/intelligence";
import { QueryService } from "@argus/query";
import { enqueueWatchNow, targetsFromConfig } from "@argus/scheduler";
import { type Handler, Hono } from "hono";
import {
  applyManagementConfig,
  inspectManagementConfig,
  type ManagementConfigPlan,
  verifyManagementConfig,
} from "./management-config.js";
import { type DiagnosticResolver, safeDiagnosticWebTarget } from "./web-safety.js";

export interface CreateAppInput {
  config: ArgusConfig;
  repository: StorageRepository;
  diagnosticResolver?: DiagnosticResolver;
}

export const API_ROUTES = {
  health: { method: "GET", path: "/health" },
  records: { method: "GET", path: "/v1/records" },
  artifacts: { method: "GET", path: "/v1/artifacts" },
  ingestWatch: { method: "POST", path: "/v1/watches/:watchId/ingest" },
  createSmokeWatch: { method: "POST", path: "/v1/diagnostics/smoke-watches" },
  smokeWatchRecords: { method: "GET", path: "/v1/diagnostics/smoke-watches/:id/records" },
  deleteSmokeWatch: { method: "DELETE", path: "/v1/diagnostics/smoke-watches/:id" },
  planManagementConfig: { method: "POST", path: "/v1/management/config/plan" },
  applyManagementConfig: { method: "POST", path: "/v1/management/config/apply" },
  verifyManagementConfig: { method: "POST", path: "/v1/management/config/verify" },
  createSummary: { method: "POST", path: "/v1/summaries" },
} as const;

type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];

const registerApiRoute = (
  app: Hono,
  route: ApiRoute,
  handler: Handler,
): void => {
  switch (route.method) {
    case "GET":
      app.get(route.path, handler);
      return;
    case "POST":
      app.post(route.path, handler);
      return;
    case "DELETE":
      app.delete(route.path, handler);
      return;
  }
};

const tokenMatches = (
  config: ArgusConfig,
  presented: string | undefined,
): boolean => {
  if (!config.api.token) return true;
  if (!presented?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(presented.slice("Bearer ".length));
  const expected = Buffer.from(config.api.token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
};

export const createApp = ({ config, repository, diagnosticResolver }: CreateAppInput): Hono => {
  const app = new Hono();
  const query = new QueryService(repository);

  registerApiRoute(app, API_ROUTES.health, (context) =>
    context.json({
      status: "ok",
      version: 2,
      role: config.runtime.role,
      intelligence: config.intelligence.enabled,
    }),
  );

  app.use("/v1/*", async (context, next) => {
    if (!tokenMatches(config, context.req.header("authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  registerApiRoute(app, API_ROUTES.records, async (context) => {
    const sources = context.req.queries("source");
    const targets = context.req.queries("target");
    const text = context.req.query("q");
    const since = context.req.query("since");
    const until = context.req.query("until");
    const cursor = context.req.query("cursor");
    const requestedLimit = context.req.query("limit");
    const limit = Number(requestedLimit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return context.json({ error: "limit must be an integer from 1 to 200" }, 400);
    }
    if (
      (since !== undefined && Number.isNaN(Date.parse(since))) ||
      (until !== undefined && Number.isNaN(Date.parse(until)))
    ) {
      return context.json(
        { error: "since and until must be ISO-8601 timestamps" },
        400,
      );
    }
    try {
      const result = await query.search({
        ...(text ? { text } : {}),
        ...(sources?.length
          ? {
              sources: sources.filter(
                (source): source is "x" | "telegram" | "web" =>
                  source === "x" || source === "telegram" || source === "web",
              ),
            }
          : {}),
        ...(targets?.length ? { targetIds: targets } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof InvalidRecordsCursorError) {
        return context.json({ error: "invalid records cursor" }, 400);
      }
      throw error;
    }
  });

  registerApiRoute(app, API_ROUTES.artifacts, async (context) => {
    const limit = Number(context.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return context.json({ error: "limit must be an integer from 1 to 200" }, 400);
    }
    return context.json(
      await repository.queryArtifacts({
        ...(context.req.query("kind")
          ? { kind: context.req.query("kind") as string }
          : {}),
        limit,
      }),
    );
  });

  registerApiRoute(app, API_ROUTES.ingestWatch, async (context) => {
    const watch = config.watches.find(
      (candidate) =>
        candidate.id === context.req.param("watchId") && candidate.enabled,
    );
    if (!watch) return context.json({ error: "watch not found" }, 404);
    const queued = await enqueueWatchNow(watch, repository);
    return context.json({ queued, watchId: watch.id }, 202);
  });

  registerApiRoute(app, API_ROUTES.createSmokeWatch, async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || !Object.keys(body).every((key) => key === "source" || key === "targetId")) return context.json({ error: "invalid diagnostic watch request" }, 400);
    const input = body as { source?: unknown; targetId?: unknown };
    if ((input.source !== "telegram" && input.source !== "web" && input.source !== "x") || typeof input.targetId !== "string" || !input.targetId) return context.json({ error: "invalid diagnostic watch request" }, 400);
    if (!config.sources[input.source].enabled) {
      return context.json(
        { error: "configured enabled diagnostic target was not found" },
        404,
      );
    }
    const target = targetsFromConfig(config).find((candidate) => candidate.id === input.targetId && candidate.source === input.source);
    if (!target) return context.json({ error: "configured enabled diagnostic target was not found" }, 404);
    if (target.source === "web" && target.kind === "url") {
      if (!(await safeDiagnosticWebTarget(target.value, diagnosticResolver))) return context.json({ error: "configured web diagnostic target is not permitted" }, 400);
    }
    const id = randomUUID();
    const targetId = `__argus_doctor:${id}`;
    const now = new Date().toISOString();
    await repository.reapExpiredDiagnosticWatches(now);
    const snapshot = { kind: target.kind, value: target.value, keywords: target.keywords, watchId: targetId };
    const created = await repository.createDiagnosticWatch({ id, targetId, source: target.source, target: snapshot, status: "active", createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), job: { id: randomUUID(), targetId, source: target.source, status: "queued", attempt: 0, runAt: now } });
    if (!created) return context.json({ error: "diagnostic watch could not be created" }, 409);
    return context.json({ id, targetId }, 202);
  });

  registerApiRoute(app, API_ROUTES.smokeWatchRecords, async (context) => {
    const targetId = `__argus_doctor:${context.req.param("id")}`;
    const state = await repository.getDiagnosticWatch(targetId);
    if (!state) return context.json({ error: "diagnostic watch not found" }, 404);
    return context.json({
      items: await repository.queryDiagnosticRecords(targetId),
    });
  });

  registerApiRoute(app, API_ROUTES.deleteSmokeWatch, async (context) => {
    const id = context.req.param("id");
    const targetId = `__argus_doctor:${id}`;
    const state = await repository.getDiagnosticWatch(targetId);
    if (!state) return context.json({ error: "diagnostic watch not found" }, 404);
    await repository.cancelDiagnosticWatch(targetId);
    await repository.cleanupDiagnosticWatch(targetId);
    return context.body(null, 204);
  });

  registerApiRoute(app, API_ROUTES.planManagementConfig, async (context) => {
    if (
      !config.api.token ||
      context.req.header("authorization") !== `Bearer ${config.api.token}`
    ) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const body = await context.req.json().catch(() => undefined) as
      | { path?: unknown; config?: unknown }
      | undefined;
    if (
      !body ||
      typeof body.path !== "string" ||
      !body.path.startsWith("/") ||
      body.config === undefined ||
      Object.keys(body).some((key) => key !== "path" && key !== "config")
    ) {
      return context.json({ error: "invalid configuration plan request" }, 400);
    }
    try {
      const result = await inspectManagementConfig(
        repository,
        body.path,
        body.config,
      );
      return context.json(result.plan);
    } catch {
      return context.json({ error: "invalid configuration plan request" }, 400);
    }
  });

  registerApiRoute(app, API_ROUTES.applyManagementConfig, async (context) => {
    if (
      !config.api.token ||
      context.req.header("authorization") !== `Bearer ${config.api.token}`
    ) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const body = await context.req.json().catch(() => undefined) as
      | { path?: unknown; config?: unknown; inspection?: unknown }
      | undefined;
    if (
      !body ||
      typeof body.path !== "string" ||
      !body.path.startsWith("/") ||
      body.config === undefined ||
      !body.inspection ||
      typeof body.inspection !== "object" ||
      Array.isArray(body.inspection) ||
      Object.keys(body).some(
        (key) => key !== "path" && key !== "config" && key !== "inspection",
      )
    ) {
      return context.json({ error: "invalid configuration apply request" }, 400);
    }
    try {
      return context.json(
        await applyManagementConfig(
          repository,
          body.path,
          body.config,
          body.inspection as ManagementConfigPlan,
        ),
      );
    } catch {
      return context.json({ error: "configuration plan is stale" }, 409);
    }
  });

  registerApiRoute(app, API_ROUTES.verifyManagementConfig, async (context) => {
    if (
      !config.api.token ||
      context.req.header("authorization") !== `Bearer ${config.api.token}`
    ) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const body = await context.req.json().catch(() => undefined) as
      | { inspection?: unknown }
      | undefined;
    if (
      !body?.inspection ||
      typeof body.inspection !== "object" ||
      Array.isArray(body.inspection) ||
      Object.keys(body).some((key) => key !== "inspection")
    ) {
      return context.json({ error: "invalid configuration verify request" }, 400);
    }
    try {
      return context.json(
        await verifyManagementConfig(
          repository,
          body.inspection as ManagementConfigPlan,
        ),
      );
    } catch {
      return context.json({ error: "configuration plan is stale" }, 409);
    }
  });

  registerApiRoute(app, API_ROUTES.createSummary, async (context) => {
    if (!config.intelligence.enabled || !config.intelligence.apiKey) {
      return context.json({ error: "intelligence is disabled" }, 409);
    }
    const request = await context.req
      .json<{
        query?: string;
        watchIds?: string[];
        limit?: number;
        prompt?: string;
      }>()
      .catch(() => undefined);
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return context.json({ error: "invalid summary request" }, 400);
    }
    const limit = request.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return context.json({ error: "limit must be an integer from 1 to 100" }, 400);
    }
    const records = await repository.queryRecords({
      ...(request.query ? { text: request.query } : {}),
      ...(request.watchIds ? { watchIds: request.watchIds } : {}),
      limit,
    });
    const result = await new OpenRouterClient({
      apiKey: config.intelligence.apiKey,
      model: config.intelligence.model,
    }).summarize(records.items, request.prompt);
    const id = randomUUID();
    await repository.saveArtifact({
      id,
      recordIds: records.items.map((record) => record.id),
      kind: "summary",
      content: result.content,
      provider: "openrouter",
      model: result.model,
      provenance: {
        generationId: result.generationId,
        sources: result.sources,
      },
      createdAt: new Date().toISOString(),
    });
    return context.json({ id, ...result }, 201);
  });

  return app;
};
