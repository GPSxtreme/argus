import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  resolveConfigPath,
  resolveSecretReference,
  serializeRedactedConfig,
  validateConfig,
  withoutUrlCredentials,
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

  it("rejects fallback-only or malformed PostgreSQL URLs without echoing them", () => {
    const invalid = [
      "postgres://user:EmptyHost-Secret@/argus",
      "postgres://user:Malformed%ZZ-Secret@localhost/argus",
      "localhost/argus?password=MissingScheme-Secret",
      "postgres:Opaque-Secret",
      "postgres:///argus?password=MissingHost-Secret",
      "https://user:WrongScheme-Secret@localhost/argus",
      "postgres://user:Fragment-Secret@localhost/argus#ignored",
      "postgres://localhost/argus?host=%2Fvar%2Frun%2Fpostgresql&password=Socket-Secret",
      "postgres://localhost/argus?port=not-a-port&password=Port-Secret",
      "postgres://user:AuthoritySlash-Secret@%2Fvar%2Frun/argus",
      "postgres://user:AuthorityBackslash-Secret@%5Cserver/argus",
      "postgres://user:AuthorityDouble-Secret@%252Fvar/argus",
      "postgres://user:AuthorityNul-Secret@%00evil/argus",
      "postgres://user:AuthoritySpace-Secret@%20evil/argus",
      "postgres://user:AuthorityPath-Secret@%2E%2E/argus",
      "postgres://localhost/argus?host=%252Fvar&password=QueryDouble-Secret",
      "postgres://localhost/argus?host=%5Cserver&password=QueryBackslash-Secret",
      "postgres://localhost/argus?host=%00evil&password=QueryNul-Secret",
      "postgres://localhost/argus?host=%20evil&password=QuerySpace-Secret",
      "postgres://localhost/argus?host=good.internal&host=%2Fsocket&password=LastHost-Secret",
      "postgres://user:ShadowedAuthority-Secret@%2Fsocket/argus?host=good.internal",
    ];
    for (const url of invalid) {
      let thrown: unknown;
      try {
        validateConfig({
          version: 1,
          runtime: { role: "api" },
          storage: { adapter: "postgres", url },
          sources: {},
          watches: [],
          api: { token: "independent-pepper" },
        });
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).toContain(
        "PostgreSQL URL must use postgres:// or postgresql:// with a nonempty host and valid percent encoding.",
      );
      expect(String(thrown)).not.toContain(url);
      for (const secret of [
        "EmptyHost-Secret",
        "Malformed%ZZ-Secret",
        "MissingScheme-Secret",
        "Opaque-Secret",
        "MissingHost-Secret",
        "WrongScheme-Secret",
        "Fragment-Secret",
        "Socket-Secret",
        "Port-Secret",
        "AuthoritySlash-Secret",
        "AuthorityBackslash-Secret",
        "AuthorityDouble-Secret",
        "AuthorityNul-Secret",
        "AuthoritySpace-Secret",
        "AuthorityPath-Secret",
        "QueryDouble-Secret",
        "QueryBackslash-Secret",
        "QueryNul-Secret",
        "QuerySpace-Secret",
        "LastHost-Secret",
        "ShadowedAuthority-Secret",
      ]) {
        expect(String(thrown)).not.toContain(secret);
      }
    }
  });

  it("accepts canonical PostgreSQL network URLs", () => {
    for (const url of [
      "postgres://db.example/argus",
      "postgresql://127.0.0.1:5432/argus?sslmode=disable",
      "postgres://user:secret@[::1]:5432/argus",
      "postgres://:@localhost/argus?password=&user=&application_name=argus",
      "postgres://localhost/argus?password=query-secret&user=query-user",
      "postgres://fallback.example/argus?host=db.internal&port=5432",
      "postgres://fallback.example/argus?host=127.0.0.1",
      "postgres://fallback.example/argus?host=%3A%3A1",
      "postgres://fallback.example/argus?host=%5B%3A%3A1%5D",
      "postgres://fallback.example/argus?host=%2Fshadowed&host=db.internal",
      "postgres://fallback.example/argus?host=",
    ]) {
      expect(
        validateConfig({
          version: 1,
          runtime: { role: "api" },
          storage: { adapter: "postgres", url },
          sources: {},
          watches: [],
          api: { token: "independent-pepper" },
        }).storage.url,
      ).toBe(url);
    }
  });

  it("never returns an invalid credential-bearing PostgreSQL URL from redaction", () => {
    const invalidUrl = "postgres://user:Projection-Secret@/argus";
    const unsafe = {
      version: 1 as const,
      runtime: { role: "api" as const },
      storage: { adapter: "postgres" as const, url: invalidUrl },
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
      api: {
        host: "0.0.0.0",
        port: 8788,
        token: "independent-pepper",
      },
    };
    let thrown: unknown;
    try {
      serializeRedactedConfig(unsafe);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain(
      "PostgreSQL URL must use postgres:// or postgresql:// with a nonempty host and valid percent encoding.",
    );
    expect(String(thrown)).not.toContain(invalidUrl);
    expect(String(thrown)).not.toContain("Projection-Secret");
  });

  it("never returns an unparseable credential-bearing source URL from redaction", () => {
    const invalidUrl = "not-a-url user:Generic-Projection-Secret";
    let thrown: unknown;
    try {
      withoutUrlCredentials(invalidUrl);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain(
      "Configuration URL could not be safely redacted.",
    );
    expect(String(thrown)).not.toContain(invalidUrl);
    expect(String(thrown)).not.toContain("Generic-Projection-Secret");
  });
});
