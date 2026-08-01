import {
  contentHash,
  type AppliedConfig,
  type StorageRepository,
} from "@argus/contracts";
import type { ArgusConfig } from "./schema.js";

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
  return snapshot;
};

export const planConfigReconciliation = async (
  repository: StorageRepository,
  config: ArgusConfig,
): Promise<ConfigReconciliationPlan> => {
  const desiredContentHash = contentHash(persistenceSafe(config));
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
