import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArgusConfig } from "@argus/config";
import { contentHash } from "@argus/contracts";
import {
  applyDeployment,
  ARGUS_FXEMBED_WORKER_NAME,
  CloudflareWorkersApiClient,
  type CloudflareWorkersClient,
  type CommandExecutor,
  type DesiredDeployment,
  DeploymentError,
  getDeploymentStatus,
  inspectDeployment,
  loadDeploymentState,
  planDeployment,
  reconcileFxEmbed,
  renderCompose,
  renderInstanceConfig,
  renderSearxngSettings,
  saveDeploymentState,
  writeInstanceFiles,
  type OnboardingAnswersV1,
} from "@argus/deployment";
import {
  MAX_RELEASE_MANIFEST_BYTES,
  type ReleaseManifestV1,
  type VerifiedReleaseManifest,
  verifyReleaseManifestWithIdentity,
} from "@argus/release";

const withHttpDeadline = async <T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const bounded = Math.min(Math.max(1, timeoutMs), 30_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = operation(controller.signal);
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("HTTP deadline exceeded"));
      }, bounded);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};
import type {
  InstalledConfigApplication,
  InstalledConfigIntegration,
  InstalledConfigPlan,
  ProductionOnboardingIntegration,
  ReleaseOnboardingInspection,
  VerifiedOnboardingRelease,
} from "./program.js";

const maximumResponseBytes = 1024 * 1024;
const defaultTimeoutMs = 10_000;

