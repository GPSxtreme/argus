import { randomUUID } from "node:crypto";
import type { ArgusConfig } from "@argus/config";
import type { StorageRepository } from "@argus/contracts";
import { OpenRouterClient } from "@argus/intelligence";
import { QueryService } from "@argus/query";
import { enqueueWatchNow } from "@argus/scheduler";
import { Hono } from "hono";

export interface CreateAppInput {
  config: ArgusConfig;
  repository: StorageRepository;
}

export const createApp = ({ config, repository }: CreateAppInput): Hono => {
  const app = new Hono();
  const query = new QueryService(repository);

  app.get("/health", (context) =>
    context.json({
      status: "ok",
      version: 1,
      role: config.runtime.role,
      intelligence: config.intelligence.enabled,
    }),
  );

  app.use("/v1/*", async (context, next) => {
    if (
      config.api.token &&
      context.req.header("authorization") !== `Bearer ${config.api.token}`
    ) {
      return context.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/v1/records", async (context) => {
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
  });

  app.get("/v1/artifacts", async (context) => {
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

  app.post("/v1/watches/:watchId/ingest", async (context) => {
    const watch = config.watches.find(
      (candidate) =>
        candidate.id === context.req.param("watchId") && candidate.enabled,
    );
    if (!watch) return context.json({ error: "watch not found" }, 404);
    const queued = await enqueueWatchNow(watch, repository);
    return context.json({ queued, watchId: watch.id }, 202);
  });

  app.post("/v1/diagnostics/smoke-watches", async (context) => {
    const body: { source?: string; targetUrl?: string } = await context.req.json<{ source?: string; targetUrl?: string }>().catch(() => ({}));
    if (body.source !== "web" || typeof body.targetUrl !== "string") {
      return context.json({ error: "only a web diagnostic target URL is supported" }, 400);
    }
    let targetUrl: URL;
    try { targetUrl = new URL(body.targetUrl); } catch { return context.json({ error: "invalid diagnostic target URL" }, 400); }
    if (!/^https?:$/.test(targetUrl.protocol)) return context.json({ error: "invalid diagnostic target URL" }, 400);
    const id = randomUUID();
    const targetId = `__argus_doctor:${id}`;
    await repository.setCheckpoint(targetId, { diagnostic: true, source: "web", kind: "url", value: targetUrl.toString(), watchId: `__argus_doctor:${id}`, deleted: false });
    await repository.enqueueJob({ id: randomUUID(), targetId, source: "web", status: "queued", attempt: 0, runAt: new Date().toISOString() });
    return context.json({ id, targetId, expectedUrl: targetUrl.toString() }, 202);
  });

  app.delete("/v1/diagnostics/smoke-watches/:id", async (context) => {
    const id = context.req.param("id");
    const targetId = `__argus_doctor:${id}`;
    const state = await repository.getCheckpoint<{ diagnostic?: boolean }>(targetId);
    if (!state?.diagnostic) return context.json({ error: "diagnostic watch not found" }, 404);
    await repository.setCheckpoint(targetId, { ...state, deleted: true });
    return context.body(null, 204);
  });

  app.post("/v1/summaries", async (context) => {
    if (!config.intelligence.enabled || !config.intelligence.apiKey) {
      return context.json({ error: "intelligence is disabled" }, 409);
    }
    const request = await context.req.json<{
      query?: string;
      watchIds?: string[];
      limit?: number;
      prompt?: string;
    }>();
    const records = await repository.queryRecords({
      ...(request.query ? { text: request.query } : {}),
      ...(request.watchIds ? { watchIds: request.watchIds } : {}),
      limit: request.limit ?? 50,
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
