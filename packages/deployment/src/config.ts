import type { OnboardingAnswersV1 } from "./contracts.js";
import { stringify } from "yaml";

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
  secretEnvironment: Record<string, string>;
}

const environmentReference = (name: string): string => `\${${name}}`;

export const renderInstanceConfig = (
  answers: OnboardingAnswersV1,
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
  const storageUrl =
    answers.deployment.storage === "sqlite"
      ? "/app/data/argus.db"
      : `postgres://argus:${environmentReference("ARGUS_POSTGRES_URL_PASSWORD")}@postgres:5432/argus`;
  const telegramEnabled = answers.watches.some(
    (watch) => watch.telegram.channels.length > 0,
  );
  const yaml = stringify({
    version: 1,
    runtime: { role: "all" },
    storage: {
      adapter: answers.deployment.storage,
      url: storageUrl,
    },
    sources: {
      x: { enabled: true, endpoint: endpoints.fxembed },
      ...(telegramEnabled
        ? { telegram: { enabled: true, adapter: "public-web" } }
        : {}),
      web: { enabled: true, searchEndpoint: endpoints.searxng },
    },
    ...(answers.watches.length === 0
      ? {}
      : {
          watches: answers.watches.map((watch) => ({
            id: watch.id,
            enabled: watch.enabled,
            schedule: watch.schedule,
            inputs: {
              ...(watch.x.accounts.length === 0 &&
              watch.x.queries.length === 0
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
            ...(watch.retentionDays === undefined
              ? {}
              : { retentionDays: watch.retentionDays }),
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
    ARGUS_API_TOKEN: requiredSecret("ARGUS_API_TOKEN", endpoints.apiToken),
    ...(postgresPassword === undefined
      ? {}
      : {
          POSTGRES_PASSWORD: postgresPassword,
          ARGUS_POSTGRES_URL_PASSWORD: encodeURIComponent(postgresPassword),
        }),
    ...(openrouterApiKey === undefined
      ? {}
      : { OPENROUTER_API_KEY: openrouterApiKey }),
  };

  return {
    yaml,
    secrets: `${Object.entries(secretEnvironment)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
    secretEnvironment,
  };
};
