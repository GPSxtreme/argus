# Argus V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and privately deploy a self-hosted TypeScript data layer that ingests X, public Telegram announcement channels, URLs, RSS/Atom feeds, and web searches into SQLite or PostgreSQL, exposes deterministic queries, and optionally creates OpenRouter summaries.

**Architecture:** A pnpm/Turborepo modular monolith exposes one role-selectable runtime and a separate CLI. Source adapters emit canonical records into a transactional storage contract; database-backed jobs, checkpoints, leases, and outbox events support both one-process and split-role deployments.

**Tech Stack:** Node.js 24, TypeScript 6, pnpm 10, Turborepo, Hono, Zod, YAML, Kysely, better-sqlite3, PostgreSQL (`pg`), Vitest, Testcontainers, Pino, Croner, Crawlee/Cheerio, Mozilla Readability/JSDOM, feedsmith, OpenRouter Chat Completions, Docker Compose.

## Global Constraints

- The core ingestion, storage, and deterministic query path must run with intelligence disabled.
- SQLite supports only runtime role `all`; PostgreSQL supports `all`, split roles, and replicas.
- Delivery is at least once; `(source, target_id, external_id)` plus content hashes make writes idempotent.
- Raw payloads and immutable revisions are preserved; processors create derived artifacts and never mutate source records.
- V1 Telegram supports anonymous public announcement channels only.
- V1 Web does not bypass authentication, CAPTCHA, robots policy, or network access controls.
- Secrets come from environment variables, are redacted from logs, and are not stored in applied YAML.
- No Redis, Kafka, dynamic plugin loader, private Telegram access, or mandatory semantic search in V1.
- Every task follows red-green-refactor and ends with its focused tests plus root typecheck passing.

---

## File Map

```text
package.json                         root commands and pinned package manager
pnpm-workspace.yaml                 workspace discovery
turbo.json                          dependency-aware tasks
tsconfig.json                       root TypeScript defaults
vitest.config.ts                    unit/integration project discovery

apps/argus/src/app.ts               Hono API composition
apps/argus/src/runtime.ts           role lifecycle
apps/argus/src/main.ts              process entrypoint
apps/cli/src/main.ts                operational CLI

packages/contracts/src/domain.ts    canonical domain values
packages/contracts/src/source.ts    source adapter interfaces
packages/contracts/src/storage.ts   storage repository contract
packages/contracts/src/errors.ts    normalized errors

packages/config/src/schema.ts       Zod configuration schema
packages/config/src/load.ts         YAML and secret-reference loading
packages/config/src/reconcile.ts    atomic applied-config reconciliation

packages/storage-sqlite/src/db.ts   SQLite connection and migrations
packages/storage-sqlite/src/repo.ts SQLite repository
packages/storage-postgres/src/db.ts PostgreSQL connection and migrations
packages/storage-postgres/src/repo.ts PostgreSQL repository

packages/engine/src/normalize.ts    canonical record construction
packages/engine/src/ingest.ts       transactional ingestion pipeline
packages/engine/src/classify.ts     deterministic watch matching
packages/engine/src/outbox.ts       durable event consumer loop

packages/scheduler/src/scheduler.ts due-job creation
packages/scheduler/src/worker.ts    lease claim and source execution
packages/scheduler/src/backoff.ts   bounded retry calculation

packages/source-x/src/client.ts     FxEmbed API client
packages/source-x/src/adapter.ts    account/search adapter
packages/source-telegram/src/client.ts public preview HTTP client
packages/source-telegram/src/parse.ts Telegram HTML parser
packages/source-telegram/src/adapter.ts checkpointed Telegram adapter
packages/source-web/src/url.ts      URL extraction
packages/source-web/src/feed.ts     RSS/Atom ingestion
packages/source-web/src/search.ts   SearXNG discovery
packages/source-web/src/adapter.ts  Web target router

packages/query/src/service.ts       deterministic record queries
packages/query/src/cursor.ts        opaque pagination cursors
packages/intelligence/src/openrouter.ts OpenRouter client
packages/intelligence/src/summarizer.ts summary processor

deploy/docker/Dockerfile            production image
deploy/docker/compose.yaml          single-host stack
deploy/railway/*.toml               role templates
argus.example.yaml                  complete sample configuration
README.md                           product and quickstart
docs/operations.md                  deployment and recovery guide
```

---

### Task 1: Workspace and Canonical Contracts

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/domain.ts`
- Create: `packages/contracts/src/source.ts`
- Create: `packages/contracts/src/storage.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Produces: `RecordEnvelope`, `SourceItem`, `SourceAdapter`, `StorageRepository`, `ArgusError`, `QueryRecordsInput`, and `Page<T>`.
- Consumes: no project interfaces.

