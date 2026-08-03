import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@argus/config";
import { afterEach, describe, expect, it } from "vitest";
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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

const composeAvailable = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
    expect(rendered.secretEnvironment.SEARXNG_SECRET).toMatch(/^[a-f0-9]{64}$/u);
    expect(rendered.secretEnvironment.SEARXNG_SECRET).not.toBe("api-secret");
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
api:
  host: 0.0.0.0
  port: 8788
  token: \${ARGUS_API_TOKEN}
`);
  });

  it("renders sources only for watch inputs and omits the disabled SearXNG endpoint", () => {
    const rendered = renderInstanceConfig(
      {
        ...answers,
        managed: { searxng: "disabled", fxembed: "disabled" },
        watches: [
          {
            id: "smoke-web",
            enabled: true,
            schedule: "*/5 * * * *",
            x: { accounts: [], queries: [] },
            telegram: { channels: [] },
            web: {
              urls: ["https://example.com/"],
              feeds: [],
              queries: [],
            },
            keywords: [],
          },
        ],
      },
      {
        searxng: "http://searxng.invalid",
        fxembed: "https://fxembed.invalid",
        apiToken: "api-secret",
      },
    );

    expect(rendered.yaml).toContain("id: smoke-web");
    expect(rendered.yaml).not.toContain("endpoint: https://fxembed.invalid");
    expect(rendered.yaml).not.toContain("searchEndpoint");
    expect(rendered.yaml).toContain("web:\n    enabled: true");
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
      ["url: $", "{ARGUS_POSTGRES_URL}"].join(""),
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
      SEARXNG_SECRET: expect.stringMatching(/^[a-f0-9]{64}$/u),
      POSTGRES_PASSWORD: "p@ss:word",
      ARGUS_POSTGRES_URL: "postgres://argus:p%40ss%3Aword@postgres:5432/argus",
      OPENROUTER_API_KEY: "openrouter-secret",
    });
    expect(rendered.secrets).toContain("POSTGRES_PASSWORD=p@ss:word\n");
    expect(rendered.secrets).toContain(
      "ARGUS_POSTGRES_URL=postgres://argus:p%40ss%3Aword@postgres:5432/argus\n",
    );
    expect(rendered.secrets).toContain(
      "OPENROUTER_API_KEY=openrouter-secret\n",
    );
  });

  it("loads a whole managed Postgres URL with reserved password characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-postgres-config-"));
    roots.push(root);
    const password = "p@ss:/?#[]% word";
    const rendered = renderInstanceConfig(
      {
        ...answers,
        deployment: { ...answers.deployment, storage: "postgres" },
      },
      {
        searxng: "http://searxng:8080",
        fxembed: "https://argus-fx.workers.dev/api",
        apiToken: "api-secret",
        postgresPassword: password,
      },
    );
    const path = join(root, "argus.yaml");
    await writeFile(path, rendered.yaml);

    const loaded = await loadConfig(path, rendered.secretEnvironment);
    expect(loaded.storage).toEqual({
      adapter: "postgres",
      url: `postgres://argus:${encodeURIComponent(password)}@postgres:5432/argus`,
    });
    const connection = new URL(loaded.storage.url);
    expect(connection.username).toBe("argus");
    expect(decodeURIComponent(connection.password)).toBe(password);
    expect(rendered.yaml).not.toContain(password);
    expect(rendered.secrets).toContain(`POSTGRES_PASSWORD=${password}\n`);
  });

  it("writes one-line values verbatim for Compose raw env-file format", () => {
    const values = [
      String.raw`C:\argus\data`,
      "trailing\\",
      "apostrophe's value",
      String.raw`one\'apostrophe`,
      String.raw`two\\'apostrophe`,
      String.raw`three\\\'apostrophe`,
      String.raw`four\\\\'apostrophe`,
      "$TOKEN",
      "#not-a-comment",
      "left=right",
      " leading and trailing ",
      "mix\\path'\"quoted\"$VALUE #tag=yes \\",
    ];
    for (const value of values) {
      const rendered = renderInstanceConfig(answers, {
        searxng: "http://searxng:8080",
        fxembed: "https://argus-fx.workers.dev/api",
        apiToken: value,
      });
      expect(rendered.secrets).toContain(`ARGUS_API_TOKEN=${value}\n`);
      expect(rendered.secrets).toMatch(/SEARXNG_SECRET=[a-f0-9]{64}\n/u);
      expect(rendered.secretEnvironment.ARGUS_API_TOKEN).toBe(value);
    }
  });

  it.runIf(composeAvailable)(
    "round-trips boundary secrets through the authoritative Docker Compose parser",
    async () => {
      const values = [
        "trailing\\",
        String.raw`one\'apostrophe`,
        String.raw`two\\'apostrophe`,
        String.raw`three\\\'apostrophe`,
        String.raw`many\\\\\\'apostrophe`,
        "mix\\path'\"quoted\"$VALUE #tag=yes \\",
      ];
      for (const value of values) {
        const root = await mkdtemp(join(tmpdir(), "argus-compose-env-"));
        roots.push(root);
        const rendered = renderInstanceConfig(answers, {
          searxng: "http://searxng:8080",
          fxembed: "https://argus-fx.workers.dev/api",
          apiToken: value,
        });
        await Promise.all([
          writeFile(join(root, "secrets.env"), rendered.secrets),
          writeFile(
            join(root, "compose.yaml"),
            "services:\n  probe:\n    image: scratch\n    env_file:\n      - path: secrets.env\n        format: raw\n",
          ),
        ]);
        const parsed = JSON.parse(
          execFileSync(
            "docker",
            [
              "compose",
              "-f",
              join(root, "compose.yaml"),
              "config",
              "--format",
              "json",
            ],
            { cwd: root, encoding: "utf8" },
          ),
        ) as { services: { probe: { environment: Record<string, string> } } };
        // Compose's canonical model escapes a literal dollar as `$$`; the
        // container environment receives the original single dollar.
        expect(parsed.services.probe.environment.ARGUS_API_TOKEN).toBe(
          value.replaceAll("$", () => "$$"),
        );
      }
    },
  );
});
