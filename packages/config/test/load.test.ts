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
      resolveSecretReference("${OPENROUTER_API_KEY}", {
        OPENROUTER_API_KEY: "x",
      }),
    ).toBe("x");
    const config = await loadConfig(fixture("valid.yaml"), {
      OPENROUTER_API_KEY: "secret",
    });
    expect(serializeRedactedConfig(config)).not.toContain("secret");
  });
});
