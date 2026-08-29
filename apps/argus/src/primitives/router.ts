import { createHash } from "node:crypto";
import type { ArgusConfig } from "@argus/config";
import type { WebResolver } from "@argus/source-web";
import { type Context, Hono } from "hono";
import {
  PrimitiveBoundaryError,
  PrimitiveRateLimiter,
  resolveWebSearchPrimitive,
  resolveXPrimitive,
} from "./policy.js";
import {
  PrimitiveTransportError,
  requestPrimitive,
} from "./transport.js";

export interface PrimitiveRouterInput {
  config: ArgusConfig;
  fetcher?: typeof fetch;
  limiter?: PrimitiveRateLimiter;
  resolver?: WebResolver;
}

const errorResponse = (
  context: Context,
  code: string,
  message: string,
  status: 400 | 409 | 429 | 502,
  retryAfterSeconds?: number,
) =>
  context.json(
    { error: { code, message } },
    status,
    retryAfterSeconds === undefined
      ? undefined
      : { "retry-after": String(retryAfterSeconds) },
  );

export const createPrimitiveRouter = ({
  config,
  fetcher,
  limiter = new PrimitiveRateLimiter(),
  resolver,
}: PrimitiveRouterInput): Hono => {
  const app = new Hono();
  const tokenDigest = config.api.token
    ? createHash("sha256").update(config.api.token).digest("hex")
    : undefined;

  const proxy = async (
    context: Context,
    source: "x" | "web",
    upstream: () => URL,
    method: "GET" | "HEAD" = "GET",
  ) => {
    if (!tokenDigest) {
      return errorResponse(
        context,
        "PRIMITIVE_AUTH_REQUIRED",
        "Configure api.token before using source primitives.",
        409,
      );
    }
    const limit = limiter.consume(tokenDigest, source);
    if (!limit.allowed) {
      return errorResponse(
        context,
        "PRIMITIVE_RATE_LIMITED",
        "Source primitive rate limit exceeded.",
        429,
        limit.retryAfterSeconds,
      );
    }
    try {
      const result = await requestPrimitive({
        url: upstream(),
        method,
        safety: source === "x" || config.sources.web.searchEndpointTrust === "public"
          ? "public"
          : "trusted",
        ...(fetcher ? { fetcher } : {}),
        ...(resolver ? { resolver } : {}),
      });
      const body = Uint8Array.from(result.body).buffer;
      return new Response(method === "HEAD" ? null : body, {
        status: result.status,
        headers: { "content-type": result.contentType },
      });
    } catch (error) {
      if (error instanceof PrimitiveBoundaryError) {
        return errorResponse(
          context,
          error.code,
          "The primitive request is outside the configured source boundary.",
          400,
        );
      }
      if (error instanceof PrimitiveTransportError) {
        return errorResponse(
          context,
          error.code,
          "The configured source primitive failed safely.",
          502,
        );
      }
      throw error;
    }
  };

  app.on(["GET", "HEAD"], "/x/*", (context) => {
    if (!config.sources.x.enabled) {
      return errorResponse(
        context,
        "PRIMITIVE_SOURCE_DISABLED",
        "The X source is disabled.",
        409,
      );
    }
    const marker = "/v1/primitives/x";
    const path = new URL(context.req.url).pathname.slice(
      new URL(context.req.url).pathname.indexOf(marker) + marker.length,
    );
    return proxy(
      context,
      "x",
      () =>
        resolveXPrimitive(
          config.sources.x.endpoint,
          path,
          new URL(context.req.url).searchParams,
        ),
      context.req.method === "HEAD" ? "HEAD" : "GET",
    );
  });

  app.get("/web/search", (context) => {
    if (!config.sources.web.enabled || !config.sources.web.searchEndpoint) {
      return errorResponse(
        context,
        "PRIMITIVE_SOURCE_DISABLED",
        "Web search is disabled.",
        409,
      );
    }
    const query = context.req.query("q")?.trim();
    if (!query) {
      return errorResponse(
        context,
        "PRIMITIVE_QUERY_INVALID",
        "A non-empty q parameter is required.",
        400,
      );
    }
    return proxy(context, "web", () =>
      resolveWebSearchPrimitive(
        config.sources.web.searchEndpoint as string,
        new URL(context.req.url).searchParams,
      ),
    );
  });
  return app;
};
