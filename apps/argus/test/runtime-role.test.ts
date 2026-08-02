import { validateConfig } from "@argus/config";
import { describe, expect, it } from "vitest";
import { migrateRuntime, resolveRuntimeRole } from "../src/runtime.js";

describe("runtime role override", () => {
  it("rejects split roles when the configured storage is SQLite", () => {
    const config = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
    });
    expect(() => resolveRuntimeRole(config, "api")).toThrow(
      "SQLite requires runtime.role to be 'all'",
    );
  });

  it("allows a PostgreSQL service to select a split role", () => {
    const config = validateConfig({
      version: 1,
      storage: { adapter: "postgres", url: "postgresql://localhost/argus" },
      sources: {},
      watches: [],
    });
    expect(resolveRuntimeRole(config, "worker").runtime.role).toBe("worker");
  });

  it("runs schema migration as a one-shot runtime and closes the repository", async () => {
    const config = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
    });
    let closed = false;

    await migrateRuntime("/app/argus.yaml", {}, {
      loadConfig: async () => config,
      openRepository: async () => ({
        repository: {} as never,
        close: async () => {
          closed = true;
        },
      }),
    });

    expect(closed).toBe(true);
  });
});
