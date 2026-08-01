import type { OnboardingAnswersV1 } from "./contracts.js";

export interface InstanceEndpoints {
  searxng: string;
  fxembed: string;
  apiToken: string;
}

export interface RenderedInstanceConfig {
  yaml: string;
  secrets: string;
  secretEnvironment: Record<string, string>;
}

export const renderInstanceConfig = (
  answers: OnboardingAnswersV1,
  endpoints: InstanceEndpoints,
): RenderedInstanceConfig => {
  const storageUrl =
    answers.deployment.storage === "sqlite"
      ? "/app/data/argus.db"
      : "postgres://postgres:5432/argus";
  const yaml = `version: 1
runtime:
  role: all
storage:
  adapter: ${answers.deployment.storage}
  url: ${storageUrl}
sources:
  x:
    enabled: true
    endpoint: ${endpoints.fxembed}
  web:
    enabled: true
    searchEndpoint: ${endpoints.searxng}
api:
  host: ${answers.deployment.apiHost}
  port: ${answers.deployment.apiPort}
  token: \${ARGUS_API_TOKEN}
`;
  const secretEnvironment = { ARGUS_API_TOKEN: endpoints.apiToken };

  return {
    yaml,
    secrets: `ARGUS_API_TOKEN=${endpoints.apiToken}\n`,
    secretEnvironment,
  };
};
