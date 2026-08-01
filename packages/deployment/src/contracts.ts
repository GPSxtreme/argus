import type { ArgusConfig } from "@argus/config";
import { z } from "zod";

const pinnedImageReferencePattern = /^(?=.{1,255}$)(?:(?:localhost(?::[0-9]{1,5})?|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:[0-9]{1,5})\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:[a-f0-9]{64}$/;

/** Accepts credential-free OCI references pinned to a SHA-256 manifest digest. */
export const isPinnedImageReference = (value: string): boolean => {
  if (!pinnedImageReferencePattern.test(value)) return false;
  const registry = value.slice(0, value.indexOf("/"));
  const separator = registry.lastIndexOf(":");
  if (separator === -1) return true;
  const port = registry.slice(separator + 1);
  return /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65_535;
};

export const pinnedImageReferenceSchema = z
  .string()
  .refine(isPinnedImageReference, "Expected a credential-free digest-pinned OCI image reference");

export interface OnboardingAnswersV1 {
  version: 1;
  deployment: {
    provider: "vps-docker";
    root: string;
    storage: "sqlite" | "postgres";
    apiHost: string;
    apiPort: number;
  };
  managed: {
    searxng: "disabled" | "managed" | "external";
    fxembed: "disabled" | "managed" | "external";
  };
  cloudflare?: { accountId?: string };
  external?: { searxngEndpoint?: string; fxembedEndpoint?: string };
  watches: Array<{
    id: string;
    enabled: boolean;
    schedule: string;
    x: { accounts: string[]; queries: string[] };
    telegram: { channels: string[] };
    web: { urls: string[]; feeds: string[]; queries: string[] };
    keywords: string[];
    retentionDays?: number;
  }>;
  intelligence: {
    enabled: boolean;
    model: string;
    processors?: Array<{ id: string; schedule?: string; watchIds?: string[] }>;
  };
}

export interface DeploymentStateV1 {
  schemaVersion: 1;
  argusVersion: string;
  composeProject: string;
  configHash: string;
  services: Record<string, { image: string; healthy: boolean }>;
  compose?: {
    version: string;
    apiPort: number;
    storage: "sqlite" | "postgres";
    searxng: boolean;
    images: { argus: string; postgres: string; searxng: string };
  };
  fxembed?: {
    accountId: string;
    workerName: string;
    endpoint: string;
    bundleHash: string;
  };
  updatedAt: string;
}

export interface DeploymentPlan {
  contractVersion: 1;
  changes: Array<{
    component: "files" | "argus" | "postgres" | "searxng" | "fxembed";
    action: "create" | "update" | "restart" | "remove";
    summary: string;
    external: boolean;
  }>;
}

export interface DiagnosticReport {
  contractVersion: 1;
  healthy: boolean;
  checks: Array<{
    component: string;
    status: "healthy" | "unhealthy" | "skipped";
    code: string;
    message: string;
    recovery?: string;
    logsCommand?: string;
  }>;
}

export interface DeploymentErrorJSON {
  code: string;
  message: string;
  recovery?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type DeploymentArgusConfig = ArgusConfig;

const endpointSchema = z.url();

const watchSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean(),
    schedule: z.string().min(1),
    x: z
      .object({
        accounts: z.array(z.string()),
        queries: z.array(z.string()),
      })
      .strict(),
    telegram: z.object({ channels: z.array(z.string()) }).strict(),
    web: z
      .object({
        urls: z.array(endpointSchema),
        feeds: z.array(endpointSchema),
        queries: z.array(z.string()),
      })
      .strict(),
    keywords: z.array(z.string()),
    retentionDays: z.number().int().positive().optional(),
  })
  .strict();

export const onboardingAnswersSchema = z
  .object({
    version: z.literal(1),
    deployment: z
      .object({
        provider: z.literal("vps-docker"),
        root: z.literal("/opt/argus"),
        storage: z.enum(["sqlite", "postgres"]),
        apiHost: z.string().min(1),
        apiPort: z.number().int().positive().max(65_535),
      })
      .strict(),
    managed: z
      .object({
        searxng: z.enum(["disabled", "managed", "external"]),
        fxembed: z.enum(["disabled", "managed", "external"]),
      })
      .strict(),
    cloudflare: z.object({ accountId: z.string().min(1).optional() }).strict().optional(),
    external: z
      .object({
        searxngEndpoint: endpointSchema.optional(),
        fxembedEndpoint: endpointSchema.optional(),
      })
      .strict()
      .optional(),
    watches: z.array(watchSchema),
    intelligence: z
      .object({
        enabled: z.boolean(),
        model: z.string().min(1),
        processors: z
          .array(
            z
              .object({
                id: z.string().min(1),
                schedule: z.string().min(1).optional(),
                watchIds: z.array(z.string()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((answers, context) => {
    if (answers.managed.fxembed === "managed" && !answers.cloudflare?.accountId) {
      context.addIssue({
        code: "custom",
        path: ["cloudflare", "accountId"],
        message: "Managed fxembed requires a Cloudflare account id",
      });
    }
    if (answers.managed.searxng === "external" && !answers.external?.searxngEndpoint) {
      context.addIssue({
        code: "custom",
        path: ["external", "searxngEndpoint"],
        message: "External SearXNG requires an endpoint",
      });
    }
    if (answers.managed.fxembed === "external" && !answers.external?.fxembedEndpoint) {
      context.addIssue({
        code: "custom",
        path: ["external", "fxembedEndpoint"],
        message: "External FxEmbed requires an endpoint",
      });
    }
  });

export const deploymentStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    argusVersion: z.string().min(1),
    composeProject: z.string().min(1),
    configHash: z.string().min(1),
    services: z.record(
      z.string(),
      z.object({ image: pinnedImageReferenceSchema, healthy: z.boolean() }).strict(),
    ),
    compose: z
      .object({
        version: z.string().min(1),
        apiPort: z.number().int().positive().max(65_535),
        storage: z.enum(["sqlite", "postgres"]),
        searxng: z.boolean(),
        images: z
          .object({
            argus: pinnedImageReferenceSchema,
            postgres: pinnedImageReferenceSchema,
            searxng: pinnedImageReferenceSchema,
          })
          .strict(),
      })
      .strict()
      .optional(),
    fxembed: z
      .object({
        accountId: z.string().min(1),
        workerName: z.string().min(1),
        endpoint: endpointSchema,
        bundleHash: z.string().min(1),
      })
      .strict()
      .optional(),
    updatedAt: z.string().min(1),
  })
  .strict();

export const deploymentPlanSchema = z
  .object({
    contractVersion: z.literal(1),
    changes: z.array(
      z
        .object({
          component: z.enum(["files", "argus", "postgres", "searxng", "fxembed"]),
          action: z.enum(["create", "update", "restart", "remove"]),
          summary: z.string().min(1),
          external: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const diagnosticReportSchema = z
  .object({
    contractVersion: z.literal(1),
    healthy: z.boolean(),
    checks: z.array(
      z
        .object({
          component: z.string().min(1),
          status: z.enum(["healthy", "unhealthy", "skipped"]),
          code: z.string().min(1),
          message: z.string().min(1),
          recovery: z.string().min(1).optional(),
          logsCommand: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const commandResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean().optional(),
  })
  .strict();
