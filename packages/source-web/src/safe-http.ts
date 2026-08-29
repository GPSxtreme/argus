import type {
  LookupAddress,
  LookupAllOptions,
  LookupOneOptions,
} from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import {
  nodeWebResolver,
  parseSafeWebUrl,
  resolvePublicWebUrl,
  SafeWebError,
  type ResolvedAddress,
  type WebResolver,
} from "./network-policy.js";

export interface SafeRequestInit {
  method: "GET" | "HEAD";
  headers?: Record<string, string>;
  redirect: "manual";
  dispatcher: unknown;
  signal: AbortSignal;
}

export type SafeHttpRequester = (
  url: URL,
  init: SafeRequestInit,
) => Promise<Response>;

export type SafeDispatcherFactory = (
  addresses: readonly ResolvedAddress[],
) => unknown;

export interface SafeHttpOptions {
  allowedOrigin?: string;
  method?: "GET" | "HEAD";
  resolver?: WebResolver;
  request?: SafeHttpRequester;
  dispatcherFactory?: SafeDispatcherFactory;
  headers?: Record<string, string>;
  maxRedirects?: number;
  resolverTimeoutMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface SafeHttpResult {
  body: string;
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  ok: boolean;
  status: number;
}

const defaultRequest: SafeHttpRequester = async (url, init) =>
  undiciFetch(url, {
    ...("headers" in init ? { headers: init.headers } : {}),
    redirect: init.redirect,
    dispatcher: init.dispatcher as Dispatcher,
    signal: init.signal,
  }) as unknown as Response;

const createPinnedDispatcher: SafeDispatcherFactory = (addresses) => {
  const pinnedLookup = ((
    _hostname: string,
    options: LookupOneOptions | LookupAllOptions | number,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const requestedFamily =
      typeof options === "number" ? options : (options.family ?? 0);
    const eligible = addresses.filter(
      (answer) => requestedFamily === 0 || answer.family === requestedFamily,
    );
    if (eligible.length === 0) {
      const error = new Error("No approved address for requested family");
      (error as NodeJS.ErrnoException).code = "ENOTFOUND";
      callback(error, "");
      return;
    }
    if (typeof options !== "number" && options.all) {
      callback(
        null,
        eligible.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    callback(null, eligible[0]?.address ?? "", eligible[0]?.family);
  }) as unknown as LookupFunction;

  return new Agent({
    connect: { lookup: pinnedLookup },
    maxResponseSize: 10 * 1024 * 1024,
  });
};

const closeDispatcher = async (dispatcher: unknown): Promise<void> => {
  if (
    dispatcher &&
    typeof dispatcher === "object" &&
    "close" in dispatcher &&
    typeof dispatcher.close === "function"
  ) {
    await dispatcher.close();
  }
};

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
export const SAFE_HTTP_MAX_TIMEOUT_MS = 20_000;
const defaultTimeoutMs = 10_000;
const defaultMaxBodyBytes = 2 * 1024 * 1024;
const maximumBodyBytes = 10 * 1024 * 1024;

const boundedNumber = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), minimum), maximum)
    : fallback;

export const readBoundedBytes = async (
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) ||
      Number(declared) > maximumBytes)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new SafeWebError("WEB_RESPONSE_TOO_LARGE");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new SafeWebError("WEB_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
): Promise<string> => new TextDecoder().decode(await readBoundedBytes(response, maximumBytes));

export const safeHttpGet = async (
  input: string | URL,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResult> => {
  const resolver = options.resolver ?? nodeWebResolver;
  const requester = options.request ?? defaultRequest;
  const dispatcherFactory =
    options.dispatcherFactory ?? createPinnedDispatcher;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = boundedNumber(
    options.timeoutMs,
    defaultTimeoutMs,
    10,
    SAFE_HTTP_MAX_TIMEOUT_MS,
  );
  const maxBodyBytes = boundedNumber(
    options.maxBodyBytes,
    defaultMaxBodyBytes,
    1,
    maximumBodyBytes,
  );
  const method = options.method ?? "GET";
  const controller = new AbortController();
  const activeDispatchers = new Set<unknown>();
  const dispatcherClosures = new Map<unknown, Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const releaseDispatcher = (dispatcher: unknown): Promise<void> => {
    activeDispatchers.delete(dispatcher);
    const existing = dispatcherClosures.get(dispatcher);
    if (existing) return existing;
    const closing = closeDispatcher(dispatcher).catch(() => undefined);
    dispatcherClosures.set(dispatcher, closing);
    return closing;
  };

  const perform = async (): Promise<SafeHttpResult> => {
    let current = parseSafeWebUrl(input);
    if (options.allowedOrigin && current.origin !== options.allowedOrigin) {
      throw new SafeWebError("WEB_DESTINATION_INVALID");
    }
    const visited = new Set<string>();
    for (let redirects = 0; ; redirects += 1) {
      const canonical = current.href;
      if (visited.has(canonical)) throw new SafeWebError("WEB_REDIRECT_LOOP");
      visited.add(canonical);

      const approved = await resolvePublicWebUrl(
        current,
        resolver,
        options.resolverTimeoutMs,
      );
      const dispatcher = dispatcherFactory(approved.addresses);
      activeDispatchers.add(dispatcher);
      let response: Response;
      try {
        response = await requester(approved.url, {
          method,
          ...(options.headers ? { headers: options.headers } : {}),
          redirect: "manual",
          dispatcher,
          signal: controller.signal,
        });
      } catch {
        await releaseDispatcher(dispatcher);
        throw new SafeWebError("WEB_REQUEST_FAILED");
      }

      if (redirectStatuses.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        await releaseDispatcher(dispatcher);
        if (redirects >= maxRedirects) {
          throw new SafeWebError("WEB_TOO_MANY_REDIRECTS");
        }
        const location = response.headers.get("location");
        if (!location) throw new SafeWebError("WEB_REDIRECT_INVALID");
        try {
          const next = parseSafeWebUrl(new URL(location, approved.url));
          if (options.allowedOrigin && next.origin !== options.allowedOrigin) {
            throw new SafeWebError("WEB_REDIRECT_INVALID");
          }
          if (
            approved.url.protocol === "https:" &&
            next.protocol !== "https:"
          ) {
            throw new SafeWebError("WEB_REDIRECT_INVALID");
          }
          current = next;
        } catch {
          throw new SafeWebError("WEB_REDIRECT_INVALID");
        }
        continue;
      }

      try {
        let bytes: Uint8Array;
        if (method === "HEAD") {
          await response.body?.cancel().catch(() => undefined);
          bytes = new Uint8Array();
        } else {
          bytes = await readBoundedBytes(response, maxBodyBytes);
        }
        return {
          body: new TextDecoder().decode(bytes),
          bytes,
          contentType: response.headers.get("content-type") ?? "application/octet-stream",
          finalUrl: approved.url.href,
          ok: response.ok,
          status: response.status,
        };
      } catch (error) {
        if (error instanceof SafeWebError) throw error;
        throw new SafeWebError("WEB_REQUEST_FAILED");
      } finally {
        await releaseDispatcher(dispatcher);
      }
    }
  };

  const work = perform();
  void work.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafeWebError("WEB_REQUEST_FAILED"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    for (const dispatcher of activeDispatchers) {
      void releaseDispatcher(dispatcher).catch(() => undefined);
    }
  }
};
