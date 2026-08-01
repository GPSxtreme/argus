import { validateConfig } from "@argus/config";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { targetsFromConfig } from "@argus/scheduler";
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
    const diagnosticConfig = validateConfig({ version: 1, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [{ id: "diagnostic-source", schedule: "* * * * *", inputs: { web: { urls: ["https://example.com/a"] } } }], api: { token: "secret" } });
    const app = createApp({ config: diagnosticConfig, repository });
    expect((await app.request("/v1/records")).status).toBe(401);
    const response = await app.request("/v1/records?q=Argus", {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].url).toBe("https://example.com/1");
  });

  it("queues an immediate ingestion trigger for a configured watch", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const triggerConfig = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: { telegram: { enabled: true } },
      watches: [
        {
          id: "releases",
          schedule: "0 * * * *",
          inputs: { telegram: { channels: ["argus"] } },
        },
      ],
      api: { token: "secret" },
    });
    const response = await createApp({
      config: triggerConfig,
      repository,
    }).request("/v1/watches/releases/ingest", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(202);
    expect((await response.json()).queued).toBe(1);
    expect(await repository.claimJobs("test", 10, 30_000)).toHaveLength(1);
  });

  it("rejects a malformed record limit", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const response = await createApp({ config, repository }).request(
      "/v1/records?limit=not-a-number",
      { headers: { authorization: "Bearer secret" } },
    );
    expect(response.status).toBe(400);
  });

  it("creates and only tombstones its authenticated temporary diagnostic watch", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const diagnosticConfig = validateConfig({ version: 1, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [{ id: "diagnostic-source", schedule: "* * * * *", inputs: { web: { urls: ["https://example.com/a"] } } }], api: { token: "secret" } });
    const app = createApp({ config: diagnosticConfig, repository });
    expect((await app.request("/v1/diagnostics/smoke-watches", { method: "POST" })).status).toBe(401);
    const invalid = await app.request("/v1/diagnostics/smoke-watches", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ source: "web", targetId: targetsFromConfig(diagnosticConfig)[0]?.id, token: "do-not-echo" }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("do-not-echo");
    expect((await app.request("/v1/diagnostics/smoke-watches", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ source: "telegram", targetId: targetsFromConfig(diagnosticConfig)[0]?.id }) })).status).toBe(404);
    const created = await app.request("/v1/diagnostics/smoke-watches", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ source: "web", targetId: targetsFromConfig(diagnosticConfig)[0]?.id }) });
    expect(created.status).toBe(202);
    const diagnostic = await created.json() as { id: string; targetId: string };
    expect(await repository.claimJobs("worker", 10, 30_000)).toHaveLength(1);
    expect((await app.request(`/v1/diagnostics/smoke-watches/${diagnostic.id}`, { method: "DELETE", headers: { authorization: "Bearer secret" } })).status).toBe(204);
    expect(await repository.getDiagnosticWatch(diagnostic.targetId)).toBeUndefined();
    expect(diagnosticConfig.watches).toHaveLength(1);
  });

  it("rejects diagnostics when the source is globally disabled", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const disabledConfig = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: { web: { enabled: false } },
      watches: [
        {
          id: "disabled-source",
          schedule: "* * * * *",
          inputs: { web: { urls: ["https://example.com/a"] } },
        },
      ],
      api: { token: "secret" },
    });
    const target = targetsFromConfig(disabledConfig)[0];
    const response = await createApp({
      config: disabledConfig,
      repository,
    }).request("/v1/diagnostics/smoke-watches", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ source: "web", targetId: target?.id }),
    });
    expect(response.status).toBe(404);
  });
});
