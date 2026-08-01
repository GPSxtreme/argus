import { createHmac } from "node:crypto";
import {
  contentHash,
  type AppliedConfig,
  type StorageRepository,
} from "@argus/contracts";
import type { ArgusConfig } from "./schema.js";
import {
  urlCredentialFingerprint,
  withoutUrlCredentials,
} from "./sanitize.js";

export interface ReconcileResult {
  changed: boolean;
  contentHash: string;
}

export interface ConfigReconciliationPlan {
  contractVersion: 1;
  baseContentHash?: string;
  desiredContentHash: string;
  operations: Array<{
    resource: "applied-config";
    action: "create" | "update";
    fromContentHash?: string;
    toContentHash: string;
  }>;
}

const persistenceSafe = (config: ArgusConfig): ArgusConfig => {
  const snapshot = structuredClone(config);
  delete snapshot.intelligence.apiKey;
  delete snapshot.api.token;
  if (snapshot.storage.adapter === "postgres") {
    snapshot.storage.url = withoutUrlCredentials(snapshot.storage.url);
  }
  snapshot.sources.x.endpoint = withoutUrlCredentials(
    snapshot.sources.x.endpoint,
  );
  if (snapshot.sources.web.searchEndpoint) {
    snapshot.sources.web.searchEndpoint = withoutUrlCredentials(
      snapshot.sources.web.searchEndpoint,
    );
  }
  return snapshot;
};

const reconciliationContentHash = (config: ArgusConfig): string => {
  const fingerprint = (credential: string): string => {
    if (!config.api.token) {
      throw new Error(
        "Credential-bearing configuration URLs require api.token for secure reconciliation.",
      );
    }
    return createHmac("sha256", config.api.token)
      .update("argus-config-url-credential-v1\u0000")
      .update(credential)
      .digest("hex");
  };
  const fingerprints = {
    ...(config.storage.adapter === "postgres"
      ? {
          storage: urlCredentialFingerprint(config.storage.url, fingerprint),
        }
      : {}),
    x: urlCredentialFingerprint(config.sources.x.endpoint, fingerprint),
    ...(config.sources.web.searchEndpoint
      ? {
          webSearch: urlCredentialFingerprint(
            config.sources.web.searchEndpoint,
            fingerprint,
          ),
        }
      : {}),
  };
  const present = Object.fromEntries(
    Object.entries(fingerprints).filter((entry) => entry[1] !== undefined),
  );
  const safe = persistenceSafe(config);
  return Object.keys(present).length === 0
    ? contentHash(safe)
    : contentHash({ config: safe, credentialFingerprints: present });
};

export const planConfigReconciliation = async (
  repository: StorageRepository,
  config: ArgusConfig,
): Promise<ConfigReconciliationPlan> => {
  const desiredContentHash = reconciliationContentHash(config);
  const current = await repository.getAppliedConfig();
  if (current?.contentHash === desiredContentHash) {
    return {
      contractVersion: 1,
      baseContentHash: current.contentHash,
      desiredContentHash,
      operations: [],
    };
  }
  return {
    contractVersion: 1,
    ...(current === undefined
      ? {}
      : { baseContentHash: current.contentHash }),
    desiredContentHash,
    operations: [
      {
        resource: "applied-config",
        action: current === undefined ? "create" : "update",
        ...(current === undefined
          ? {}
          : { fromContentHash: current.contentHash }),
        toContentHash: desiredContentHash,
      },
    ],
  };
};

export const applyConfigReconciliation = async (
  repository: StorageRepository,
  config: ArgusConfig,
  plan: ConfigReconciliationPlan,
): Promise<ReconcileResult> => {
  const expected = await planConfigReconciliation(repository, config);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) {
    throw new Error("Configuration reconciliation plan is stale.");
  }
  if (plan.operations.length === 0) {
    return { changed: false, contentHash: plan.desiredContentHash };
  }
  const snapshot = persistenceSafe(config);
  const applied: AppliedConfig = {
    config: snapshot,
    contentHash: plan.desiredContentHash,
    appliedAt: new Date().toISOString(),
  };
  await repository.applyConfig(applied);
  return { changed: true, contentHash: plan.desiredContentHash };
};

export const verifyConfigReconciliation = async (
  repository: StorageRepository,
  plan: ConfigReconciliationPlan,
): Promise<boolean> =>
  (await repository.getAppliedConfig())?.contentHash ===
  plan.desiredContentHash;

export const reconcileConfig = async (
  repository: StorageRepository,
  config: ArgusConfig,
): Promise<ReconcileResult> => {
  const plan = await planConfigReconciliation(repository, config);
  return applyConfigReconciliation(repository, config, plan);
};
