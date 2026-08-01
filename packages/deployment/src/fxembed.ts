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

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
}

interface WorkerSettings {
  annotations?: {
    "workers/tag"?: string;
  };
}

interface WorkerSubdomain {
  enabled: boolean;
  previews_enabled: boolean;
}

interface AccountSubdomain {
  subdomain: string;
}

const boundedTimeout = (timeoutMs: number | undefined): number => {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return defaultRequestTimeoutMs;
  return Math.min(Math.max(1, timeoutMs), maximumRequestTimeoutMs);
};

const pathSegment = (value: string): string => encodeURIComponent(value);

const assertBundle = (bundle: FxEmbedBundle): void => {
  if (!sha256Pattern.test(bundle.sha256)) {
    throw new DeploymentError(
      "FXEMBED_BUNDLE_HASH_INVALID",
      "Managed FxEmbed bundle must have a lowercase SHA-256 digest.",
    );
  }
  if (!compatibilityDatePattern.test(bundle.compatibilityDate)) {
    throw new DeploymentError(
      "FXEMBED_COMPATIBILITY_DATE_INVALID",
      "Managed FxEmbed bundle must have a pinned compatibility date.",
    );
  }
  if (bundle.script.byteLength === 0) {
    throw new DeploymentError(
      "FXEMBED_BUNDLE_EMPTY",
      "Managed FxEmbed bundle script must not be empty.",
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
    const envelope = await this.readEnvelope<WorkerSettings>(response);
    const bundleHash = envelope.result.annotations?.["workers/tag"];
    const etag = response.headers.get("etag") ?? undefined;
    return {
      ...(etag === undefined ? {} : { etag }),
      ...(bundleHash === undefined ? {} : { bundleHash }),
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
    await this.readEnvelope(response);
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
    const current = await this.readEnvelope<WorkerSubdomain>(currentResponse);
    if (!current.result.enabled) {
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
      await this.readEnvelope<WorkerSubdomain>(enabledResponse);
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
    const account = await this.readEnvelope<AccountSubdomain>(accountResponse);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(account.result.subdomain)) {
      throw new DeploymentError(
        "CLOUDFLARE_SUBDOMAIN_INVALID",
        "Cloudflare returned an invalid workers.dev account subdomain.",
      );
    }
    return `https://${name}.${account.result.subdomain}.workers.dev`;
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

  private async readEnvelope<T>(response: Response): Promise<CloudflareEnvelope<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const envelope = (await Promise.race([
        response.json(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void response.body?.cancel().catch(() => undefined);
            reject(
              new DeploymentError(
                "CLOUDFLARE_REQUEST_FAILED",
                "Cloudflare Workers API request failed.",
              ),
            );
          }, this.requestTimeoutMs);
        }),
      ])) as CloudflareEnvelope<T>;
      if (envelope.success !== true || envelope.result === undefined) {
        throw new Error("Invalid Cloudflare response envelope.");
      }
      return envelope;
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError(
        "CLOUDFLARE_RESPONSE_INVALID",
        "Cloudflare Workers API returned an invalid response.",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