- [ ] **Step 1: Write the contract tests**

```ts
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentHash, normalizeError } from "../src/index.js";

describe("canonical contracts", () => {
  it("builds a stable source identity", () => {
    expect(canonicalIdentity("x", "target-1", "post-9"))
      .toBe("x:target-1:post-9");
  });

  it("hashes equal content identically", () => {
    expect(contentHash({ text: "hello", title: "A" }))
      .toBe(contentHash({ title: "A", text: "hello" }));
  });

  it("redacts secrets from normalized errors", () => {
    const error = normalizeError(new Error("Bearer secret-token"), ["secret-token"]);
    expect(error.message).toBe("Bearer [REDACTED]");
    expect(error.kind).toBe("retryable");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm vitest run packages/contracts/test/contracts.test.ts`  
Expected: FAIL because the workspace and exported functions do not exist.

- [ ] **Step 3: Implement the workspace and contracts**

Define the canonical source values, immutable record and revision shapes,
source adapter capability contract, storage repository operations, query
filters, job/lease values, derived artifacts, and normalized error taxonomy.
Use stable recursive key sorting before SHA-256 hashing.

```ts
export const canonicalIdentity = (
  source: SourceName,
  targetId: string,
  externalId: string,
) => `${source}:${targetId}:${externalId}`;

export interface SourceAdapter<C = unknown, K = unknown> {
  readonly kind: string;
  readonly capabilities: SourceCapabilities;
  validate(config: C): Promise<ValidationResult>;
  pull(input: PullInput<C, K>): AsyncIterable<SourceItem>;
}
```

- [ ] **Step 4: Run verification**

Run: `pnpm vitest run packages/contracts/test/contracts.test.ts && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.json vitest.config.ts .gitignore .nvmrc packages/contracts
git commit -m "feat: establish workspace and canonical contracts"
```

### Task 2: Versioned YAML Configuration

