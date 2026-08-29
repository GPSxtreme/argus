import { type ArgusConfig, validateConfig } from "@argus/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => ({
  create: vi.fn(async () => ({
    migrate: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("@argus/storage-postgres", () => ({
  createPostgresRepository: postgres.create,
}));

const { openRepository } = await import("../src/repository.js");

describe("runtime repository", () => {
  beforeEach(() => {
    postgres.create.mockClear();
  });

  it("opens PostgreSQL with the complete live resolved URL", async () => {
    const password = "Argus-Runtime@:/?#[]% secret";
    const liveUrl =
      "postgres://argus-admin@postgres:5432/argus" +
      `?password=${encodeURIComponent(password)}` +
      "&sslmode=verify-full&application_name=argus";
    const config = validateConfig({
      version: 2,
      runtime: { role: "api" },
      storage: { adapter: "postgres", url: liveUrl },
      sources: {},
      watches: [],
    });

    await openRepository(config);

    expect(postgres.create).toHaveBeenCalledWith({
      connectionString: liveUrl,
    });
    expect(config.storage.url).toBe(liveUrl);
  });

  it("rejects decoded Unix-socket PostgreSQL hosts before opening the driver", async () => {
    const invalidUrl =
      "postgres://user:Runtime-Secret@%2Fvar%2Frun%2Fpostgresql/argus";
    const unsafe = {
      ...validateConfig({
        version: 2,
        runtime: { role: "api" },
        storage: { adapter: "postgres", url: "postgres://localhost/argus" },
        sources: {},
        watches: [],
        api: { token: "independent-pepper" },
      }),
      storage: { adapter: "postgres", url: invalidUrl },
    } as ArgusConfig;

    let thrown: unknown;
    try {
      await openRepository(unsafe);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain(
      "PostgreSQL URL must use postgres:// or postgresql:// with a nonempty host and valid percent encoding.",
    );
    expect(String(thrown)).not.toContain(invalidUrl);
    expect(String(thrown)).not.toContain("Runtime-Secret");
    expect(postgres.create).not.toHaveBeenCalled();
  });
});
