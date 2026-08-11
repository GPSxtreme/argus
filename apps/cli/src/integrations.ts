import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ArgusConfig } from "@argus/config";
import { contentHash, MANAGEMENT_WRAPPER_REQUIREMENTS } from "@argus/contracts";
import {
  ARGUS_FXEMBED_WORKER_NAME,
  applyDeployment,
  CloudflareWorkersApiClient,
  type CloudflareWorkersClient,
  type CommandExecutor,
  DeploymentError,
  type DesiredDeployment,
  getDeploymentStatus,
  inspectDeployment,
  loadDeploymentState,
  loadRollbackReleaseContext,
  type OnboardingAnswersV1,
  planDeployment,
  reconcileFxEmbed,
  renderCompose,
  renderInstanceConfig,
  renderSearxngSettings,
  saveDeploymentState,
  writeInstanceFiles,
} from "@argus/deployment";
import {
  MAX_RELEASE_MANIFEST_BYTES,
  managementStateForRelease,
  type ReleaseManifestV1,
  serializeReleaseManifestCanonical,
  type VerifiedReleaseManifest,
  verifyReleaseManifestWithIdentity,
  writeManagementStateAtomic,
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
const pendingReleaseContextFile = "release-context.pending.json";
export const stableUpdateManifestUrl = "https://argus.gpsxtre.me/releases/stable/manifest.json";

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

interface LoadedSignedContext {
  release: VerifiedReleaseManifest;
  bytes: Uint8Array;
}

declare const rollbackSnapshotBrand: unique symbol;
export interface VerifiedRollbackSnapshot {
  readonly release: VerifiedReleaseManifest;
  readonly signedContext: Uint8Array;
  readonly [rollbackSnapshotBrand]: true;
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
  fetchCurrentRelease(): Promise<VerifiedReleaseManifest>;
  fetchRollbackSnapshot(): Promise<VerifiedRollbackSnapshot>;
  validateRollbackSnapshot(snapshot: unknown): VerifiedRollbackSnapshot;
  getRollbackContext(release: VerifiedReleaseManifest): Promise<Uint8Array>;
  stageCurrentRelease(release: VerifiedReleaseManifest): Promise<void>;
  promoteCurrentRelease(release: VerifiedReleaseManifest): Promise<void>;
  promoteRollbackSnapshot(snapshot: VerifiedRollbackSnapshot): Promise<void>;
  promoteManagementRelease(release: VerifiedReleaseManifest): Promise<void>;
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
  const onboardingManifestUrl = environment.ARGUS_RELEASE_MANIFEST_URL;
  const updateManifestUrl = environment.ARGUS_UPDATE_MANIFEST_URL;
  const releaseInputs = [encodedPublicKey, onboardingManifestUrl, updateManifestUrl];
  if (
    releaseInputs.some((value) => value === undefined) &&
    releaseInputs.some((value) => value !== undefined)
  ) {
    throw new DeploymentError(
      "RELEASE_COMPOSITION_INVALID",
      "The onboarding manifest URL, update manifest URL, and embedded public key must be configured together.",
    );
  }
  if (updateManifestUrl !== undefined && updateManifestUrl !== stableUpdateManifestUrl) {
    throw new DeploymentError(
      "RELEASE_COMPOSITION_INVALID",
      "The Argus update manifest URL must use the stable release channel.",
    );
  }
  let onboardingIntegration: ProductionOnboardingIntegration | undefined;
  let updateIntegration: ProductionUpdateIntegration | undefined;
  if (
    encodedPublicKey !== undefined &&
    onboardingManifestUrl !== undefined &&
    updateManifestUrl !== undefined
  ) {
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
      manifestUrl: onboardingManifestUrl,
      publicKeyPem: decoded.toString("utf8"),
      ...(fetcher === undefined ? {} : { fetcher }),
    });
    updateIntegration = createProductionUpdateIntegration({
      root,
      manifestUrl: updateManifestUrl,
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

const releaseCredentialError = (): DeploymentError =>
  new DeploymentError(
    "RELEASE_CREDENTIAL_INVALID",
    "The protected Argus release credential is invalid.",
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readReleaseCredential = async (
  root: string,
): Promise<string | undefined> => {
  let document: unknown;
  try {
    document = JSON.parse(
      await readFile(join(root, ".docker", "config.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw releaseCredentialError();
  }
  if (!isRecord(document)) throw releaseCredentialError();
  if (document.auths === undefined) return undefined;
  if (!isRecord(document.auths)) throw releaseCredentialError();
  const registry = document.auths["ghcr.io"];
  if (registry === undefined) return undefined;
  if (!isRecord(registry) || typeof registry.auth !== "string") {
    throw releaseCredentialError();
  }
  const encoded = registry.auth;
  if (
    encoded.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw releaseCredentialError();
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw releaseCredentialError();
  let credential: string;
  try {
    credential = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw releaseCredentialError();
  }
  const separator = credential.indexOf(":");
  const username = credential.slice(0, separator);
  const token = credential.slice(separator + 1);
  if (
    separator <= 0 ||
    token.length === 0 ||
    !/^[!-~]+$/u.test(username) ||
    !/^[!-~]+$/u.test(token)
  ) {
    throw releaseCredentialError();
  }
  return token;
};

const isTrustedArgusGitHubReleaseUrl = (value: URL): boolean => {
  if (
    value.protocol !== "https:" ||
    value.port !== "" ||
    value.username !== "" ||
    value.password !== ""
  ) {
    return false;
  }
  if (/%(?:2f|5c)/iu.test(value.pathname)) return false;
  if (value.hostname === "github.com") {
    return /^\/GPSxtreme\/argus\/releases\/download\/[^/]+\/[^/]+$/u.test(
      value.pathname,
    );
  }
  if (value.hostname === "api.github.com") {
    return /^\/repos\/GPSxtreme\/argus\/releases\/assets\/[1-9][0-9]*$/u.test(
      value.pathname,
    );
  }
  return false;
};

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumReleaseRedirects = 5;

const createReleaseFetcher = (
  root: string,
  fetcher: typeof fetch,
): typeof fetch => {
  let credential: Promise<string | undefined> | undefined;
  const releaseCredential = (): Promise<string | undefined> => {
    credential ??= readReleaseCredential(root);
    return credential;
  };
  return async (input, init) => {
    let current = new URL(
      input instanceof Request ? input.url : String(input),
    );
    for (
      let redirects = 0;
      redirects <= maximumReleaseRedirects;
      redirects += 1
    ) {
      const token = isTrustedArgusGitHubReleaseUrl(current)
        ? await releaseCredential()
        : undefined;
      const headers = new Headers(init?.headers);
      if (token === undefined) headers.delete("authorization");
      else headers.set("authorization", `Bearer ${token}`);
      const response = await fetcher(current, {
        ...init,
        headers,
        redirect: "manual",
      });
      if (!redirectStatuses.has(response.status)) return response;
      if (redirects === maximumReleaseRedirects) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Release download exceeded its redirect limit.");
      }
      const location = response.headers.get("location");
      if (location === null) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Release download returned an invalid redirect.");
      }
      let redirected: URL;
      try {
        redirected = new URL(location, current);
      } catch {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Release download returned an invalid redirect.");
      }
      if (
        redirected.protocol !== "https:" ||
        redirected.username !== "" ||
        redirected.password !== ""
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Release download returned an unsafe redirect.");
      }
      void response.body?.cancel().catch(() => undefined);
      current = redirected;
    }
    throw new Error("Release download exceeded its redirect limit.");
  };
};

export interface ProductionUpdateIntegrationOptions {
  root: string;
  manifestUrl: string;
  publicKeyPem: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  writeManagementState?: (
    path: string,
    state: ReturnType<typeof managementStateForRelease>,
  ) => Promise<void>;
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
  writeManagementState = writeManagementStateAtomic,
}: ProductionUpdateIntegrationOptions): ProductionUpdateIntegration => {
  const releaseFetcher = createReleaseFetcher(root, fetcher);
  const fetchedReleases = new Map<string, FetchedUpdateRelease>();
  const rollbackSnapshots = new WeakMap<object, { contextSha256: string; releaseIdentity: string }>();
  const sameRelease = (
    left: VerifiedReleaseManifest,
    right: VerifiedReleaseManifest,
  ): boolean => {
    if (left.manifestSha256 !== right.manifestSha256) return false;
    try {
      return Buffer.from(serializeReleaseManifestCanonical(left.manifest)).equals(
        Buffer.from(serializeReleaseManifestCanonical(right.manifest)),
      );
    } catch {
      return false;
    }
  };
  const releaseIdentity = (release: VerifiedReleaseManifest): string =>
    `${release.manifestSha256}:${Buffer.from(
      serializeReleaseManifestCanonical(release.manifest),
    ).toString("base64")}`;
  const contextFor = (fetched: FetchedUpdateRelease): PersistedReleaseContext => ({
    schemaVersion: 1,
    manifest: Buffer.from(fetched.manifestBytes).toString("base64"),
    signature: Buffer.from(fetched.signature).toString("base64"),
    fxembed: Buffer.from(fetched.fxembedBytes).toString("base64"),
  });
  const fetchedFor = (release: VerifiedReleaseManifest): FetchedUpdateRelease => {
    const fetched = fetchedReleases.get(release.manifestSha256);
    if (fetched === undefined || !sameRelease(fetched.release, release)) {
      throw new DeploymentError(
        "UPDATE_RELEASE_UNVERIFIED",
        "Argus can only use the exact verified release that was downloaded for this update.",
      );
    }
    return fetched;
  };
  const fetchBounded = async (
    url: string,
    maximumBytes: number,
    code: string,
    message: string,
  ): Promise<Uint8Array> => {
    try {
      return await withHttpDeadline(timeoutMs, async (signal) =>
        boundedBytes(
          await releaseFetcher(url, { signal }),
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

  const verifySignedContext = (bytes: Uint8Array): LoadedSignedContext => {
    let parsed: PersistedReleaseContext;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as PersistedReleaseContext;
    } catch {
      throw new DeploymentError("UPDATE_ROLLBACK_UNAVAILABLE", "Persisted signed rollback release is invalid.");
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
    return { release, bytes };
  };

  const loadSignedContext = async (
    path: string,
  ): Promise<LoadedSignedContext> => {
    try {
      return verifySignedContext(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError("UPDATE_ROLLBACK_UNAVAILABLE", "Persisted signed rollback release is invalid.");
    }
  };

  const loadPersistedRollbackContext = async (): Promise<LoadedSignedContext> =>
    verifySignedContext(await loadRollbackReleaseContext(root));

  const issueRollbackSnapshot = (
    loaded: LoadedSignedContext,
  ): VerifiedRollbackSnapshot => {
    const signedContext = Uint8Array.from(loaded.bytes);
    const snapshot = Object.freeze({
      release: loaded.release,
      signedContext,
    }) as VerifiedRollbackSnapshot;
    rollbackSnapshots.set(snapshot, {
      contextSha256: sha256(signedContext),
      releaseIdentity: releaseIdentity(loaded.release),
    });
    return snapshot;
  };

  const invalidRollbackSnapshot = (): DeploymentError =>
    new DeploymentError(
      "UPDATE_ROLLBACK_UNAVAILABLE",
      "The verified rollback inspection snapshot is missing or invalid.",
    );

  const validateRollbackSnapshot = (
    candidate: unknown,
  ): VerifiedRollbackSnapshot => {
    if (typeof candidate !== "object" || candidate === null) {
      throw invalidRollbackSnapshot();
    }
    const record = rollbackSnapshots.get(candidate);
    if (record === undefined) throw invalidRollbackSnapshot();
    const snapshot = candidate as Partial<VerifiedRollbackSnapshot>;
    if (!(snapshot.signedContext instanceof Uint8Array)) {
      throw invalidRollbackSnapshot();
    }
    try {
      if (sha256(snapshot.signedContext) !== record.contextSha256) {
        throw invalidRollbackSnapshot();
      }
      const loaded = verifySignedContext(snapshot.signedContext);
      if (
        snapshot.release === undefined ||
        !sameRelease(loaded.release, snapshot.release) ||
        releaseIdentity(loaded.release) !== record.releaseIdentity
      ) {
        throw invalidRollbackSnapshot();
      }
      return issueRollbackSnapshot(loaded);
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw invalidRollbackSnapshot();
    }
  };

  const stageCurrentRelease = async (release: VerifiedReleaseManifest): Promise<void> => {
    await atomicBytes(
      join(root, pendingReleaseContextFile),
      Buffer.from(JSON.stringify(contextFor(fetchedFor(release)))),
      0o644,
    );
  };

  const promoteCurrentRelease = async (release: VerifiedReleaseManifest): Promise<void> => {
    fetchedFor(release);
    const stagedPath = join(root, pendingReleaseContextFile);
    let staged: VerifiedReleaseManifest;
    try {
      staged = (await loadSignedContext(stagedPath)).release;
    } catch {
      throw new DeploymentError(
        "UPDATE_RELEASE_UNVERIFIED",
        "Argus requires a staged exact verified release before it can promote update context.",
      );
    }
    if (!sameRelease(staged, release)) {
      throw new DeploymentError(
        "UPDATE_RELEASE_UNVERIFIED",
        "The staged Argus release does not match the verified update release.",
      );
    }
    await rename(stagedPath, join(root, releaseContextFile));
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };

  const getRollbackContext = async (
    release: VerifiedReleaseManifest,
  ): Promise<Uint8Array> => {
    let current: LoadedSignedContext;
    try {
      current = await loadSignedContext(join(root, releaseContextFile));
    } catch {
      throw new DeploymentError(
        "UPDATE_RELEASE_UNVERIFIED",
        "Argus requires the current exact verified release before it can stage rollback context.",
      );
    }
    if (!sameRelease(current.release, release)) {
      throw new DeploymentError(
        "UPDATE_RELEASE_UNVERIFIED",
        "The current signed Argus release does not match the verified rollback release.",
      );
    }
    return current.bytes;
  };

  const promoteRollbackSnapshot = async (
    snapshot: VerifiedRollbackSnapshot,
  ): Promise<void> => {
    const rollback = validateRollbackSnapshot(snapshot);
    await atomicBytes(join(root, releaseContextFile), rollback.signedContext, 0o644);
  };

  const promoteManagementRelease = async (
    release: VerifiedReleaseManifest,
  ): Promise<void> => {
    let verified = fetchedReleases.get(release.manifestSha256)?.release;
    if (verified === undefined || !sameRelease(verified, release)) {
      try {
        const current = await loadSignedContext(join(root, releaseContextFile));
        verified = sameRelease(current.release, release)
          ? current.release
          : (await loadPersistedRollbackContext()).release;
      } catch {
        throw new DeploymentError(
          "UPDATE_RELEASE_UNVERIFIED",
          "Argus can only promote management state from an exact verified release.",
        );
      }
      if (!sameRelease(verified, release)) {
        throw new DeploymentError(
          "UPDATE_RELEASE_UNVERIFIED",
          "Argus can only promote management state from an exact verified release.",
        );
      }
    }
    await writeManagementState(
      join(root, basename(MANAGEMENT_WRAPPER_REQUIREMENTS.stateFile)),
      managementStateForRelease(verified),
    );
  };

  const fetchCurrent = async (): Promise<VerifiedReleaseManifest> => {
    const stagedPath = join(root, pendingReleaseContextFile);
    try {
      const staged = await loadSignedContext(stagedPath);
      const state = await loadDeploymentState(root);
      const matchesDeployment = (release: VerifiedReleaseManifest): boolean =>
        state?.compose !== undefined &&
        release.manifest.version === state.argusVersion &&
        release.manifest.images.app.reference === state.compose.images.argus &&
        release.manifest.images.postgres.reference === state.compose.images.postgres &&
        release.manifest.images.searxng.reference === state.compose.images.searxng;
      if (matchesDeployment(staged.release)) {
        const current = await loadSignedContext(join(root, releaseContextFile));
        if (matchesDeployment(current.release)) {
          await unlink(stagedPath);
          return current.release;
        }
        if (!sameRelease((await loadPersistedRollbackContext()).release, current.release)) {
          throw new DeploymentError(
            "UPDATE_ROLLBACK_UNAVAILABLE",
            "The authoritative rollback release does not match the prior signed release context.",
          );
        }
        await rename(stagedPath, join(root, releaseContextFile));
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return staged.release;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      return (await loadSignedContext(join(root, releaseContextFile))).release;
    } catch {
      throw new DeploymentError("UPDATE_ROLLBACK_UNAVAILABLE", "No persisted signed release is available for rollback.");
    }
  };

  const fetchRollbackSnapshot = async (): Promise<VerifiedRollbackSnapshot> => {
    try {
      return issueRollbackSnapshot(await loadPersistedRollbackContext());
    } catch {
      throw new DeploymentError("UPDATE_ROLLBACK_UNAVAILABLE", "No persisted signed rollback release is available.");
    }
  };

  return {
    fetchUpdateRelease: fetchVerified,
    fetchCurrentRelease: fetchCurrent,
    fetchRollbackSnapshot,
    validateRollbackSnapshot,
    getRollbackContext,
    stageCurrentRelease,
    promoteCurrentRelease,
    promoteRollbackSnapshot,
    promoteManagementRelease,
  };
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
  const releaseFetcher = createReleaseFetcher(root, fetcher);
  const fetchBounded = async (
    url: string,
    maximumBytes: number,
    code: string,
    message: string,
  ): Promise<Uint8Array> => {
    try {
      return await withHttpDeadline(timeoutMs, async (signal) =>
        boundedBytes(
          await releaseFetcher(url, { signal }),
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