**Files:**
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/schema.ts`
- Create: `packages/config/src/load.ts`
- Create: `packages/config/src/index.ts`
- Create: `argus.example.yaml`
- Test: `packages/config/test/load.test.ts`
- Test: `packages/config/test/fixtures/valid.yaml`
- Test: `packages/config/test/fixtures/invalid-sqlite-role.yaml`

**Interfaces:**
- Consumes: `ValidationResult` from `@argus/contracts`.
- Produces: `ArgusConfig`, `loadConfig(path, env)`, `validateConfig(value)`, and `resolveSecretReference(value, env)`.

- [ ] **Step 1: Write failing configuration tests**

```ts
describe("loadConfig", () => {
  it("parses watches across the source trinity", async () => {
    const config = await loadConfig(fixture("valid.yaml"), {
      OPENROUTER_API_KEY: "secret",
    });
    expect(config.version).toBe(1);
    expect(config.watches[0].inputs.telegram?.channels)
      .toEqual(["solana_announcements"]);
  });

  it("rejects split roles with SQLite", async () => {
    await expect(loadConfig(fixture("invalid-sqlite-role.yaml"), {}))
      .rejects.toThrow("SQLite requires runtime.role to be 'all'");
  });

  it("resolves secrets without preserving the reference in serialized config", () => {
    expect(resolveSecretReference("${OPENROUTER_API_KEY}", { OPENROUTER_API_KEY: "x" }))
      .toBe("x");
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/config/test/load.test.ts`  
Expected: FAIL because `loadConfig` is missing.

- [ ] **Step 3: Implement the schema and loader**

Use strict Zod objects with `version: 1`, discriminated storage adapters, source
configuration, named watches, five-field cron strings, retention, runtime role,
API security, and optional processors. Preserve an unresolved redacted
configuration separately from resolved runtime secrets.

```ts
export const argusConfigSchema = z.object({
  version: z.literal(1),
  runtime: z.object({ role: runtimeRoleSchema.default("all") }).default({ role: "all" }),
  storage: storageSchema,
  sources: sourcesSchema,
  watches: z.array(watchSchema).default([]),
  intelligence: intelligenceSchema.default({ enabled: false, processors: [] }),
}).superRefine(validateDeploymentConstraints);
```

- [ ] **Step 4: Verify the configuration package**

Run: `pnpm vitest run packages/config/test/load.test.ts && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config argus.example.yaml
git commit -m "feat: add versioned YAML configuration"
```

### Task 3: SQLite Storage Contract

**Files:**
- Create: `packages/storage-sqlite/package.json`
- Create: `packages/storage-sqlite/tsconfig.json`
- Create: `packages/storage-sqlite/src/schema.ts`
- Create: `packages/storage-sqlite/src/migrate.ts`
- Create: `packages/storage-sqlite/src/db.ts`
- Create: `packages/storage-sqlite/src/repo.ts`
- Create: `packages/storage-sqlite/src/index.ts`
- Test: `packages/storage-sqlite/test/repository.test.ts`
- Test helper: `packages/contracts/test/storage-contract.ts`

**Interfaces:**
- Consumes: `StorageRepository` and all persisted values from `@argus/contracts`.
- Produces: `createSqliteRepository({ filename }): StorageRepository`.

- [ ] **Step 1: Write the shared repository contract**

```ts
export function storageContract(createRepo: () => Promise<StorageRepository>) {
  it("deduplicates identical records and creates revisions for edits", async () => {
    const repo = await createRepo();
    const first = await repo.upsertRecord(record({ contentHash: "a" }));
    const duplicate = await repo.upsertRecord(record({ contentHash: "a" }));
    const edited = await repo.upsertRecord(record({ contentHash: "b" }));
    expect(first.status).toBe("inserted");
    expect(duplicate.status).toBe("duplicate");
    expect(edited.status).toBe("revised");
    expect((await repo.listRevisions(first.record.id)).items).toHaveLength(2);
  });

  it("commits record, matches, outbox event, and checkpoint atomically", async () => {
    await expect(repo.commitIngestion(batch())).resolves.toMatchObject({
      inserted: 1,
      checkpointAdvanced: true,
    });
  });
}
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/storage-sqlite/test/repository.test.ts`  
Expected: FAIL because the SQLite repository does not exist.

- [ ] **Step 3: Implement migrations and repository**

Create tables and indexes for configurations, watches, targets, jobs, attempts,
leases, checkpoints, records, revisions, matches, artifacts, and outbox events.
Enable WAL and foreign keys. Add FTS5 external-content indexing for current
record title and text. Implement all storage operations in explicit
transactions.

```ts
export async function createSqliteRepository(
  input: { filename: string },
): Promise<StorageRepository> {
  const sqlite = new Database(input.filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  await migrateSqlite(sqlite);
  return new SqliteRepository(sqlite);
}
```

- [ ] **Step 4: Run the SQLite suite**

Run: `pnpm vitest run packages/storage-sqlite/test/repository.test.ts && pnpm turbo typecheck`  
Expected: PASS, including deduplication, revisions, rollback, FTS, cursor
pagination, job leases, outbox claims, and derived artifacts.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/test/storage-contract.ts packages/storage-sqlite
git commit -m "feat: implement SQLite persistence"
```

### Task 4: PostgreSQL Storage Contract

**Files:**
- Create: `packages/storage-postgres/package.json`
- Create: `packages/storage-postgres/tsconfig.json`
- Create: `packages/storage-postgres/src/schema.ts`
- Create: `packages/storage-postgres/src/migrate.ts`
- Create: `packages/storage-postgres/src/db.ts`
- Create: `packages/storage-postgres/src/repo.ts`
- Create: `packages/storage-postgres/src/index.ts`
- Test: `packages/storage-postgres/test/repository.test.ts`

**Interfaces:**
- Consumes: the shared `storageContract`.
- Produces: `createPostgresRepository({ connectionString }): StorageRepository`.

- [ ] **Step 1: Apply the shared contract to a PostgreSQL container**

```ts
describe.sequential("PostgreSQL repository", () => {
  let container: StartedPostgreSqlContainer;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(() => container.stop());
  storageContract(() =>
    createPostgresRepository({ connectionString: container.getConnectionUri() }),
  );
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/storage-postgres/test/repository.test.ts`  
Expected: FAIL because the PostgreSQL repository does not exist.

- [ ] **Step 3: Implement PostgreSQL migrations and repository**

Use `jsonb`, `timestamptz`, generated `tsvector` search data, GIN indexes,
`FOR UPDATE SKIP LOCKED` job/outbox claims, and expiring lease timestamps.
Match SQLite behavior exactly at the repository boundary.

```sql
UPDATE jobs
SET lease_owner = $1, lease_expires_at = now() + $2::interval, status = 'running'
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued'
    AND run_at <= now()
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
  ORDER BY run_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

- [ ] **Step 4: Run the PostgreSQL contract suite**

Run: `pnpm vitest run packages/storage-postgres/test/repository.test.ts && pnpm turbo typecheck`  
Expected: PASS with the same assertions as SQLite.

- [ ] **Step 5: Commit**

```bash
git add packages/storage-postgres
git commit -m "feat: implement PostgreSQL persistence"
```

### Task 5: Atomic Configuration Reconciliation

**Files:**
- Create: `packages/config/src/reconcile.ts`
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/test/reconcile.test.ts`

**Interfaces:**
- Consumes: `ArgusConfig`, `StorageRepository.applyConfiguration`.
- Produces: `reconcileConfig(repo, loadedConfig): Promise<ApplyResult>`.

- [ ] **Step 1: Write reconciliation tests**

```ts
it("atomically creates, updates, disables, and preserves target identities", async () => {
  const first = await reconcileConfig(repo, configWith(["solana", "ethereum"]));
  const second = await reconcileConfig(repo, configWith(["solana", "base"]));
  expect(first.createdTargets).toBe(2);
  expect(second.createdTargets).toBe(1);
  expect(second.disabledTargets).toBe(1);
  expect(await repo.getTargetByKey("x:account:solana"))
    .toMatchObject({ enabled: true });
});

it("keeps the previous configuration when reconciliation fails", async () => {
  repo.injectFailure("applyConfiguration");
  await expect(reconcileConfig(repo, configWith(["broken"]))).rejects.toThrow();
  expect((await repo.getActiveConfiguration()).version).toBe(1);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/config/test/reconcile.test.ts`  
Expected: FAIL because reconciliation is not implemented.

- [ ] **Step 3: Implement normalized desired state and one transaction**

Derive stable target keys from source, kind, and source locator. Resolve watch
references to target IDs, replace schedules and rules, disable removed targets,
persist a redacted configuration snapshot, and activate it only at transaction
commit.

- [ ] **Step 4: Verify reconciliation**

Run: `pnpm vitest run packages/config/test/reconcile.test.ts && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/reconcile.ts packages/config/src/index.ts packages/config/test/reconcile.test.ts
git commit -m "feat: reconcile configuration atomically"
```

### Task 6: Ingestion Engine and Deterministic Classification

**Files:**
- Create: `packages/engine/package.json`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/src/normalize.ts`
- Create: `packages/engine/src/classify.ts`
- Create: `packages/engine/src/ingest.ts`
- Create: `packages/engine/src/outbox.ts`
- Create: `packages/engine/src/index.ts`
- Test: `packages/engine/test/ingest.test.ts`

**Interfaces:**
- Consumes: `SourceItem`, `RecordEnvelope`, `StorageRepository`.
- Produces: `normalizeSourceItem`, `classifyRecord`, `ingestBatch`, and `consumeOutbox`.

- [ ] **Step 1: Write pipeline tests**

```ts
it("stores all records while filters create matches instead of discarding", async () => {
  const result = await ingestBatch({
    repo,
    target,
    watches: [watch({ keywords: ["exploit"] })],
    items: [item("routine update"), item("critical exploit found")],
    checkpoint: { newestId: "2" },
  });
  expect(result.inserted).toBe(2);
  expect((await repo.queryRecords({})).items).toHaveLength(2);
  expect(await repo.listMatches(result.recordIds[1])).toHaveLength(1);
});

it("does not advance a checkpoint when persistence fails", async () => {
  repo.injectFailure("commitIngestion");
  await expect(ingestBatch(input())).rejects.toThrow();
  expect(await repo.getCheckpoint(target.id)).toBeNull();
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/engine/test/ingest.test.ts`  
Expected: FAIL because the engine package is missing.

- [ ] **Step 3: Implement normalization, classification, and ingestion**

Normalize timestamps to UTC ISO strings, calculate stable content hashes from
semantic content, preserve raw payloads, match case-insensitive keywords and
configured regexes, and commit records, matches, outbox events, and checkpoints
through one repository call.

- [ ] **Step 4: Verify the engine**

Run: `pnpm vitest run packages/engine/test/ingest.test.ts && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat: add transactional ingestion engine"
```

### Task 7: Scheduler, Leases, Retries, and Worker Loop

**Files:**
- Create: `packages/scheduler/package.json`
- Create: `packages/scheduler/tsconfig.json`
- Create: `packages/scheduler/src/backoff.ts`
- Create: `packages/scheduler/src/scheduler.ts`
- Create: `packages/scheduler/src/worker.ts`
- Create: `packages/scheduler/src/index.ts`
- Test: `packages/scheduler/test/scheduler.test.ts`
- Test: `packages/scheduler/test/worker.test.ts`

**Interfaces:**
- Consumes: applied watches/targets, adapter registry, storage job operations, `ingestBatch`.
- Produces: `scheduleDueJobs`, `runWorker`, `calculateBackoff`.

- [ ] **Step 1: Write clock-controlled scheduler and retry tests**

```ts
it("creates one due job per target and schedule occurrence", async () => {
  await scheduleDueJobs({ repo, now: instant("2026-07-31T10:00:00Z") });
  await scheduleDueJobs({ repo, now: instant("2026-07-31T10:00:01Z") });
  expect(await repo.countJobs()).toBe(3);
});

it("reclaims an expired lease without duplicating committed records", async () => {
  await repo.expireLease(job.id);
  await worker.runOnce();
  expect((await repo.queryRecords({})).items).toHaveLength(1);
});

it("bounds exponential backoff", () => {
  expect(calculateBackoff(20, { baseMs: 1000, maxMs: 60_000, jitter: 0 }))
    .toBe(60_000);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/scheduler/test`  
Expected: FAIL because scheduler behavior is missing.

- [ ] **Step 3: Implement scheduling and worker lifecycle**

Use Croner to calculate occurrences. Persist a unique `(target_id,
scheduled_for)` job key. Claim leases, invoke the registered adapter, stream
items into bounded ingestion batches, renew long leases, classify normalized
errors, retry retryable failures, and terminally fail exhausted jobs.

- [ ] **Step 4: Verify scheduler and worker**

Run: `pnpm vitest run packages/scheduler/test && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler
git commit -m "feat: add durable scheduler and worker"
```

### Task 8: FxEmbed X Adapter

**Files:**
- Create: `packages/source-x/package.json`
- Create: `packages/source-x/tsconfig.json`
- Create: `packages/source-x/src/client.ts`
- Create: `packages/source-x/src/adapter.ts`
- Create: `packages/source-x/src/index.ts`
- Test: `packages/source-x/test/adapter.test.ts`
- Test fixtures: `packages/source-x/test/fixtures/account-page.json`
- Test fixtures: `packages/source-x/test/fixtures/search-page.json`

**Interfaces:**
- Consumes: `SourceAdapter`, `SourceItem`, X target configuration.
- Produces: `FxEmbedClient` and `createXAdapter`.

- [ ] **Step 1: Write fixture-based account and search tests**

```ts
it("maps an account timeline and advances the timestamp checkpoint", async () => {
  server.use(http.get("http://fx/2/profile/solana/statuses", () =>
    HttpResponse.json(accountFixture),
  ));
  const page = await collect(adapter.pull(pullInput({
    kind: "account",
    handle: "solana",
    checkpoint: { since: 1_700_000_000 },
  })));
  expect(page.items[0]).toMatchObject({
    source: "x",
    externalId: "1888000000000000000",
  });
  expect(page.checkpoint.since).toBeGreaterThan(1_700_000_000);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/source-x/test/adapter.test.ts`  
Expected: FAIL because the X adapter is missing.

- [ ] **Step 3: Implement the FxEmbed client and mappings**

Call `/2/profile/{handle}/statuses` for account targets and `/2/search` for
query targets. Support `since`, `cursor`, page counts, 204 responses, rate-limit
classification, abort signals, and normalized post relationships/media.

- [ ] **Step 4: Verify the X adapter**

Run: `pnpm vitest run packages/source-x/test/adapter.test.ts && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/source-x
git commit -m "feat: ingest X data through FxEmbed"
```

### Task 9: Anonymous Telegram Announcement Adapter

**Files:**
- Create: `packages/source-telegram/package.json`
- Create: `packages/source-telegram/tsconfig.json`
- Create: `packages/source-telegram/src/client.ts`
- Create: `packages/source-telegram/src/parse.ts`
- Create: `packages/source-telegram/src/adapter.ts`
- Create: `packages/source-telegram/src/index.ts`
- Test: `packages/source-telegram/test/adapter.test.ts`
- Test fixtures: `packages/source-telegram/test/fixtures/channel.html`
- Test fixtures: `packages/source-telegram/test/fixtures/preview-unavailable.html`

**Interfaces:**
- Consumes: public channel target and `SourceAdapter`.
- Produces: `parseTelegramPreview`, `TelegramPublicClient`, `createTelegramAdapter`.

- [ ] **Step 1: Write parser, checkpoint, and unavailable-preview tests**

```ts
it("parses public posts and emits only IDs newer than the checkpoint", async () => {
  const items = parseTelegramPreview(channelHtml, {
    channel: "solana_announcements",
    afterPostId: 101,
  });
  expect(items.map((item) => item.externalId)).toEqual(["102", "103"]);
  expect(items[1].metadata).toMatchObject({ views: 12_400 });
});

it("classifies a missing public preview as unsupported", async () => {
  await expect(collect(adapter.pull(input("restricted_channel"))))
    .rejects.toMatchObject({ kind: "unsupported", code: "preview-unavailable" });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/source-telegram/test/adapter.test.ts`  
Expected: FAIL because the Telegram adapter is missing.

- [ ] **Step 3: Implement HTTP polling and post-ID pagination**

Fetch `https://t.me/s/{username}` and `?before={postId}` with bounded retries.
Parse Cheerio selectors for post ID, text, time, views, forwards, author,
canonical URL, media, and links. Backfill older pages when requested; normal
polls re-read a recent edit window and advance `newestPostId`.

- [ ] **Step 4: Verify Telegram ingestion**

Run: `pnpm vitest run packages/source-telegram/test/adapter.test.ts && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/source-telegram
git commit -m "feat: ingest public Telegram announcements"
```

### Task 10: URL, Feed, and SearXNG Web Adapters

**Files:**
- Create: `packages/source-web/package.json`
- Create: `packages/source-web/tsconfig.json`
- Create: `packages/source-web/src/security.ts`
- Create: `packages/source-web/src/url.ts`
- Create: `packages/source-web/src/feed.ts`
- Create: `packages/source-web/src/search.ts`
- Create: `packages/source-web/src/adapter.ts`
- Create: `packages/source-web/src/index.ts`
- Test: `packages/source-web/test/url.test.ts`
- Test: `packages/source-web/test/feed.test.ts`
- Test: `packages/source-web/test/search.test.ts`
- Test fixtures: `packages/source-web/test/fixtures/article.html`
- Test fixtures: `packages/source-web/test/fixtures/feed.xml`
- Test fixtures: `packages/source-web/test/fixtures/search.json`

**Interfaces:**
- Consumes: Web target union and `SourceAdapter`.
- Produces: `fetchReadableUrl`, `parseFeed`, `searchSearxng`, `createWebAdapter`.

- [ ] **Step 1: Write source-specific Web tests**

```ts
it("extracts readable text and uses the canonical URL", async () => {
  const item = await fetchReadableUrl(articleUrl, testFetch);
  expect(item.content.text).toContain("Protocol upgrade");
  expect(item.canonicalUrl).toBe("https://example.com/protocol-upgrade");
});

it("emits one stable record per RSS entry", () => {
  const items = parseFeed(feedXml, "https://example.com/feed.xml");
  expect(items.map((item) => item.externalId)).toEqual(["guid-1", "guid-2"]);
});

it("blocks private network targets by default", async () => {
  await expect(fetchReadableUrl("http://127.0.0.1/admin", testFetch))
    .rejects.toMatchObject({ code: "ssrf-blocked" });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/source-web/test`  
Expected: FAIL because Web adapters are missing.

- [ ] **Step 3: Implement the Web target router**

Use Crawlee/Cheerio for HTTP fetching, Readability/JSDOM for main content,
feedsmith for RSS/Atom, and SearXNG's JSON API for discovery. Search results
retain query/rank metadata before URL extraction. Respect redirects, content
size/time limits, ETag/Last-Modified checkpoints, robots policy, and DNS/IP SSRF
checks. Make Playwright fallback opt-in and isolated behind a lazy import.

- [ ] **Step 4: Verify Web adapters**

Run: `pnpm vitest run packages/source-web/test && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/source-web
git commit -m "feat: ingest URLs feeds and web searches"
```

### Task 11: Deterministic Query Service and HTTP API

**Files:**
- Create: `packages/query/package.json`
- Create: `packages/query/tsconfig.json`
- Create: `packages/query/src/cursor.ts`
- Create: `packages/query/src/service.ts`
- Create: `packages/query/src/index.ts`
- Create: `apps/argus/package.json`
- Create: `apps/argus/tsconfig.json`
- Create: `apps/argus/src/app.ts`
- Test: `packages/query/test/service.test.ts`
- Test: `apps/argus/test/api.test.ts`

**Interfaces:**
- Consumes: `StorageRepository.queryRecords`, `Page<T>`, API token.
- Produces: `QueryService`, `encodeCursor`, `decodeCursor`, and `createArgusApp`.

- [ ] **Step 1: Write query and API tests**

```ts
it("filters by source, watch, target, time, and text with stable pagination", async () => {
  const page = await service.records({
    sources: ["telegram"],
    watchIds: ["crypto"],
    q: "listing",
    publishedAfter: "2026-07-01T00:00:00.000Z",
    limit: 20,
  });
  expect(page.items.every((record) => record.source === "telegram")).toBe(true);
  expect(page.nextCursor).toBeTypeOf("string");
});

it("requires authorization for administration and active ingestion", async () => {
  const response = await app.request("/v1/ingest/custom", { method: "POST" });
  expect(response.status).toBe(401);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/query/test apps/argus/test/api.test.ts`  
Expected: FAIL because the query service and app are missing.

- [ ] **Step 3: Implement query parsing and Hono routes**

Implement opaque base64url JSON cursors containing sort timestamp and record ID.
Validate all query input with Zod. Add record, revision, watch, target, run,
health, readiness, and authenticated custom-ingestion routes. Return a stable
JSON envelope with `data`, `page`, and `error`.

- [ ] **Step 4: Verify API behavior**

Run: `pnpm vitest run packages/query/test apps/argus/test/api.test.ts && pnpm turbo typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/query apps/argus
git commit -m "feat: expose deterministic query API"
```

### Task 12: Optional OpenRouter Summarizer

**Files:**
- Create: `packages/intelligence/package.json`
- Create: `packages/intelligence/tsconfig.json`
- Create: `packages/intelligence/src/openrouter.ts`
- Create: `packages/intelligence/src/summarizer.ts`
- Create: `packages/intelligence/src/index.ts`
- Modify: `apps/argus/src/app.ts`
- Test: `packages/intelligence/test/summarizer.test.ts`
- Test: `apps/argus/test/summaries.test.ts`

**Interfaces:**
- Consumes: records from `QueryService`, derived-artifact repository operations.
- Produces: `OpenRouterClient`, `SummaryProcessor`, `/v1/summaries` routes.

- [ ] **Step 1: Write disabled, scheduled, on-demand, and provenance tests**

```ts
it("does not call a model when intelligence is disabled", async () => {
  await expect(processor.summarize(request, { enabled: false }))
    .rejects.toMatchObject({ code: "intelligence-disabled" });
  expect(openRouter.calls).toBe(0);
});

it("stores strict structured output with complete provenance", async () => {
  const artifact = await processor.summarize(request, enabledConfig);
  expect(artifact.kind).toBe("summary");
  expect(artifact.inputRecordIds).toEqual(["record-1", "record-2"]);
  expect(artifact.metadata).toMatchObject({
    provider: "openrouter",
    promptVersion: "summary-v1",
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/intelligence/test apps/argus/test/summaries.test.ts`  
Expected: FAIL because intelligence support is missing.

- [ ] **Step 3: Implement OpenRouter and summarization**

Call `https://openrouter.ai/api/v1/chat/completions` with strict JSON Schema,
`provider.require_parameters: true`, configurable model fallbacks, and configured
data collection/ZDR preferences. Validate returned JSON before storing a derived
artifact with sources, record IDs, model/provider, prompt version, tokens, cost,
and time window. Implement scheduled processor jobs through the existing jobs
table and authenticated on-demand API routes.

- [ ] **Step 4: Verify optional intelligence**

Run: `pnpm vitest run packages/intelligence/test apps/argus/test/summaries.test.ts && pnpm turbo typecheck`  
Expected: PASS, including an app instance with intelligence absent.

- [ ] **Step 5: Commit**

```bash
git add packages/intelligence apps/argus/src/app.ts apps/argus/test/summaries.test.ts
git commit -m "feat: add optional OpenRouter summaries"
```

### Task 13: CLI and Role-Selectable Runtime

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/main.ts`
- Create: `apps/argus/src/runtime.ts`
- Create: `apps/argus/src/main.ts`
- Create: `apps/argus/src/registry.ts`
- Test: `apps/cli/test/cli.test.ts`
- Test: `apps/argus/test/runtime.test.ts`

**Interfaces:**
- Consumes: config loading/reconciliation, storage factories, adapter registry,
  scheduler, worker, processor, Hono app.
- Produces: `argus config validate`, `argus config apply`, `argus migrate`,
  `argus run`, `argus backfill`, and runtime roles.

- [ ] **Step 1: Write CLI and lifecycle tests**

```ts
it("validates without writing and applies only after complete validation", async () => {
  expect(await runCli(["config", "validate", "--config", validPath])).toBe(0);
  expect(repo.applyCalls).toBe(0);
  expect(await runCli(["config", "apply", "--config", validPath])).toBe(0);
  expect(repo.applyCalls).toBe(1);
});

it.each([
  ["all", ["api", "scheduler", "worker", "processor"]],
  ["api", ["api"]],
  ["scheduler", ["scheduler"]],
  ["worker", ["worker"]],
  ["processor", ["processor"]],
])("starts only the %s role components", async (role, expected) => {
  expect(await startRuntime(testDependencies(role))).toEqual(expected);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run apps/cli/test apps/argus/test/runtime.test.ts`  
Expected: FAIL because entrypoints are missing.

- [ ] **Step 3: Implement composition roots and graceful shutdown**

Create storage from applied configuration, register enabled source adapters,
start only selected role loops, expose API readiness only after migrations and
configuration loading, and stop HTTP/listeners/leases on SIGTERM. Use Pino JSON
logs with correlation fields and redaction.

- [ ] **Step 4: Verify the complete runtime**

Run: `pnpm vitest run apps/cli/test apps/argus/test/runtime.test.ts && pnpm turbo typecheck build`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli apps/argus/src/runtime.ts apps/argus/src/main.ts apps/argus/src/registry.ts apps/argus/test/runtime.test.ts
git commit -m "feat: add CLI and role-selectable runtime"
```

### Task 14: Deployment, Documentation, and End-to-End Verification

**Files:**
- Create: `deploy/docker/Dockerfile`
- Create: `deploy/docker/compose.yaml`
- Create: `deploy/docker/entrypoint.sh`
- Create: `deploy/railway/api.toml`
- Create: `deploy/railway/scheduler.toml`
- Create: `deploy/railway/worker.toml`
- Create: `deploy/railway/processor.toml`
- Create: `README.md`
- Create: `docs/operations.md`
- Create: `test/e2e/ingestion.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: built apps, configuration, PostgreSQL, FxEmbed endpoint, SearXNG endpoint.
- Produces: one production image, single-host stack, Railway role templates, CI.

- [ ] **Step 1: Write the end-to-end test**

```ts
it("applies config, runs all three source families, and queries stored records", async () => {
  await harness.applyConfig(trinityFixture);
  await harness.runDueJobs();
  const response = await harness.api.get("/v1/records?limit=100");
  expect(response.status).toBe(200);
  expect(new Set(response.body.data.map((record) => record.source)))
    .toEqual(new Set(["x", "telegram", "web"]));
  expect(response.body.data.every((record) => record.raw !== undefined)).toBe(true);
});
```

- [ ] **Step 2: Verify failure before deployment assets exist**

Run: `pnpm vitest run test/e2e/ingestion.test.ts`  
Expected: FAIL because the complete harness and production composition are absent.

- [ ] **Step 3: Implement production assets and operator documentation**

Build on `node:24-alpine`, install with the pinned pnpm version, run as a
non-root user, include health checks, and use SIGTERM-aware entrypoints. Compose
PostgreSQL, Argus, SearXNG, and a pinned FxEmbed checkout/service with persistent
volumes. Document SQLite mode, PostgreSQL mode, secrets, first config apply,
backfills, upgrades, backups, failed-job recovery, and live-source caveats.

CI runs formatting checks, lint, typecheck, unit tests, PostgreSQL integration
tests, build, and the fixture-driven end-to-end test.

- [ ] **Step 4: Run the completion verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm turbo lint typecheck test build
docker compose -f deploy/docker/compose.yaml config
docker build -f deploy/docker/Dockerfile -t argus:v1 .
pnpm vitest run test/e2e/ingestion.test.ts
```

Expected: every command exits 0. The image health endpoint becomes ready with
the example configuration, and the E2E test returns records from X, Telegram,
and Web fixtures.

- [ ] **Step 5: Commit**

```bash
git add deploy README.md docs/operations.md test/e2e .github/workflows/ci.yml
git commit -m "feat: ship Argus v1 deployment and operations"
```

---

## Completion Audit

Before publishing:

1. Map every acceptance criterion in the design spec to a passing test or
   deployment command above.
2. Run the full root verification from a clean install.
3. Run one opt-in live smoke for FxEmbed, a public Telegram announcement
   channel, an ordinary URL, an RSS feed, and SearXNG.
4. Confirm intelligence-disabled startup requires no OpenRouter secret.
5. Confirm logs and API responses contain no configured secret values.
6. Confirm SQLite rejects split roles and PostgreSQL successfully runs separate
   API, scheduler, and worker processes.
7. Create a private GitHub repository, push `main`, and confirm CI begins.
