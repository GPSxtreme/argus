import { createHash } from "node:crypto";
import { z } from "zod";
import { DeploymentError } from "./errors.js";

export const ARGUS_FXEMBED_WORKER_NAME = "argus-fxembed";

const defaultApiBaseUrl = "https://api.cloudflare.com/client/v4";
const defaultRequestTimeoutMs = 10_000;
const maximumRequestTimeoutMs = 30_000;
const mainModule = "index.js";
const sha256Pattern = /^[a-f0-9]{64}$/;
const compatibilityDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export interface FxEmbedBundle {
  script: Uint8Array;
  sha256: string;
  compatibilityDate: string;
}

export interface CloudflareWorkersClient {
  inspectWorker?(
    accountId: string,
    name: string,
  ): Promise<{
    bundleHash?: string;
    endpoint: string;
    workersDevEnabled: boolean;
  }>;
  getWorker(
    accountId: string,
    name: string,
  ): Promise<{ etag?: string; bundleHash?: string } | undefined>;
  putWorker(input: {
    accountId: string;
    name: string;
    bundle: FxEmbedBundle;
    token: string;
  }): Promise<void>;
  enableWorkersDev(accountId: string, name: string, token: string): Promise<string>;
}

export type CloudflareFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareWorkersApiClientOptions {
  token: string;
  fetcher?: CloudflareFetcher;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
}

