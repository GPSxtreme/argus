import { validateConfig } from "@argus/config";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const config = validateConfig({
  version: 1,
  storage: { adapter: "sqlite", url: ":memory:" },
  sources: {},
  watches: [],
  api: { token: "secret" },
});

describe("Argus API", () => {
  it("reports health without authentication", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const response = await createApp({ config, repository }).request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", version: 1 });
  });

  it("protects and serves deterministic record queries", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    await repository.upsertRecord({
      id: "web:site:1",
      source: "web",
      targetId: "site",
      externalId: "1",
      url: "https://example.com/1",
      text: "Argus V1",
      raw: {},
      watchIds: ["argus"],
      contentHash: "hash",
      ingestedAt: "2026-07-31T00:00:00.000Z",
    });
    const app = createApp({ config, repository });
    expect((await app.request("/v1/records")).status).toBe(401);
    const response = await app.request("/v1/records?q=Argus", {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].url).toBe("https://example.com/1");
  });
});
