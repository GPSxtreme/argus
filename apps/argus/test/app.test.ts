import { validateConfig } from "@argus/config";
import { recordIdentity } from "@argus/contracts";
import { targetsFromConfig } from "@argus/scheduler";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const config = validateConfig({
  version: 2,
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
    expect(await response.json()).toMatchObject({ status: "ok", version: 2 });
  });

  it("protects and serves deterministic record queries", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    await repository.upsertRecord({
      id: recordIdentity("web", "1"),
      source: "web",
      targetId: "site",
      externalId: "1",
      url: "https://example.com/1",
      text: "Argus V1",
      raw: {},
      watchIds: ["argus"],
      contentHash: "hash",
      firstSeenAt: "2026-07-31T00:00:00.000Z",
      lastSeenAt: "2026-07-31T00:00:00.000Z",
    });
    const diagnosticConfig = validateConfig({ version: 2, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [{ id: "diagnostic-source", schedule: "* * * * *", inputs: { web: { urls: ["https://example.com/a"] } } }], api: { token: "secret" } });
    const app = createApp({ config: diagnosticConfig, repository });
    expect((await app.request("/v1/records")).status).toBe(401);
    const response = await app.request("/v1/records?q=Argus", {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].url).toBe("https://example.com/1");
  });

  it("serves rich record detail and observed conversation snapshots", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const rootRecordId = recordIdentity("x", "root");
    const replyRecordId = recordIdentity("x", "reply");
    await repository.upsertRecord({
      id: rootRecordId,
      source: "x",
      targetId: "movies:x:account:FilmUpdates",
      watchIds: ["movies"],
      externalId: "root",
      url: "https://x.com/FilmUpdates/status/root",
      text: "Trailer",
      media: [{ kind: "image", url: "https://cdn.example/trailer.jpg" }],
      raw: {},
      contentHash: "root-hash",
      firstSeenAt: "2026-08-29T00:00:00.000Z",
      lastSeenAt: "2026-08-29T00:00:00.000Z",
    });
    await repository.upsertRecord({
      id: replyRecordId,
      source: "x",
      targetId: `__argus_x_conversation:${rootRecordId}`,
      watchIds: ["movies"],
      externalId: "reply",
      url: "https://x.com/viewer/status/reply",
      text: "Looks great",
      raw: {},
      contentHash: "reply-hash",
      firstSeenAt: "2026-08-29T01:00:00.000Z",
      lastSeenAt: "2026-08-29T01:00:00.000Z",
    });
    await repository.saveConversationSnapshot({
      snapshot: {
        id: "snapshot",
        rootRecordId,
        observedCount: 1,
        retainedCount: 1,
        orderBy: "likes",
        pagesFetched: 1,
        complete: true,
        truncated: false,
        collectedAt: "2026-08-29T01:00:00.000Z",
      },
      items: [
        { snapshotId: "snapshot", replyRecordId, rank: 1, sortValue: 10 },
      ],
    });
    const app = createApp({ config, repository });
    const headers = { authorization: "Bearer secret" };

    const detail = await app.request(`/v1/records/${rootRecordId}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: rootRecordId,
      media: [{ kind: "image", url: "https://cdn.example/trailer.jpg" }],
      watches: [{ watchId: "movies" }],
    });
    const conversation = await app.request(
      `/v1/records/${rootRecordId}/conversation-snapshots`,
      { headers },
    );
    expect(conversation.status).toBe(200);
    expect(await conversation.json()).toMatchObject({
      items: [
        {
          observedCount: 1,
          retainedCount: 1,
          items: [{ replyRecordId, rank: 1 }],
        },
      ],
    });
  });

  it("proxies authenticated X and web primitives without persistence", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const primitiveConfig = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {
        x: { enabled: true, endpoint: "https://fx.example.com/api" },
        web: {
          enabled: true,
          searchEndpoint: "https://search.example.com/base",
        },
      },
      watches: [],
      api: { token: "secret" },
    });
    const fetcher = vi.fn(async (url: URL) =>
      Response.json({ upstream: url.href }),
    ) as unknown as typeof fetch;
    const app = createApp({ config: primitiveConfig, repository, primitiveFetcher: fetcher });
    const headers = { authorization: "Bearer secret" };

    const x = await app.request(
      "/v1/primitives/x/2/conversation/root?cursor=next",
      { headers },
    );
    expect(x.status).toBe(200);
    expect(await x.json()).toEqual({
      upstream:
        "https://fx.example.com/api/2/conversation/root?cursor=next",
    });
    const web = await app.request("/v1/primitives/web/search?q=movie+news", {
      headers,
    });
    expect(web.status).toBe(200);
    expect(await web.json()).toEqual({
      upstream:
        "https://search.example.com/base/search?q=movie+news&format=json",
    });
    expect((await repository.queryRecords({})).items).toEqual([]);
    expect((await repository.queryArtifacts({})).items).toEqual([]);
  });

  it("never exposes primitives without a configured API token", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const publicConfig = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: { x: { enabled: true } },
      watches: [],
    });
    const response = await createApp({ config: publicConfig, repository }).request(
      "/v1/primitives/x/2/status/20",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "PRIMITIVE_AUTH_REQUIRED",
        message: "Configure api.token before using source primitives.",
      },
    });
  });

  it("answers a natural-language query from recent records with source links", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    await repository.upsertRecord({
      id: recordIdentity("web", "listing"),
      source: "web",
      targetId: "listings:web:feed:example",
      watchIds: ["listings"],
      externalId: "listing",
      url: "https://example.com/listing",
      text: "A new listing appeared at 10am.",
      raw: {},
      contentHash: "listing-hash",
      firstSeenAt: "2026-08-29T10:00:00.000Z",
      lastSeenAt: "2026-08-29T10:00:00.000Z",
    });
    const intelligenceConfig = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
      api: { token: "secret" },
      intelligence: {
        enabled: true,
        apiKey: "openrouter-key",
        model: "openai/gpt-4.1-mini",
      },
    });
    const openRouterFetcher = vi.fn(async () =>
      Response.json({
        id: "generation-1",
        model: "openai/gpt-4.1-mini",
        choices: [{ message: { content: "One new listing appeared. [1]" } }],
      }),
    ) as unknown as typeof fetch;
    const response = await createApp({
      config: intelligenceConfig,
      repository,
      openRouterFetcher,
    }).request("/v1/query", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        question: "new listings since 9am",
        watchIds: ["listings"],
        since: "2026-08-29T09:00:00.000Z",
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      answer: "One new listing appeared. [1]",
      sources: [
        {
          index: 1,
          recordId: recordIdentity("web", "listing"),
          url: "https://example.com/listing",
        },
      ],
    });
    expect((await repository.queryArtifacts({ kind: "answer" })).items).toHaveLength(1);
  });

  it("queues an immediate ingestion trigger for a configured watch", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const triggerConfig = validateConfig({
      version: 2,
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

  it("serves versioned record cursors and rejects legacy or malformed cursors", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    for (const [id, ingestedAt] of [
      ["new", "2026-08-01T01:00:00.000Z"],
      ["old", "2026-08-01T00:00:00.000Z"],
    ] as const) {
      await repository.upsertRecord({
        id: recordIdentity("web", id),
        source: "web",
        targetId: "site",
        externalId: id,
        url: `https://example.com/${id}`,
        text: id,
        raw: {},
        watchIds: ["argus"],
        contentHash: id,
        firstSeenAt: ingestedAt,
        lastSeenAt: ingestedAt,
      });
    }
    const app = createApp({ config, repository });
    const first = await app.request("/v1/records?limit=1", {
      headers: { authorization: "Bearer secret" },
    });
    const firstBody = (await first.json()) as {
      items: Array<{ externalId: string }>;
      nextCursor: string;
    };
    expect(firstBody.items.map(({ externalId }) => externalId)).toEqual(["new"]);
    const second = await app.request(
      `/v1/records?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: { authorization: "Bearer secret" } },
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { items: Array<{ externalId: string }> }).items).toEqual([
      expect.objectContaining({ externalId: "old" }),
    ]);

    for (const cursor of [
      Buffer.from("1").toString("base64url"),
      "not+base64url",
    ]) {
      const invalid = await app.request(
        `/v1/records?cursor=${encodeURIComponent(cursor)}`,
        { headers: { authorization: "Bearer secret" } },
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid records cursor" });
    }
  });

  it("creates and only tombstones its authenticated temporary diagnostic watch", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const diagnosticConfig = validateConfig({ version: 2, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [{ id: "diagnostic-source", schedule: "* * * * *", inputs: { web: { urls: ["https://example.com/a"] } } }], api: { token: "secret" } });
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
      version: 2,
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

  it("authenticates and binds in-service config apply to the exact inspected hashes", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const postgresPassword = "Argus-Management@:/?#[]% secret";
    const encodedPostgresPassword = encodeURIComponent(postgresPassword);
    const postgresUrl =
      "postgres://argus-admin@postgres:5432/argus" +
      `?password=${encodedPostgresPassword}` +
      "&sslmode=verify-full&application_name=argus";
    const credentialFragments = [
      postgresPassword,
      encodedPostgresPassword,
      decodeURIComponent(encodedPostgresPassword),
      postgresUrl,
    ];
    const desired = {
      version: 2,
      storage: { adapter: "postgres", url: postgresUrl },
      sources: {},
      watches: [],
      api: { token: "secret" },
    };

    expect(
      (
        await app.request("/v1/management/config/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/opt/argus/argus.yaml", config: desired }),
        })
      ).status,
    ).toBe(401);

    const planned = await app.request("/v1/management/config/plan", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "/opt/argus/argus.yaml", config: desired }),
    });
    expect(planned.status).toBe(200);
    const plannedText = await planned.text();
    for (const credential of credentialFragments) {
      expect(plannedText).not.toContain(credential);
    }
    const plan = JSON.parse(plannedText) as {
      planId: string;
      desiredContentHash: string;
    };
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.desiredContentHash).toMatch(/^[a-f0-9]{64}$/u);

    const stale = await app.request("/v1/management/config/apply", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "/opt/argus/argus.yaml",
        config: desired,
        inspection: { ...plan, desiredContentHash: "f".repeat(64) },
      }),
    });
    expect(stale.status).toBe(409);
    const staleText = await stale.text();
    for (const credential of credentialFragments) {
      expect(staleText).not.toContain(credential);
    }
    expect(await repository.getAppliedConfig()).toBeUndefined();

    const applied = await app.request("/v1/management/config/apply", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "/opt/argus/argus.yaml",
        config: desired,
        inspection: plan,
      }),
    });
    expect(applied.status).toBe(200);
    const appliedText = await applied.text();
    for (const credential of credentialFragments) {
      expect(appliedText).not.toContain(credential);
    }
    const persisted = await repository.getAppliedConfig();
    expect(persisted).toMatchObject({
      contentHash: plan.desiredContentHash,
      config: {
        storage: {
          adapter: "postgres",
          url: "postgres://postgres:5432/argus?sslmode=verify-full&application_name=argus",
        },
      },
    });
    const persistedText = JSON.stringify(persisted);
    for (const credential of credentialFragments) {
      expect(persistedText).not.toContain(credential);
    }

    const verified = await app.request("/v1/management/config/verify", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ inspection: plan }),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      healthy: true,
      planId: plan.planId,
    });
  });

  it("rejects summary requests with malformed bodies", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const intelligenceConfig = validateConfig({
      version: 2,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: {},
      watches: [],
      api: { token: "secret" },
      intelligence: {
        enabled: true,
        apiKey: "sk-openrouter",
        model: "openai/gpt-4.1-mini",
      },
    });
    const app = createApp({ config: intelligenceConfig, repository });
    const malformed = await app.request("/v1/summaries", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    const outOfRange = await app.request("/v1/summaries", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "security", limit: 10_000 }),
    });
    expect(outOfRange.status).toBe(400);
    const nonNumeric = await app.request("/v1/summaries", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: "many" }),
    });
    expect(nonNumeric.status).toBe(400);
  });

  it("requires a token even for disabled intelligence summary attempts", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const response = await createApp({ config, repository }).request(
      "/v1/summaries",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(401);
  });

  it("rejects non-matching bearer tokens with constant-time comparison", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const wrongLength = await app.request("/v1/records", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrongLength.status).toBe(401);
    const wrongValue = await app.request("/v1/records", {
      headers: { authorization: `Bearer ${"x".repeat("secret".length)}` },
    });
    expect(wrongValue.status).toBe(401);
  });

  it("rejects non-ISO since and until filters", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const badSince = await app.request("/v1/records?since=not-a-date", {
      headers: { authorization: "Bearer secret" },
    });
    expect(badSince.status).toBe(400);
    const badUntil = await app.request("/v1/records?until=2026-13-99", {
      headers: { authorization: "Bearer secret" },
    });
    expect(badUntil.status).toBe(400);
    const valid = await app.request(
      "/v1/records?since=2026-08-01T00:00:00Z&until=2026-08-02",
      { headers: { authorization: "Bearer secret" } },
    );
    expect(valid.status).toBe(200);
  });
});
