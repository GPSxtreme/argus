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

const persistenceSafe = (config: ArgusConfig): ArgusConfig => {
  const snapshot = structuredClone(config);
  delete snapshot.intelligence.apiKey;
  delete snapshot.api.token;
  return snapshot;
};

export const reconcileConfig = async (
  repository: StorageRepository,
  config: ArgusConfig,
): Promise<ReconcileResult> => {
  const snapshot = persistenceSafe(config);
  const hash = contentHash(snapshot);
  const current = await repository.getAppliedConfig();
  if (current?.contentHash === hash) {
    return { changed: false, contentHash: hash };
  }
  const applied: AppliedConfig = {
    config: snapshot,
    contentHash: hash,
    appliedAt: new Date().toISOString(),
  };
  await repository.applyConfig(applied);
  return { changed: true, contentHash: hash };
};
