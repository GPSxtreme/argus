import { fetch as undiciFetch } from "undici";

declare const trustedServiceBrand: unique symbol;

export interface TrustedServiceOrigin {
  readonly [trustedServiceBrand]: true;
}

export class TrustedServiceError extends Error {
  constructor(
    readonly code:
      | "TRUSTED_SERVICE_ORIGIN_INVALID"
      | "TRUSTED_SERVICE_REQUEST_FAILED"
      | "TRUSTED_SERVICE_REDIRECT"
      | "TRUSTED_SERVICE_RESPONSE_TOO_LARGE",
  ) {
    super("Trusted service request failed");
    this.name = "TrustedServiceError";
  }
}

const origins = new WeakMap<object, string>();

export const createTrustedServiceOrigin = (
  configuredEndpoint: string,
): TrustedServiceOrigin => {
  let endpoint: URL;
  try {
    endpoint = new URL(configuredEndpoint);
  } catch {
    throw new TrustedServiceError("TRUSTED_SERVICE_ORIGIN_INVALID");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.hostname
  ) {
    throw new TrustedServiceError("TRUSTED_SERVICE_ORIGIN_INVALID");
  }
  const capability = Object.freeze({}) as TrustedServiceOrigin;
  origins.set(capability, endpoint.origin);
  return capability;
};

export interface TrustedServiceRequestInit {
  method: "GET";
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
}

export type TrustedServiceRequester = (
  url: URL,
  init: TrustedServiceRequestInit,
) => Promise<Response>;

export interface TrustedServiceRequestOptions {
  request?: TrustedServiceRequester;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

const defaultRequester: TrustedServiceRequester = async (url, init) =>
  undiciFetch(url, init) as unknown as Response;

const readBoundedBody = async (
  response: Response,
  maxBodyBytes: number,
): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new TrustedServiceError("TRUSTED_SERVICE_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TrustedServiceError) throw error;
    throw new TrustedServiceError("TRUSTED_SERVICE_REQUEST_FAILED");
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

export const requestTrustedSearch = async (
  capability: TrustedServiceOrigin,
  query: string,
  options: TrustedServiceRequestOptions = {},
): Promise<{ body: string; ok: boolean; status: number }> => {
  const origin = origins.get(capability);
  if (!origin) throw new TrustedServiceError("TRUSTED_SERVICE_ORIGIN_INVALID");
  const url = new URL("/search", origin);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  let response: Response;
  try {
    response = await (options.request ?? defaultRequester)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new TrustedServiceError("TRUSTED_SERVICE_REDIRECT");
    }
    return {
      body: await readBoundedBody(
        response,
        options.maxBodyBytes ?? 1024 * 1024,
      ),
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    if (error instanceof TrustedServiceError) throw error;
    throw new TrustedServiceError("TRUSTED_SERVICE_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
  }
};
