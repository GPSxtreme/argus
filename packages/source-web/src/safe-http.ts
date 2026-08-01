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
  headers?: Record<string, string>;
  redirect: "manual";
  dispatcher: unknown;
}

export type SafeHttpRequester = (
  url: URL,
  init: SafeRequestInit,
) => Promise<Response>;

export type SafeDispatcherFactory = (
  addresses: readonly ResolvedAddress[],
) => unknown;

export interface SafeHttpOptions {
  resolver?: WebResolver;
  request?: SafeHttpRequester;
  dispatcherFactory?: SafeDispatcherFactory;
  headers?: Record<string, string>;
  maxRedirects?: number;
  resolverTimeoutMs?: number;
}

export interface SafeHttpResult {
  body: string;
  finalUrl: string;
  ok: boolean;
  status: number;
}

const defaultRequest: SafeHttpRequester = async (url, init) =>
  undiciFetch(url, {
    ...("headers" in init ? { headers: init.headers } : {}),
    redirect: init.redirect,
    dispatcher: init.dispatcher as Dispatcher,
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

export const safeHttpGet = async (
  input: string | URL,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResult> => {
  const resolver = options.resolver ?? nodeWebResolver;
  const requester = options.request ?? defaultRequest;
  const dispatcherFactory =
    options.dispatcherFactory ?? createPinnedDispatcher;
  const maxRedirects = options.maxRedirects ?? 5;
  let current = parseSafeWebUrl(input);
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
    let response: Response;
    try {
      response = await requester(approved.url, {
        ...(options.headers ? { headers: options.headers } : {}),
        redirect: "manual",
        dispatcher,
      });
    } catch {
      await closeDispatcher(dispatcher);
      throw new SafeWebError("WEB_REQUEST_FAILED");
    }

    if (redirectStatuses.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      await closeDispatcher(dispatcher);
      if (redirects >= maxRedirects) {
        throw new SafeWebError("WEB_TOO_MANY_REDIRECTS");
      }
      const location = response.headers.get("location");
      if (!location) throw new SafeWebError("WEB_REDIRECT_INVALID");
      try {
        const next = parseSafeWebUrl(new URL(location, approved.url));
        if (approved.url.protocol === "https:" && next.protocol !== "https:") {
          throw new SafeWebError("WEB_REDIRECT_INVALID");
        }
        current = next;
      } catch {
        throw new SafeWebError("WEB_REDIRECT_INVALID");
      }
      continue;
    }

    try {
      return {
        body: await response.text(),
        finalUrl: approved.url.href,
        ok: response.ok,
        status: response.status,
      };
    } catch {
      throw new SafeWebError("WEB_REQUEST_FAILED");
    } finally {
      await closeDispatcher(dispatcher);
    }
  }
};
