import { validateConfig } from "@argus/config";
import { describe, expect, it } from "vitest";
import { resolveRuntimeRole } from "../src/runtime.js";

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
});