const workerSettingsSchema = z
  .object({
    annotations: z
      .object({
        "workers/tag": z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const workerSubdomainSchema = z
  .object({
    enabled: z.boolean(),
    previews_enabled: z.boolean(),
  })
  .passthrough();

const accountSubdomainSchema = z
  .object({
    subdomain: z.string().min(1),
  })
  .passthrough();

const uploadResultSchema = z.object({}).passthrough();
const cloudflareEnvelopeSchema = z
  .object({
    success: z.literal(true),
    result: z.unknown(),
  })
  .passthrough();

const boundedTimeout = (timeoutMs: number | undefined): number => {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return defaultRequestTimeoutMs;
  return Math.min(Math.max(1, timeoutMs), maximumRequestTimeoutMs);
};

const pathSegment = (value: string): string => encodeURIComponent(value);

const isRealCompatibilityDate = (value: string): boolean => {
  if (!compatibilityDatePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const assertBundle = (bundle: FxEmbedBundle): void => {
  if (!sha256Pattern.test(bundle.sha256)) {
    throw new DeploymentError(
      "FXEMBED_BUNDLE_HASH_INVALID",
      "Managed FxEmbed bundle must have a lowercase SHA-256 digest.",
    );
  }
  if (!isRealCompatibilityDate(bundle.compatibilityDate)) {
    throw new DeploymentError(
      "FXEMBED_COMPATIBILITY_DATE_INVALID",
      "Managed FxEmbed bundle must have a real pinned compatibility date.",
    );
  }
  if (bundle.script.byteLength === 0) {
    throw new DeploymentError(
      "FXEMBED_BUNDLE_EMPTY",
      "Managed FxEmbed bundle script must not be empty.",
    );
  }
  const scriptHash = createHash("sha256").update(bundle.script).digest("hex");
  if (scriptHash !== bundle.sha256) {
    throw new DeploymentError(
      "FXEMBED_BUNDLE_HASH_MISMATCH",
      "Managed FxEmbed bundle SHA-256 does not match its script.",
    );
  }
};

/**
 * Minimal Cloudflare Workers Script API client.
 *
 * The API token remains in memory and is supplied only as an Authorization
 * header. Response bodies are deliberately excluded from thrown diagnostics.
 */
export class CloudflareWorkersApiClient implements CloudflareWorkersClient {
  readonly #token: string;
  private readonly fetcher: CloudflareFetcher;
  private readonly apiBaseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor({
    token,
    fetcher = fetch,
    apiBaseUrl = defaultApiBaseUrl,
    requestTimeoutMs,
  }: CloudflareWorkersApiClientOptions) {
    this.#token = token;
    this.fetcher = fetcher;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = boundedTimeout(requestTimeoutMs);
  }

  async getWorker(
    accountId: string,
    name: string,
  ): Promise<{ etag?: string; bundleHash?: string } | undefined> {
    const response = await this.request(
      `/accounts/${pathSegment(accountId)}/workers/scripts/${pathSegment(name)}/settings`,
      { method: "GET" },
      this.#token,
      true,
    );
    if (response === undefined) return undefined;
    const settings = await this.readEndpoint(response, workerSettingsSchema);
    const bundleHash = settings.annotations?.["workers/tag"];
    const etag = response.headers.get("etag") ?? undefined;
    return {
      ...(etag === undefined ? {} : { etag }),
      ...(bundleHash === undefined ? {} : { bundleHash }),
    };
  }

  async inspectWorker(
    accountId: string,
    name: string,
  ): Promise<{
    bundleHash?: string;
    endpoint: string;
    workersDevEnabled: boolean;
  }> {
    const worker = await this.getWorker(accountId, name);
    const accountResponse = await this.request(
      `/accounts/${pathSegment(accountId)}/workers/subdomain`,
      { method: "GET" },
      this.#token,
    );
    if (accountResponse === undefined) {
      throw this.invalidResponse();
    }
    const account = await this.readEndpoint(
      accountResponse,
      accountSubdomainSchema,
    );
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(account.subdomain)) {
      throw new DeploymentError(
        "CLOUDFLARE_SUBDOMAIN_INVALID",
        "Cloudflare returned an invalid workers.dev account subdomain.",
      );
    }
    let workersDevEnabled = false;
    if (worker !== undefined) {
      const subdomainResponse = await this.request(
        `/accounts/${pathSegment(accountId)}/workers/scripts/${pathSegment(name)}/subdomain`,
        { method: "GET" },
        this.#token,
      );
      if (subdomainResponse === undefined) throw this.invalidResponse();
      workersDevEnabled = (
        await this.readEndpoint(subdomainResponse, workerSubdomainSchema)
      ).enabled;
    }
    return {
      ...(worker?.bundleHash === undefined
        ? {}
        : { bundleHash: worker.bundleHash }),
      endpoint: `https://${name}.${account.subdomain}.workers.dev`,
      workersDevEnabled,
    };
  }

  async putWorker({
    accountId,
    name,
    bundle,
    token,
  }: {
    accountId: string;
    name: string;
    bundle: FxEmbedBundle;
    token: string;
  }): Promise<void> {
    assertBundle(bundle);
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        main_module: mainModule,
        compatibility_date: bundle.compatibilityDate,
        annotations: { "workers/tag": bundle.sha256 },
      }),
    );
    form.set(
      mainModule,
      new Blob([Uint8Array.from(bundle.script).buffer], {
        type: "application/javascript+module",
      }),
      mainModule,
    );
    const response = await this.request(
      `/accounts/${pathSegment(accountId)}/workers/scripts/${pathSegment(name)}`,
      { method: "PUT", body: form },
      token,
    );
    if (response === undefined) {
      throw new DeploymentError(
        "CLOUDFLARE_HTTP_ERROR",
        "Cloudflare Workers API request was rejected.",
      );
    }
    await this.readEndpoint(response, uploadResultSchema);
  }

  async enableWorkersDev(accountId: string, name: string, token: string): Promise<string> {
    const workerPath =
      `/accounts/${pathSegment(accountId)}/workers/scripts/${pathSegment(name)}/subdomain`;
    const currentResponse = await this.request(workerPath, { method: "GET" }, token);
    if (currentResponse === undefined) {
      throw new DeploymentError(
        "CLOUDFLARE_HTTP_ERROR",
        "Cloudflare Workers API request was rejected.",
      );
    }
    const current = await this.readEndpoint(currentResponse, workerSubdomainSchema);
    if (!current.enabled) {
      const enabledResponse = await this.request(
        workerPath,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, previews_enabled: false }),
        },
        token,
      );
      if (enabledResponse === undefined) {
        throw new DeploymentError(
          "CLOUDFLARE_HTTP_ERROR",
          "Cloudflare Workers API request was rejected.",
        );
      }
      const enabled = await this.readEndpoint(enabledResponse, workerSubdomainSchema);
      if (!enabled.enabled) {
        throw this.invalidResponse();
      }
    }

    const accountResponse = await this.request(
      `/accounts/${pathSegment(accountId)}/workers/subdomain`,
      { method: "GET" },
      token,
    );
    if (accountResponse === undefined) {
      throw new DeploymentError(
        "CLOUDFLARE_HTTP_ERROR",
        "Cloudflare Workers API request was rejected.",
      );
    }
    const account = await this.readEndpoint(accountResponse, accountSubdomainSchema);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(account.subdomain)) {
      throw new DeploymentError(
        "CLOUDFLARE_SUBDOMAIN_INVALID",
        "Cloudflare returned an invalid workers.dev account subdomain.",
      );
    }
    return `https://${name}.${account.subdomain}.workers.dev`;
  }

  private async request(
    path: string,
    init: RequestInit,
    token: string,
    allowNotFound = false,
  ): Promise<Response | undefined> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.fetcher(`${this.apiBaseUrl}${path}`, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Cloudflare Workers API request timed out."));
          }, this.requestTimeoutMs);
        }),
      ]);
      if (allowNotFound && response.status === 404) return undefined;
      if (!response.ok) {
        throw new DeploymentError(
          "CLOUDFLARE_HTTP_ERROR",
          "Cloudflare Workers API request was rejected.",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError(
        "CLOUDFLARE_REQUEST_FAILED",
        "Cloudflare Workers API request failed.",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readEndpoint<Schema extends z.ZodType>(
    response: Response,
    resultSchema: Schema,
  ): Promise<z.output<Schema>> {
    const body = response.body;
    if (body === null) throw this.invalidResponse();
    const reader = body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readBody = (async (): Promise<unknown> => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          length += value.byteLength;
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
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    })();
    try {
      const raw = await Promise.race([
        readBody,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            reject(
              new DeploymentError(
                "CLOUDFLARE_REQUEST_FAILED",
                "Cloudflare Workers API request failed.",
              ),
            );
          }, this.requestTimeoutMs);
        }),
      ]);
      const envelope = cloudflareEnvelopeSchema.safeParse(raw);
      if (!envelope.success) throw this.invalidResponse();
      const result = resultSchema.safeParse(envelope.data.result);
      if (!result.success) throw this.invalidResponse();
      return result.data;
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw this.invalidResponse();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private invalidResponse(): DeploymentError {
    return new DeploymentError(
      "CLOUDFLARE_RESPONSE_INVALID",
      "Cloudflare Workers API returned an invalid response.",
    );
  }
}

/** Inspects the deployed hash, applies only a required upload, and ensures workers.dev routing. */
export const reconcileFxEmbed = async ({
  accountId,
  workerName,
  token,
  bundle,
  client,
}: {
  accountId: string;
  workerName: string;
  token: string;
  bundle: FxEmbedBundle;
  client: CloudflareWorkersClient;
}): Promise<{ changed: boolean; endpoint: string; bundleHash: string }> => {
  if (workerName !== ARGUS_FXEMBED_WORKER_NAME) {
    throw new DeploymentError(
      "FXEMBED_WORKER_NAME_INVALID",
      `Managed FxEmbed must use the deterministic Worker name ${ARGUS_FXEMBED_WORKER_NAME}.`,
    );
  }
  assertBundle(bundle);
  const deployed = await client.getWorker(accountId, workerName);
  const changed = deployed?.bundleHash !== bundle.sha256;
  if (changed) {
    await client.putWorker({ accountId, name: workerName, bundle, token });
  }
  const endpoint = await client.enableWorkersDev(accountId, workerName, token);
  return { changed, endpoint, bundleHash: bundle.sha256 };
};