export interface InstalledConfigIntegrationOptions {
  endpoint: string;
  token: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const requestError = (
  code: string,
  message: string,
): DeploymentError => new DeploymentError(code, message);

export const createInstalledConfigIntegration = ({
  endpoint,
  token,
  fetcher = fetch,
  timeoutMs = defaultTimeoutMs,
}: InstalledConfigIntegrationOptions): InstalledConfigIntegration => {
  const origin = new URL(endpoint);
  if (
    !(
      origin.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1", "argus.local"].includes(origin.hostname)
    ) &&
    origin.protocol !== "https:"
  ) {
    throw new TypeError(
      "Installed config integration requires loopback HTTP or HTTPS.",
    );
  }
  if (!token) {
    throw requestError(
      "CONFIG_SERVICE_TOKEN_REQUIRED",
      "The authenticated Argus service token is unavailable.",
    );
  }
  const request = async <T>(
    path: string,
    body: unknown,
    staleCode = "CONFIG_SERVICE_REQUEST_FAILED",
  ): Promise<T> => {
    try {
      return await withHttpDeadline(timeoutMs, async (signal) => {
        const response = await fetcher(new URL(path, origin), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      if (response.status === 401) {
        throw requestError(
          "CONFIG_SERVICE_UNAUTHORIZED",
          "The Argus service rejected management authentication.",
        );
      }
      if (response.status === 409) {
        throw requestError(
          staleCode,
          "The inspected configuration plan is stale.",
        );
      }
      if (!response.ok) {
        throw requestError(
          "CONFIG_SERVICE_REQUEST_FAILED",
          "The Argus configuration service request failed.",
        );
      }
      const bytes = await boundedBytes(
        response,
        maximumResponseBytes,
        "CONFIG_SERVICE_RESPONSE_INVALID",
        "The Argus configuration service response is invalid.",
      );
      if (bytes.byteLength === 0) {
        throw requestError(
          "CONFIG_SERVICE_RESPONSE_INVALID",
          "The Argus configuration service response is invalid.",
        );
      }
        return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as T;
      });
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw requestError(
        "CONFIG_SERVICE_REQUEST_FAILED",
        "The Argus configuration service request failed.",
      );
    }
  };
  const assertPlan = (value: InstalledConfigPlan): InstalledConfigPlan => {
    if (
      value.contractVersion !== 1 ||
      !/^[a-f0-9]{64}$/u.test(value.planId) ||
      !/^[a-f0-9]{64}$/u.test(value.desiredContentHash) ||
      !Array.isArray(value.operations)
    ) {
      throw requestError(
        "CONFIG_SERVICE_RESPONSE_INVALID",
        "The Argus configuration service response is invalid.",
      );
    }
    return value;
  };
  return {
    async inspect(input: { path: string; config: ArgusConfig }) {
      return assertPlan(
        await request<InstalledConfigPlan>("/v1/management/config/plan", input),
      );
    },
    async apply(input) {
      const result = await request<InstalledConfigApplication>(
        "/v1/management/config/apply",
        input,
        "CONFIG_SERVICE_PLAN_STALE",
      );
      if (result.planId !== input.inspection.planId) {
        throw requestError(
          "CONFIG_SERVICE_RESPONSE_INVALID",
          "The Argus configuration service returned a mismatched plan identity.",
        );
      }
      return result;
    },
    async verify(input) {
      const result = await request<{
        healthy: boolean;
        planId: string;
        status: unknown;
      }>("/v1/management/config/verify", {
        inspection: input.inspection,
      });
      if (result.planId !== input.inspection.planId) {
        throw requestError(
          "CONFIG_SERVICE_RESPONSE_INVALID",
          "The Argus configuration service returned a mismatched plan identity.",
        );
      }
      return result;
    },
  };
};

const maximumSignatureBytes = 64;
const maximumFxEmbedBytes = 8 * 1024 * 1024;
const releaseContextFile = "release-context.json";

interface ReleasePlan {
  contractVersion: 1;
  planId: string;
  desired: DesiredDeployment;
  deployment: ReturnType<typeof planDeployment>;
  endpoints: {
    searxng: string;
    fxembed: string;
  };
  fxembed: {
    mode: "disabled" | "external" | "managed";
    currentBundleHash?: string;
    workersDevEnabled?: boolean;
  };
}

interface PersistedReleaseContext {
  schemaVersion: 1;
  manifest: string;
  signature: string;
  fxembed: string;
}

export interface ProductionOnboardingIntegrationOptions {
  root: string;
  executor: CommandExecutor;
  manifestUrl: string;
  publicKeyPem: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  cloudflareClientFactory?: (token: string) => CloudflareWorkersClient;
}

export interface ReleaseCompositionOptions {
  root: string;
  executor: CommandExecutor;
  environment: Record<string, string | undefined>;
  apiToken?: string;
  apiPort?: number;
  fetcher?: typeof fetch;
}

export interface ProductionUpdateIntegration {
  fetchUpdateRelease(): Promise<VerifiedReleaseManifest>;
  fetchRollbackRelease(): Promise<VerifiedReleaseManifest>;
  promoteCurrentRelease(release: VerifiedReleaseManifest): Promise<void>;
}

export const createReleaseComposition = ({
  root,
  executor,
  environment,
  apiToken,
  apiPort,
  fetcher,
}: ReleaseCompositionOptions): {
  onboardingIntegration?: ProductionOnboardingIntegration;
  installedConfigIntegration?: InstalledConfigIntegration;
  updateIntegration?: ProductionUpdateIntegration;
} => {
  const encodedPublicKey = environment.ARGUS_RELEASE_PUBLIC_KEY_B64;
  const manifestUrl = environment.ARGUS_RELEASE_MANIFEST_URL;
  if ((encodedPublicKey === undefined) !== (manifestUrl === undefined)) {
    throw new DeploymentError(
      "RELEASE_COMPOSITION_INVALID",
      "The release manifest URL and embedded public key must be configured together.",
    );
  }
  let onboardingIntegration: ProductionOnboardingIntegration | undefined;
  let updateIntegration: ProductionUpdateIntegration | undefined;
  if (encodedPublicKey !== undefined && manifestUrl !== undefined) {
    const decoded = Buffer.from(encodedPublicKey, "base64");
    if (
      decoded.toString("base64") !== encodedPublicKey ||
      decoded.byteLength === 0
    ) {
      throw new DeploymentError(
        "RELEASE_COMPOSITION_INVALID",
        "The embedded release public key is invalid.",
      );
    }
    onboardingIntegration = createProductionOnboardingIntegration({
      root,
      executor,
      manifestUrl,
      publicKeyPem: decoded.toString("utf8"),
      ...(fetcher === undefined ? {} : { fetcher }),
    });
    updateIntegration = createProductionUpdateIntegration({
      root,
      manifestUrl,
      publicKeyPem: decoded.toString("utf8"),
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  }
  const installedConfigIntegration =
    onboardingIntegration === undefined ||
    apiToken === undefined ||
    apiPort === undefined
      ? undefined
      : createInstalledConfigIntegration({
          endpoint: `http://127.0.0.1:${apiPort}`,
          token: apiToken,
          ...(fetcher === undefined ? {} : { fetcher }),
        });
  return {
    ...(onboardingIntegration === undefined ? {} : { onboardingIntegration }),
    ...(updateIntegration === undefined ? {} : { updateIntegration }),
    ...(installedConfigIntegration === undefined
      ? {}
      : { installedConfigIntegration }),
  };
};

const boundedBytes = async (
  response: Response,
  maximumBytes: number,
  code: string,
  message: string,
): Promise<Uint8Array> => {
  if (!response.ok || response.body === null) {
    throw new DeploymentError(code, message);
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) ||
      Number(declared) > maximumBytes)
  ) {
    throw new DeploymentError(code, message);
  }
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
        throw new DeploymentError(code, message);
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

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const atomicBytes = async (
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const signatureUrl = (manifestUrl: string): string =>
  manifestUrl.endsWith("/manifest.json")
    ? `${manifestUrl.slice(0, -"manifest.json".length)}manifest.sig`
    : `${manifestUrl}.sig`;

export interface ProductionUpdateIntegrationOptions {
  root: string;
  manifestUrl: string;
  publicKeyPem: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

interface FetchedUpdateRelease {
  release: VerifiedReleaseManifest;
  manifestBytes: Uint8Array;
  signature: Uint8Array;
  fxembedBytes: Uint8Array;
}

export const createProductionUpdateIntegration = ({
  root,
  manifestUrl,
  publicKeyPem,
  fetcher = fetch,
  timeoutMs = defaultTimeoutMs,
}: ProductionUpdateIntegrationOptions): ProductionUpdateIntegration => {
  const fetchedReleases = new Map<string, FetchedUpdateRelease>();
  const fetchBounded = async (
    url: string,
    maximumBytes: number,
    code: string,
    message: string,
  ): Promise<Uint8Array> => {
    try {
      return await withHttpDeadline(timeoutMs, async (signal) =>
        boundedBytes(await fetcher(url, { signal }), maximumBytes, code, message),
      );
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError(code, message);
    }
  };

  const fetchVerified = async (): Promise<VerifiedReleaseManifest> => {
    const [manifestBytes, signature] = await Promise.all([
      fetchBounded(manifestUrl, MAX_RELEASE_MANIFEST_BYTES, "RELEASE_MANIFEST_DOWNLOAD_FAILED", "The bounded release manifest download failed."),
      fetchBounded(signatureUrl(manifestUrl), maximumSignatureBytes, "RELEASE_SIGNATURE_DOWNLOAD_FAILED", "The bounded release signature download failed."),
    ]);
    const release = verifyReleaseManifestWithIdentity(manifestBytes, signature, publicKeyPem);
    const fxembedBytes = await fetchBounded(
      release.manifest.assets.fxembed.url,
      maximumFxEmbedBytes,
      "RELEASE_ASSET_DOWNLOAD_FAILED",
      "The bounded FxEmbed download failed.",
    );
    if (sha256(fxembedBytes) !== release.manifest.assets.fxembed.sha256) {
      throw new DeploymentError(
        "RELEASE_ASSET_HASH_MISMATCH",
        "Downloaded FxEmbed bytes do not match the signed SHA-256.",
      );
    }
    fetchedReleases.set(release.manifestSha256, {
      release,
      manifestBytes,
      signature,
      fxembedBytes,
    });
    return release;
  };

  const promoteCurrentRelease = async (release: VerifiedReleaseManifest): Promise<void> => {
    const fetched = fetchedReleases.get(release.manifestSha256);
    if (
      fetched === undefined ||
      fetched.release.manifest.version !== release.manifest.version ||
      fetched.release.manifest.images.app.reference !== release.manifest.images.app.reference ||
      fetched.release.manifest.images.postgres.reference !== release.manifest.images.postgres.reference ||
      fetched.release.manifest.images.searxng.reference !== release.manifest.images.searxng.reference
    ) {
      throw new DeploymentError(
        "UPDATE_RELEASE_UNVERIFIED",
        "Argus can only promote the exact verified release that was downloaded for this update.",
      );
    }
    const context: PersistedReleaseContext = {
      schemaVersion: 1,
      manifest: Buffer.from(fetched.manifestBytes).toString("base64"),
      signature: Buffer.from(fetched.signature).toString("base64"),
      fxembed: Buffer.from(fetched.fxembedBytes).toString("base64"),
    };
    await atomicBytes(
      join(root, releaseContextFile),
      Buffer.from(JSON.stringify(context)),
      0o644,
    );
  };

  const fetchRollback = async (): Promise<VerifiedReleaseManifest> => {
    let parsed: PersistedReleaseContext;
    try {
      parsed = JSON.parse(await readFile(join(root, releaseContextFile), "utf8")) as PersistedReleaseContext;
    } catch {
      throw new DeploymentError("UPDATE_ROLLBACK_UNAVAILABLE", "No persisted signed release is available for rollback.");
    }
    if (
      parsed.schemaVersion !== 1 ||
      Object.keys(parsed).some(
        (key) => !["schemaVersion", "manifest", "signature", "fxembed"].includes(key),
      )
    ) {
      throw new DeploymentError("UPDATE_ROLLBACK_UNAVAILABLE", "Persisted signed rollback release is invalid.");
    }
    const release = verifyReleaseManifestWithIdentity(
      exactBase64(parsed.manifest, "UPDATE_ROLLBACK_UNAVAILABLE"),
      exactBase64(parsed.signature, "UPDATE_ROLLBACK_UNAVAILABLE"),
      publicKeyPem,
    );
    const fxembedBytes = exactBase64(parsed.fxembed, "UPDATE_ROLLBACK_UNAVAILABLE");
    if (sha256(fxembedBytes) !== release.manifest.assets.fxembed.sha256) {
      throw new DeploymentError(
        "UPDATE_ROLLBACK_UNAVAILABLE",
        "Persisted FxEmbed bytes do not match the signed rollback release.",
      );
    }
    return release;
  };

  return { fetchUpdateRelease: fetchVerified, fetchRollbackRelease: fetchRollback, promoteCurrentRelease };
};

const verifiedRelease = (
  manifest: ReleaseManifestV1,
  manifestSha256: string,
): VerifiedOnboardingRelease => ({
  version: manifest.version,
  manifestSha256,
  images: {
    argus: manifest.images.app.reference as `${string}@sha256:${string}`,
    postgres: manifest.images.postgres.reference as `${string}@sha256:${string}`,
    searxng: manifest.images.searxng.reference as `${string}@sha256:${string}`,
  },
  fxembed: {
    bundleSha256: manifest.assets.fxembed.sha256,
    compatibilityDate: manifest.assets.fxembed.compatibilityDate,
  },
});

const exactBase64 = (value: unknown, code: string): Uint8Array => {
  if (typeof value !== "string" || value.length === 0) {
    throw new DeploymentError(code, "Persisted signed release context is invalid.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new DeploymentError(code, "Persisted signed release context is invalid.");
  }
  return bytes;
};

export const createProductionOnboardingIntegration = ({
  root,
  executor,
  manifestUrl,
  publicKeyPem,
  fetcher = fetch,
  timeoutMs = defaultTimeoutMs,
  cloudflareClientFactory = (token) =>
    new CloudflareWorkersApiClient({ token }),
}: ProductionOnboardingIntegrationOptions): ProductionOnboardingIntegration => {
  const fetchBounded = async (
    url: string,
    maximumBytes: number,
    code: string,
    message: string,
  ): Promise<Uint8Array> => {
    try {
      return await withHttpDeadline(timeoutMs, async (signal) =>
        boundedBytes(
          await fetcher(url, { signal }),
          maximumBytes,
          code,
          message,
        ),
      );
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError(code, message);
    }
  };
  const fetchRelease = async () => {
    const [manifestBytes, signature] = await Promise.all([
      fetchBounded(
        manifestUrl,
        MAX_RELEASE_MANIFEST_BYTES,
        "RELEASE_MANIFEST_DOWNLOAD_FAILED",
        "The bounded release manifest download failed.",
      ),
      fetchBounded(
        signatureUrl(manifestUrl),
        maximumSignatureBytes,
        "RELEASE_SIGNATURE_DOWNLOAD_FAILED",
        "The bounded release signature download failed.",
      ),
    ]);
    const verified = verifyReleaseManifestWithIdentity(
      manifestBytes,
      signature,
      publicKeyPem,
    );
    const fxembedBytes = await fetchBounded(
      verified.manifest.assets.fxembed.url,
      maximumFxEmbedBytes,
      "RELEASE_ASSET_DOWNLOAD_FAILED",
      "The bounded FxEmbed release asset download failed.",
    );
    if (sha256(fxembedBytes) !== verified.manifest.assets.fxembed.sha256) {
      throw new DeploymentError(
        "RELEASE_ASSET_HASH_MISMATCH",
        "The FxEmbed release asset does not match the signed SHA-256.",
      );
    }
    return {
      ...verified,
      release: verifiedRelease(
        verified.manifest,
        verified.manifestSha256,
      ),
      manifestBytes,
      signature,
      fxembedBytes,
    };
  };

  const endpointsFor = async (
    answers: OnboardingAnswersV1,
    secrets: Readonly<Record<string, string>>,
  ): Promise<{
    searxng: string;
    fxembed: string;
    fxembedPlan: ReleasePlan["fxembed"];
  }> => {
    const searxng =
      answers.managed.searxng === "managed"
        ? "http://searxng:8080"
        : answers.managed.searxng === "external"
          ? (answers.external?.searxngEndpoint ??
            (() => {
              throw new DeploymentError(
                "SEARXNG_ENDPOINT_REQUIRED",
                "External SearXNG requires an endpoint.",
              );
            })())
          : "http://searxng.invalid";
    if (answers.managed.fxembed === "external") {
      const fxembed = answers.external?.fxembedEndpoint;
      if (fxembed === undefined) {
        throw new DeploymentError(
          "FXEMBED_ENDPOINT_REQUIRED",
          "External FxEmbed requires an endpoint.",
        );
      }
      return {
        searxng,
        fxembed,
        fxembedPlan: { mode: "external" },
      };
    }
    if (answers.managed.fxembed === "disabled") {
      return {
        searxng,
        fxembed: "https://fxembed.invalid",
        fxembedPlan: { mode: "disabled" },
      };
    }
    const accountId = answers.cloudflare?.accountId;
    const token = secrets.CLOUDFLARE_API_TOKEN;
    if (accountId === undefined || token === undefined) {
      throw new DeploymentError(
        "CLOUDFLARE_CREDENTIALS_REQUIRED",
        "Managed FxEmbed requires the Cloudflare account id and API token.",
      );
    }
    const client = cloudflareClientFactory(token);
    if (client.inspectWorker === undefined) {
      throw new DeploymentError(
        "CLOUDFLARE_INSPECTION_REQUIRED",
        "Managed FxEmbed requires a read-only Cloudflare inspection boundary.",
      );
    }
    const inspected = await client.inspectWorker(
      accountId,
      ARGUS_FXEMBED_WORKER_NAME,
    );
    return {
      searxng,
      fxembed: inspected.endpoint,
      fxembedPlan: {
        mode: "managed",
        ...(inspected.bundleHash === undefined
          ? {}
          : { currentBundleHash: inspected.bundleHash }),
        workersDevEnabled: inspected.workersDevEnabled,
      },
    };
  };

  const inspectExact = async (
    answers: OnboardingAnswersV1,
    secrets: Readonly<Record<string, string>>,
  ): Promise<
    ReleaseOnboardingInspection & {
      plan: ReleasePlan;
      fetched: Awaited<ReturnType<typeof fetchRelease>>;
    }
  > => {
    const fetched = await fetchRelease();
    const endpoints = await endpointsFor(answers, secrets);
    const rendered = renderInstanceConfig(answers, {
      searxng: endpoints.searxng,
      fxembed: endpoints.fxembed,
      apiToken: secrets.ARGUS_API_TOKEN ?? "inspection-placeholder",
      ...(secrets.POSTGRES_PASSWORD === undefined
        ? {}
        : { postgresPassword: secrets.POSTGRES_PASSWORD }),
      ...(secrets.OPENROUTER_API_KEY === undefined
        ? {}
        : { openrouterApiKey: secrets.OPENROUTER_API_KEY }),
    });
    const configHash = contentHash({
      yaml: rendered.yaml,
      secrets: contentHash(rendered.secretEnvironment),
      compose: renderCompose({
        version: fetched.release.version,
        storage: answers.deployment.storage,
        searxng: answers.managed.searxng === "managed",
      }),
      searxng:
        answers.managed.searxng === "managed"
          ? renderSearxngSettings()
          : null,
    });
    const desired: DesiredDeployment = {
      version: fetched.release.version,
      apiPort: answers.deployment.apiPort,
      storage: answers.deployment.storage,
      searxng: answers.managed.searxng === "managed",
      configHash,
      images: {
        argus: { reference: fetched.release.images.argus },
        postgres: { reference: fetched.release.images.postgres },
        searxng: { reference: fetched.release.images.searxng },
      },
    };
    const actual = await inspectDeployment({ root, executor, desired });
    const deployment = planDeployment(actual, desired);
    const planWithoutId = {
      contractVersion: 1 as const,
      desired,
      deployment,
      endpoints: {
        searxng: endpoints.searxng,
        fxembed: endpoints.fxembed,
      },
      fxembed: endpoints.fxembedPlan,
    };
    const plan: ReleasePlan = {
      ...planWithoutId,
      planId: contentHash({
        release: fetched.release,
        answers,
        plan: planWithoutId,
      }),
    };
    return {
      release: fetched.release,
      plan,
      fetched,
    };
  };

  const persistContext = async (
    fetched: Awaited<ReturnType<typeof fetchRelease>>,
  ): Promise<void> => {
    const context: PersistedReleaseContext = {
      schemaVersion: 1,
      manifest: Buffer.from(fetched.manifestBytes).toString("base64"),
      signature: Buffer.from(fetched.signature).toString("base64"),
      fxembed: Buffer.from(fetched.fxembedBytes).toString("base64"),
    };
    await atomicBytes(
      join(root, releaseContextFile),
      Buffer.from(JSON.stringify(context)),
      0o644,
    );
  };

  return {
    async inspect(input) {
      const inspected = await inspectExact(input.answers, input.secrets);
      return { release: inspected.release, plan: inspected.plan };
    },
    async apply(input) {
      const exact = await inspectExact(input.answers, input.secrets);
      if (
        JSON.stringify({
          release: exact.release,
          plan: exact.plan,
        }) !== JSON.stringify(input.inspection)
      ) {
        throw new DeploymentError(
          "ONBOARDING_PLAN_STALE",
          "The signed release onboarding plan is stale.",
        );
      }
      const apiToken = input.secrets.ARGUS_API_TOKEN;
      if (apiToken === undefined) {
        throw new DeploymentError(
          "API_TOKEN_REQUIRED",
          "Argus onboarding requires the API token.",
        );
      }
      await persistContext(exact.fetched);
      let fxembedReceipt:
        | { endpoint: string; bundleHash: string; changed: boolean }
        | undefined;
      if (input.answers.managed.fxembed === "managed") {
        const accountId = input.answers.cloudflare?.accountId;
        const token = input.secrets.CLOUDFLARE_API_TOKEN;
        if (accountId === undefined || token === undefined) {
          throw new DeploymentError(
            "CLOUDFLARE_CREDENTIALS_REQUIRED",
            "Managed FxEmbed requires the Cloudflare account id and API token.",
          );
        }
        fxembedReceipt = await reconcileFxEmbed({
          accountId,
          workerName: ARGUS_FXEMBED_WORKER_NAME,
          token,
          bundle: {
            script: exact.fetched.fxembedBytes,
            sha256: exact.fetched.manifest.assets.fxembed.sha256,
            compatibilityDate:
              exact.fetched.manifest.assets.fxembed.compatibilityDate,
          },
          client: cloudflareClientFactory(token),
        });
        if (fxembedReceipt.endpoint !== exact.plan.endpoints.fxembed) {
          throw new DeploymentError(
            "CLOUDFLARE_PLAN_STALE",
            "The managed FxEmbed endpoint changed after inspection.",
          );
        }
      }
      const rendered = renderInstanceConfig(input.answers, {
        searxng: exact.plan.endpoints.searxng,
        fxembed: exact.plan.endpoints.fxembed,
        apiToken,
        ...(input.secrets.POSTGRES_PASSWORD === undefined
          ? {}
          : { postgresPassword: input.secrets.POSTGRES_PASSWORD }),
        ...(input.secrets.OPENROUTER_API_KEY === undefined
          ? {}
          : { openrouterApiKey: input.secrets.OPENROUTER_API_KEY }),
      });
      await writeInstanceFiles({ root, rendered });
      await atomicBytes(
        join(root, "compose.yaml"),
        Buffer.from(
          renderCompose({
            version: exact.release.version,
            storage: input.answers.deployment.storage,
            searxng: input.answers.managed.searxng === "managed",
          }),
        ),
        0o644,
      );
      if (input.answers.managed.searxng === "managed") {
        await atomicBytes(
          join(root, "searxng", "settings.yml"),
          Buffer.from(renderSearxngSettings()),
          0o644,
        );
      }
      await applyDeployment(exact.plan.deployment, {
        root,
        executor,
        desired: exact.plan.desired,
      });
      if (fxembedReceipt !== undefined) {
        const state = await loadDeploymentState(root);
        if (state === undefined) {
          throw new DeploymentError(
            "DEPLOYMENT_STATE_REQUIRED",
            "Argus deployment state was not written.",
          );
        }
        await saveDeploymentState(root, {
          ...state,
          fxembed: {
            accountId: input.answers.cloudflare?.accountId as string,
            workerName: ARGUS_FXEMBED_WORKER_NAME,
            endpoint: fxembedReceipt.endpoint,
            bundleHash: fxembedReceipt.bundleHash,
          },
        });
      }
      return {
        receipt: {
          planId: exact.plan.planId,
          desired: exact.plan.desired,
          ...(fxembedReceipt === undefined ? {} : { fxembed: fxembedReceipt }),
        },
        release: exact.release,
        stateWritten: true,
      };
    },
    async verify(input) {
      let parsed: PersistedReleaseContext;
      try {
        parsed = JSON.parse(
          await readFile(join(root, releaseContextFile), "utf8"),
        ) as PersistedReleaseContext;
      } catch {
        throw new DeploymentError(
          "RELEASE_CONTEXT_INVALID",
          "Persisted signed release context is invalid.",
        );
      }
      if (
        parsed.schemaVersion !== 1 ||
        Object.keys(parsed).some(
          (key) =>
            !["schemaVersion", "manifest", "signature", "fxembed"].includes(key),
        )
      ) {
        throw new DeploymentError(
          "RELEASE_CONTEXT_INVALID",
          "Persisted signed release context is invalid.",
        );
      }
      const manifestBytes = exactBase64(
        parsed.manifest,
        "RELEASE_CONTEXT_INVALID",
      );
      const signature = exactBase64(
        parsed.signature,
        "RELEASE_CONTEXT_INVALID",
      );
      const fxembedBytes = exactBase64(
        parsed.fxembed,
        "RELEASE_CONTEXT_INVALID",
      );
      const verified = verifyReleaseManifestWithIdentity(
        manifestBytes,
        signature,
        publicKeyPem,
      );
      if (
        sha256(fxembedBytes) !== verified.manifest.assets.fxembed.sha256
      ) {
        throw new DeploymentError(
          "RELEASE_ASSET_HASH_MISMATCH",
          "Persisted FxEmbed bytes do not match the signed SHA-256.",
        );
      }
      const release = verifiedRelease(
        verified.manifest,
        verified.manifestSha256,
      );
      if (JSON.stringify(release) !== JSON.stringify(input.application.release)) {
        throw new DeploymentError(
          "RELEASE_CONTEXT_MISMATCH",
          "Persisted signed release context does not match the application.",
        );
      }
      const receipt = input.application.receipt as {
        desired?: DesiredDeployment;
      };
      if (receipt.desired === undefined) {
        throw new DeploymentError(
          "RELEASE_CONTEXT_MISMATCH",
          "Applied deployment identity is unavailable.",
        );
      }
      const trustedImages = {
        argus: release.images.argus,
        postgres: release.images.postgres,
        searxng: release.images.searxng,
      };
      if (
        receipt.desired.version !== release.version ||
        receipt.desired.apiPort !== input.answers.deployment.apiPort ||
        receipt.desired.storage !== input.answers.deployment.storage ||
        receipt.desired.searxng !==
          (input.answers.managed.searxng === "managed") ||
        JSON.stringify({
          argus: receipt.desired.images.argus.reference,
          postgres: receipt.desired.images.postgres.reference,
          searxng: receipt.desired.images.searxng.reference,
        }) !== JSON.stringify(trustedImages)
      ) {
        throw new DeploymentError(
          "RELEASE_CONTEXT_MISMATCH",
          "Applied deployment identity does not match the signed release context.",
        );
      }
      const status = await getDeploymentStatus({
        root,
        executor,
        desired: receipt.desired,
      });
      return { healthy: status.healthy, release, status };
    },
  };
};
