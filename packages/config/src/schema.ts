import { z } from "zod";

import { isCanonicalPostgresUrl, POSTGRES_URL_ERROR } from "./sanitize.js";

const cronSchema = z.string().refine(
  (value) => value.trim().split(/\s+/u).length === 5,
  "Schedule must be a five-field cron expression",
);

export const runtimeRoleSchema = z.enum([
  "all",
  "api",
  "scheduler",
  "worker",
  "processor",
]);

const sqliteStorageSchema = z
  .object({
    adapter: z.literal("sqlite"),
    url: z.string().min(1),
  })
  .strict();

const postgresStorageSchema = z
  .object({
    adapter: z.literal("postgres"),
    url: z.string().refine(isCanonicalPostgresUrl, POSTGRES_URL_ERROR),
  })
  .strict();

const sourcesSchema = z
  .object({
    x: z
      .object({
        enabled: z.boolean().default(false),
        endpoint: z.url().default("http://localhost:8787/api"),
      })
      .strict()
      .default({ enabled: false, endpoint: "http://localhost:8787/api" }),
    telegram: z
      .object({
        enabled: z.boolean().default(false),
        adapter: z.literal("public-web").default("public-web"),
      })
      .strict()
      .default({ enabled: false, adapter: "public-web" }),
    web: z
      .object({
        enabled: z.boolean().default(false),
        searchEndpoint: z.url().optional(),
        userAgent: z.string().min(1).default("Argus/0.1"),
        browserFallback: z.boolean().default(false),
      })
      .strict()
      .default({
        enabled: false,
        userAgent: "Argus/0.1",
        browserFallback: false,
      }),
  })
  .strict()
  .default({
    x: { enabled: false, endpoint: "http://localhost:8787/api" },
    telegram: { enabled: false, adapter: "public-web" },
    web: {
      enabled: false,
      userAgent: "Argus/0.1",
      browserFallback: false,
    },
  });

const watchSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u),
    enabled: z.boolean().default(true),
    schedule: cronSchema,
    inputs: z
      .object({
        x: z
          .object({
            accounts: z.array(z.string().min(1)).default([]),
            queries: z.array(z.string().min(1)).default([]),
          })
          .strict()
          .optional(),
        telegram: z
          .object({
            channels: z.array(z.string().regex(/^[A-Za-z0-9_]+$/u)).default([]),
          })
          .strict()
          .optional(),
        web: z
          .object({
            urls: z.array(z.url()).default([]),
            feeds: z.array(z.url()).default([]),
            queries: z.array(z.string().min(1)).default([]),
          })
          .strict()
          .optional(),
      })
      .strict(),
    classify: z
      .object({
        keywords: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ keywords: [] }),
    retentionDays: z.number().int().positive().optional(),
  })
  .strict();

const processorSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("summary"),
    schedule: cronSchema.optional(),
    watchIds: z.array(z.string()).optional(),
    prompt: z.string().optional(),
  })
  .strict();

const intelligenceSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.literal("openrouter").default("openrouter"),
    apiKey: z.string().optional(),
    model: z.string().min(1).default("openai/gpt-4.1-mini"),
    processors: z.array(processorSchema).default([]),
  })
  .strict()
  .default({
    enabled: false,
    provider: "openrouter",
    model: "openai/gpt-4.1-mini",
    processors: [],
  });

export const argusConfigSchema = z
  .object({
    version: z.literal(1),
    runtime: z
      .object({ role: runtimeRoleSchema.default("all") })
      .strict()
      .default({ role: "all" }),
    storage: z.discriminatedUnion("adapter", [
      sqliteStorageSchema,
      postgresStorageSchema,
    ]),
    sources: sourcesSchema,
    watches: z.array(watchSchema).default([]),
    intelligence: intelligenceSchema,
    api: z
      .object({
        host: z.string().default("0.0.0.0"),
        port: z.number().int().positive().max(65_535).default(8788),
        token: z.string().optional(),
      })
      .strict()
      .default({ host: "0.0.0.0", port: 8788 }),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.storage.adapter === "sqlite" && config.runtime.role !== "all") {
      context.addIssue({
        code: "custom",
        path: ["runtime", "role"],
        message: "SQLite requires runtime.role to be 'all'",
      });
    }
    if (config.intelligence.enabled && !config.intelligence.apiKey) {
      context.addIssue({
        code: "custom",
        path: ["intelligence", "apiKey"],
        message: "Intelligence requires an OpenRouter API key",
      });
    }
  });

export type ArgusConfig = z.infer<typeof argusConfigSchema>;

export const validateConfig = (value: unknown): ArgusConfig =>
  argusConfigSchema.parse(value);
