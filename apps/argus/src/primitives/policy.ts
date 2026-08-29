export class PrimitiveBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PrimitiveBoundaryError";
  }
}

const decodedSegment = (segment: string): string => {
  let decoded = segment;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new PrimitiveBoundaryError("PRIMITIVE_PATH_INVALID");
    }
  }
  return decoded;
};

export const resolveXPrimitive = (
  endpoint: string,
  path: string,
  query = new URLSearchParams(),
): URL => {
  const configured = new URL(endpoint);
  if (
    !["http:", "https:"].includes(configured.protocol) ||
    configured.username ||
    configured.password ||
    configured.search ||
    configured.hash
  ) {
    throw new PrimitiveBoundaryError("PRIMITIVE_ORIGIN_INVALID");
  }
  if (!path.startsWith("/2/") || path.includes("?") || path.includes("#")) {
    throw new PrimitiveBoundaryError("PRIMITIVE_PATH_INVALID");
  }
  for (const segment of path.split("/")) {
    const decoded = decodedSegment(segment);
    if (decoded === "." || decoded === ".." || decoded.includes("/")) {
      throw new PrimitiveBoundaryError("PRIMITIVE_PATH_INVALID");
    }
  }
  const basePath = configured.pathname.replace(/\/+$/u, "");
  const upstream = new URL(configured.href);
  upstream.pathname = `${basePath}${path}`;
  upstream.search = query.toString();
  if (upstream.origin !== configured.origin || upstream.href.length > 4_096) {
    throw new PrimitiveBoundaryError("PRIMITIVE_ORIGIN_INVALID");
  }
  return upstream;
};

export const resolveWebSearchPrimitive = (
  endpoint: string,
  query: string,
): URL => {
  const configured = new URL(endpoint);
  if (
    !["http:", "https:"].includes(configured.protocol) ||
    configured.username ||
    configured.password ||
    configured.search ||
    configured.hash
  ) {
    throw new PrimitiveBoundaryError("PRIMITIVE_ORIGIN_INVALID");
  }
  const upstream = new URL(configured.href);
  upstream.pathname = `${configured.pathname.replace(/\/+$/u, "")}/search`;
  upstream.searchParams.set("q", query);
  upstream.searchParams.set("format", "json");
  if (upstream.href.length > 4_096) {
    throw new PrimitiveBoundaryError("PRIMITIVE_PATH_INVALID");
  }
  return upstream;
};

interface RateWindow {
  startedAt: number;
  count: number;
}

export class PrimitiveRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  consume(
    tokenDigest: string,
    source: "x" | "web",
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const key = `${tokenDigest}:${source}`;
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true };
    }
    if (current.count >= 60) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((60_000 - (now - current.startedAt)) / 1_000),
        ),
      };
    }
    current.count += 1;
    return { allowed: true };
  }
}
