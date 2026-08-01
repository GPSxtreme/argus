import { describe, expect, it } from "vitest";
import type { OnboardingAnswersV1 } from "../src/contracts.js";
import { renderInstanceConfig } from "../src/index.js";

const answers: OnboardingAnswersV1 = {
  version: 1,
  deployment: {
    provider: "vps-docker",
    root: "/opt/argus",
    storage: "sqlite",
    apiHost: "0.0.0.0",
    apiPort: 8788,
  },
  managed: { searxng: "managed", fxembed: "managed" },
  cloudflare: { accountId: "test-account" },
  watches: [],
  intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
};

describe("renderInstanceConfig", () => {
  it("renders runtime config without secret values", () => {
    const rendered = renderInstanceConfig(answers, {
      searxng: "http://searxng:8080",
      fxembed: "https://argus-fx.workers.dev/api",
      apiToken: "api-secret",
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: Secret references intentionally use literal environment-placeholder syntax.
    expect(rendered.yaml).toContain("token: ${ARGUS_API_TOKEN}");
    expect(rendered.yaml).not.toContain("api-secret");
    expect(rendered.secrets).toContain("ARGUS_API_TOKEN=api-secret");
  });

  it("renders the configured storage, sources, and API endpoint deterministically", () => {
    const rendered = renderInstanceConfig(answers, {
      searxng: "http://searxng:8080",
      fxembed: "https://argus-fx.workers.dev/api",
      apiToken: "api-secret",
    });

    expect(rendered.yaml).toBe(`version: 1
runtime:
  role: all
storage:
  adapter: sqlite
  url: /app/data/argus.db
sources:
  x:
    enabled: true
    endpoint: https://argus-fx.workers.dev/api
  web:
    enabled: true
    searchEndpoint: http://searxng:8080
api:
  host: 0.0.0.0
  port: 8788
  token: \${ARGUS_API_TOKEN}
`);
  });

  it("faithfully renders Postgres, watches, processors, and required secrets", () => {
    const rendered = renderInstanceConfig(
      {
        ...answers,
        deployment: { ...answers.deployment, storage: "postgres" },
        watches: [
          {
            id: "research",
            enabled: true,
            schedule: "*/5 * * * *",
            x: { accounts: ["argus"], queries: ["release"] },
            telegram: { channels: ["argus_news"] },
            web: {
              urls: ["https://example.com/news"],
              feeds: ["https://example.com/feed.xml"],
              queries: ["signed releases"],
            },
            keywords: ["security"],
            retentionDays: 30,
          },
        ],
        intelligence: {
          enabled: true,
          model: "openai/gpt-4.1-mini",
          processors: [
            {
              id: "daily",
              schedule: "0 9 * * *",
              watchIds: ["research"],
            },
          ],
        },
      },
      {
        searxng: "http://searxng:8080",
        fxembed: "https://argus-fx.workers.dev/api",
        apiToken: "api-secret",
        postgresPassword: "p@ss:word",
        openrouterApiKey: "openrouter-secret",
      },
    );

    expect(rendered.yaml).toContain("adapter: postgres");
    expect(rendered.yaml).toContain(
      ["postgres://argus:$", "{ARGUS_POSTGRES_URL_PASSWORD}@postgres:5432/argus"].join(
        "",
      ),
    );
    expect(rendered.yaml).toContain("id: research");
    expect(rendered.yaml).toContain("accounts:");
    expect(rendered.yaml).toContain("- argus");
    expect(rendered.yaml).toContain("id: daily");
    expect(rendered.yaml).toContain("kind: summary");
    expect(rendered.yaml).toContain(
      ["apiKey: $", "{OPENROUTER_API_KEY}"].join(""),
    );
    expect(rendered.yaml).not.toContain("p@ss:word");
    expect(rendered.yaml).not.toContain("openrouter-secret");
    expect(rendered.secretEnvironment).toEqual({
      ARGUS_API_TOKEN: "api-secret",
      POSTGRES_PASSWORD: "p@ss:word",
      ARGUS_POSTGRES_URL_PASSWORD: "p%40ss%3Aword",
      OPENROUTER_API_KEY: "openrouter-secret",
    });
    expect(rendered.secrets).toContain("POSTGRES_PASSWORD=p@ss:word\n");
    expect(rendered.secrets).toContain(
      "ARGUS_POSTGRES_URL_PASSWORD=p%40ss%3Aword\n",
    );
    expect(rendered.secrets).toContain(
      "OPENROUTER_API_KEY=openrouter-secret\n",
    );
  });
});
