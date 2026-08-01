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
});
