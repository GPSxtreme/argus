import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { OnboardingAnswers } from "./contracts.js";

export interface InstanceEndpoints {
  searxng: string;
  fxembed: string;
  apiToken: string;
  postgresPassword?: string;
  openrouterApiKey?: string;
}

export interface RenderedInstanceConfig {
  yaml: string;
  secrets: string;
  searxngSecrets?: string;
  secretEnvironment: Record<string, string>;
}

const environmentReference = (name: string): string => `\${${name}}`;

export const renderInstanceConfig = (
  answers: OnboardingAnswers,
  endpoints: InstanceEndpoints,
): RenderedInstanceConfig => {
  const requiredSecret = (name: string, value: string | undefined): string => {
    if (value === undefined || value.length === 0 || /[\r\n]/u.test(value)) {
      throw new TypeError(`${name} is required and must be one line.`);
    }
    return value;
  };
  const postgresPassword =
    answers.deployment.storage === "postgres"
      ? requiredSecret("POSTGRES_PASSWORD", endpoints.postgresPassword)
      : undefined;
  const openrouterApiKey = answers.intelligence.enabled
    ? requiredSecret("OPENROUTER_API_KEY", endpoints.openrouterApiKey)
    : undefined;
  const apiToken = requiredSecret("ARGUS_API_TOKEN", endpoints.apiToken);
  const searxngSecret =
    answers.managed.searxng === "managed"
      ? createHash("sha256")
          .update("argus-managed-searxng\0")
          .update(apiToken)
          .digest("hex")
      : undefined;
  const storageUrl =
    answers.deployment.storage === "sqlite"
      ? "/app/data/argus.db"
      : environmentReference("ARGUS_POSTGRES_URL");
  const telegramEnabled = answers.watches.some(
    (watch) => watch.telegram.channels.length > 0,
  );
  const xEnabled =
    answers.managed.fxembed !== "disabled" &&
    answers.watches.some(
      (watch) => watch.x.accounts.length > 0 || watch.x.queries.length > 0,
    );
  const webEnabled = answers.watches.some(
    (watch) =>
      watch.web.urls.length > 0 ||
      watch.web.feeds.length > 0 ||
      watch.web.queries.length > 0,
  );
  const searxngEnabled = answers.managed.searxng !== "disabled";
  const sources = {
    ...(xEnabled
      ? {
          x: {
            enabled: true,
            endpoint: endpoints.fxembed,
            replies: answers.xReplies,
          },
        }
      : {}),
    ...(telegramEnabled
      ? { telegram: { enabled: true, adapter: "public-web" } }
      : {}),
    ...(webEnabled
      ? {
          web: {
            enabled: true,
            ...(searxngEnabled ? {
              searchEndpoint: endpoints.searxng,
              searchEndpointTrust: answers.managed.searxng === "managed" ? "trusted" : "public",
            } : {}),
          },
        }
      : {}),
  };
  const yaml = stringify({
    version: 2,
    runtime: { role: "all" },
    storage: {
      adapter: answers.deployment.storage,
      url: storageUrl,
    },
    ...(Object.keys(sources).length === 0 ? {} : { sources }),
    ...(answers.watches.length === 0
      ? {}
      : {
          watches: answers.watches.map((watch) => ({
            id: watch.id,
            enabled: watch.enabled,
            schedule: watch.schedule,
            inputs: {
              ...(!xEnabled ||
              (watch.x.accounts.length === 0 &&
                watch.x.queries.length === 0)
                ? {}
                : { x: watch.x }),
              ...(watch.telegram.channels.length === 0
                ? {}
                : { telegram: watch.telegram }),
              ...(watch.web.urls.length === 0 &&
              watch.web.feeds.length === 0 &&
              watch.web.queries.length === 0
                ? {}
                : { web: watch.web }),
            },
            classify: { keywords: watch.keywords },
          })),
        }),
    ...(answers.intelligence.enabled
      ? {
          intelligence: {
            enabled: true,
            provider: "openrouter",
            apiKey: environmentReference("OPENROUTER_API_KEY"),
            model: answers.intelligence.model,
            processors: (answers.intelligence.processors ?? []).map(
              (processor) => ({
                id: processor.id,
                kind: "summary",
                ...(processor.schedule === undefined
                  ? {}
                  : { schedule: processor.schedule }),
                ...(processor.watchIds === undefined
                  ? {}
                  : { watchIds: processor.watchIds }),
              }),
            ),
          },
        }
      : {}),
    api: {
      host: answers.deployment.apiHost,
      port: answers.deployment.apiPort,
      token: environmentReference("ARGUS_API_TOKEN"),
    },
  });
  const secretEnvironment: Record<string, string> = {
    ARGUS_API_TOKEN: apiToken,
    ...(searxngSecret === undefined
      ? {}
      : { SEARXNG_SECRET: searxngSecret }),
    ...(postgresPassword === undefined
      ? {}
      : {
          POSTGRES_PASSWORD: postgresPassword,
          ARGUS_POSTGRES_URL: `postgres://argus:${encodeURIComponent(postgresPassword)}@postgres:5432/argus`,
        }),
    ...(openrouterApiKey === undefined
      ? {}
      : { OPENROUTER_API_KEY: openrouterApiKey }),
  };

  return {
    yaml,
    secrets: `${Object.entries(secretEnvironment)
      .filter(([name]) => name !== "SEARXNG_SECRET")
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
    ...(searxngSecret === undefined
      ? {}
      : { searxngSecrets: `SEARXNG_SECRET=${searxngSecret}\n` }),
    secretEnvironment,
  };
};
