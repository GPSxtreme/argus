import { createHash } from "node:crypto";
import {
  applyConfigReconciliation,
  type ArgusConfig,
  type ConfigReconciliationPlan,
  planConfigReconciliation,
  validateConfig,
  verifyConfigReconciliation,
} from "@argus/config";
import type { StorageRepository } from "@argus/contracts";

export interface ManagementConfigPlan {
  contractVersion: 1;
  planId: string;
  path: string;
  baseContentHash?: string;
  desiredContentHash: string;
  operations: Array<{
    resource: "applied-config";
    action: "create" | "update";
    summary: string;
  }>;
}

const planIdentity = (
  path: string,
  plan: ConfigReconciliationPlan,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: 1,
        path,
        baseContentHash: plan.baseContentHash ?? null,
        desiredContentHash: plan.desiredContentHash,
      }),
    )
    .digest("hex");

const publicPlan = (
  path: string,
  plan: ConfigReconciliationPlan,
): ManagementConfigPlan => ({
  contractVersion: 1,
  planId: planIdentity(path, plan),
  path,
  ...(plan.baseContentHash === undefined
    ? {}
    : { baseContentHash: plan.baseContentHash }),
  desiredContentHash: plan.desiredContentHash,
  operations: plan.operations.map((operation) => ({
    resource: operation.resource,
    action: operation.action,
    summary: `${operation.action === "create" ? "Create" : "Update"} the installed service configuration.`,
  })),
});

const internalPlan = (
  inspection: ManagementConfigPlan,
): ConfigReconciliationPlan => ({
  contractVersion: 1,
  ...(inspection.baseContentHash === undefined
    ? {}
    : { baseContentHash: inspection.baseContentHash }),
  desiredContentHash: inspection.desiredContentHash,
  operations: inspection.operations.map((operation) => ({
    resource: operation.resource,
    action: operation.action,
    ...(inspection.baseContentHash === undefined
      ? {}
      : { fromContentHash: inspection.baseContentHash }),
    toContentHash: inspection.desiredContentHash,
  })),
});

export const managementConfigPlanIdentityValid = (
  inspection: ManagementConfigPlan,
): boolean =>
  inspection.planId === planIdentity(inspection.path, internalPlan(inspection));

export const inspectManagementConfig = async (
  repository: StorageRepository,
  path: string,
  value: unknown,
): Promise<{ config: ArgusConfig; plan: ManagementConfigPlan }> => {
  const config = validateConfig(value);
  const planned = await planConfigReconciliation(repository, config);
  return { config, plan: publicPlan(path, planned) };
};

export const applyManagementConfig = async (
  repository: StorageRepository,
  path: string,
  value: unknown,
  inspection: ManagementConfigPlan,
): Promise<{ planId: string; receipt: unknown }> => {
  const expected = await inspectManagementConfig(repository, path, value);
  if (JSON.stringify(expected.plan) !== JSON.stringify(inspection)) {
    throw new Error("Configuration reconciliation plan is stale.");
  }
  const receipt = await applyConfigReconciliation(
    repository,
    expected.config,
    internalPlan(inspection),
  );
  return { planId: inspection.planId, receipt };
};

export const verifyManagementConfig = async (
  repository: StorageRepository,
  inspection: ManagementConfigPlan,
): Promise<{ healthy: boolean; planId: string; status: unknown }> => {
  if (!managementConfigPlanIdentityValid(inspection)) {
    throw new Error("Configuration reconciliation plan identity is invalid.");
  }
  return {
    healthy: await verifyConfigReconciliation(
      repository,
      internalPlan(inspection),
    ),
    planId: inspection.planId,
    status: { desiredContentHash: inspection.desiredContentHash },
  };
};
