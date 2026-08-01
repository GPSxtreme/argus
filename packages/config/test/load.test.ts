import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  resolveConfigPath,
  resolveSecretReference,
  serializeRedactedConfig,
} from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("loadConfig", () => {
  it("resolves the short default configuration filename from the working directory", () => {
    expect(
      resolveConfigPath({
        cwd: "/srv/argus",
        environment: {},
      }),
    ).toBe("/srv/argus/argus.yaml");
  });

  it("parses watches across the source trinity", async () => {
    const config = await loadConfig(fixture("valid.yaml"), {
      OPENROUTER_API_KEY: "secret",
    });
    expect(config.version).toBe(1);
    expect(config.watches[0]?.inputs.telegram?.channels).toEqual([
      "solana_announcements",
    ]);
    expect(config.intelligence.apiKey).toBe("secret");
  });

  it("rejects split roles with SQLite", async () => {
    await expect(loadConfig(fixture("invalid-sqlite-role.yaml"), {})).rejects.toThrow(
      "SQLite requires runtime.role to be 'all'",
    );
  });

  it("resolves secrets without preserving them in serialized config", async () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Secret references intentionally use literal environment-placeholder syntax.
      resolveSecretReference("${OPENROUTER_API_KEY}", {
        OPENROUTER_API_KEY: "x",
      }),
    ).toBe("x");
    const config = await loadConfig(fixture("valid.yaml"), {
      OPENROUTER_API_KEY: "secret",
    });
    expect(serializeRedactedConfig(config)).not.toContain("secret");
  });

  it("redacts PostgreSQL URL credentials without changing the live config", () => {
    const password = "Argus-Serialize@:/?#[]% secret";
    const encodedPassword = encodeURIComponent(password);
    const liveUrl = `postgres://argus-admin:${encodedPassword}@postgres:5432/argus`;
    const config = {
      version: 1 as const,
      runtime: { role: "api" as const },
      storage: { adapter: "postgres" as const, url: liveUrl },
      sources: {
        x: {
          enabled: false,
          endpoint: "http://localhost:8787/api",
        },
        telegram: { enabled: false, adapter: "public-web" as const },
        web: {
          enabled: false,
          userAgent: "Argus/0.1",
          browserFallback: false,
        },
      },
      watches: [],
      intelligence: {
        enabled: false,
        provider: "openrouter" as const,
        model: "openai/gpt-4.1-mini",
        processors: [],
      },
      api: { host: "0.0.0.0", port: 8788 },
    };

    const serialized = serializeRedactedConfig(config);
    for (const secret of [
      password,
      encodedPassword,
      decodeURIComponent(encodedPassword),
      liveUrl,
      "argus-admin",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("postgres://postgres:5432/argus");
    expect(config.storage.url).toBe(liveUrl);
  });

  it("removes PostgreSQL query credentials while preserving safe parameters", () => {
    const firstPassword = "Argus-First@:/?#[]% secret";
    const effectivePassword = "Argus-Effective@:/?#[]% secret";
    const ignoredUppercasePassword = "Argus-Uppercase@:/?#[]% secret";
    const liveUrl =
      `postgres://authority-user:${encodeURIComponent("authority-password")}@postgres:5432/argus` +
      `?sslmode=verify-full&password=${encodeURIComponent(firstPassword)}` +
      `&PASSWORD=${encodeURIComponent(ignoredUppercasePassword)}` +
      `&user=query-user&password=${encodeURIComponent(effectivePassword)}` +
      "&application_name=argus";
    const config = {
      version: 1 as const,
      runtime: { role: "api" as const },
      storage: { adapter: "postgres" as const, url: liveUrl },
      sources: {
        x: { enabled: false, endpoint: "http://localhost:8787/api" },
        telegram: { enabled: false, adapter: "public-web" as const },
        web: {
          enabled: false,
          userAgent: "Argus/0.1",
          browserFallback: false,
        },
      },
      watches: [],
      intelligence: {
        enabled: false,
        provider: "openrouter" as const,
        model: "openai/gpt-4.1-mini",
        processors: [],
      },
      api: { host: "0.0.0.0", port: 8788 },
    };

    const serialized = serializeRedactedConfig(config);
    expect(serialized).toContain(
      "postgres://postgres:5432/argus?sslmode=verify-full&application_name=argus",
    );
    for (const secret of [
      "authority-user",
      "authority-password",
      encodeURIComponent("authority-password"),
      "query-user",
      firstPassword,
      encodeURIComponent(firstPassword),
      effectivePassword,
      encodeURIComponent(effectivePassword),
      ignoredUppercasePassword,
      encodeURIComponent(ignoredUppercasePassword),
      liveUrl,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(config.storage.url).toBe(liveUrl);
  });
});
