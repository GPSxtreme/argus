import { validateConfig } from "@argus/config";
import { describe, expect, it } from "vitest";
import {
  assertApiBindGuard,
  migrateRuntime,
  resolveRuntimeRole,
} from "../src/runtime.js";

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

  it("refuses a non-loopback bind without an API token", () => {
    const exposed = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
      api: { host: "0.0.0.0" },
    });
    expect(() => assertApiBindGuard(exposed)).toThrow(
      "api.token is required when the API binds a non-loopback host",
    );
    const v6Exposed = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
      api: { host: "::" },
    });
    expect(() => assertApiBindGuard(v6Exposed)).toThrow(/api.token is required/u);
  });

  it("allows loopback binds and token-protected binds", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      const config = validateConfig({
        version: 1,
        storage: { adapter: "sqlite", url: ":memory:" },
        sources: {},
        watches: [],
        api: { host },
      });
      expect(() => assertApiBindGuard(config)).not.toThrow();
    }
    const protectedBind = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
      api: { host: "0.0.0.0", token: "secret" },
    });
    expect(() => assertApiBindGuard(protectedBind)).not.toThrow();
  });
});
