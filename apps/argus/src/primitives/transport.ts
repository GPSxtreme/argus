const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class PrimitiveTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PrimitiveTransportError";
  }
}

const boundedBytes = async (response: Response): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) ||
      Number(declared) > MAX_BODY_BYTES)
  ) {
    void response.body?.cancel();
    throw new PrimitiveTransportError("PRIMITIVE_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel();
        throw new PrimitiveTransportError("PRIMITIVE_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export interface PrimitiveTransportInput {
  url: URL;
  method: "GET" | "HEAD";
  fetcher?: typeof fetch;
}

export interface PrimitiveTransportResult {
  status: number;
  contentType: string;
  body: Uint8Array;
  bytes: number;
  durationMs: number;
}

export const requestPrimitive = async ({
  url,
  method,
  fetcher = fetch,
}: PrimitiveTransportInput): Promise<PrimitiveTransportResult> => {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let current = url;
  const origin = url.origin;
  try {
    for (let redirects = 0; ; redirects += 1) {
      let response: Response;
      try {
        response = await fetcher(current, {
          method,
          redirect: "manual",
          headers: {
            accept: "application/json",
            "user-agent": "Argus/0.1",
          },
          signal: controller.signal,
        });
      } catch {
        throw new PrimitiveTransportError("PRIMITIVE_UPSTREAM_FAILED");
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        void response.body?.cancel();
        if (redirects >= MAX_REDIRECTS) {
          throw new PrimitiveTransportError("PRIMITIVE_TOO_MANY_REDIRECTS");
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new PrimitiveTransportError("PRIMITIVE_REDIRECT_INVALID");
        }
        const next = new URL(location, current);
        if (next.origin !== origin) {
          throw new PrimitiveTransportError("PRIMITIVE_REDIRECT_INVALID");
        }
        current = next;
        continue;
      }
      const body = method === "HEAD" ? new Uint8Array() : await boundedBytes(response);
      return {
        status: response.status,
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
        body,
        bytes: body.byteLength,
        durationMs: Math.max(0, performance.now() - startedAt),
      };
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
};
