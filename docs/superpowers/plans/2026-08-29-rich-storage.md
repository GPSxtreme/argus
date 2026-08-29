# Rich Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated handwritten persistence with a breaking schema-version-2 Drizzle model that stores canonical records, watch observations, media, relations, engagement, conversations, and normalized artifact provenance identically in SQLite and PostgreSQL.

**Architecture:** Dialect-specific Drizzle schemas retain the existing `better-sqlite3` and `pg` drivers behind one expanded `StorageRepository`. A shared contract suite proves observable parity. Version-1 databases are rejected before mutation; checked-in version-2 initialization migrations support only empty databases.

**Tech Stack:** TypeScript 6, Drizzle ORM, Drizzle Kit, better-sqlite3, node-postgres, Vitest, Testcontainers PostgreSQL

**Spec:** `docs/superpowers/specs/2026-08-29-rich-records-and-context-pipelines-design.md`

## Global Constraints

- This is configuration version `2` and database schema version `2`; do not add a version-1 compatibility or migration path.
- Canonical identity is SHA-256 of `<source>\0<externalId>` and never includes a watch or target.
- Media records contain pointers and metadata only; never persist media bytes.
- Engagement changes do not create content revisions.
- SQLite and PostgreSQL must satisfy the same behavioral contract.

---

### Task 1: Rich domain and repository contracts

**Files:**
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/storage.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/engine/src/normalize.ts`
- Test: `packages/engine/test/ingest.test.ts`

**Interfaces:**
- Produces: `SourceMedia`, `SourceRelation`, `Engagement`, `RecordWatch`, `MediaAsset`, `RecordRelation`, `EngagementSnapshot`, `ConversationTracking`, `ConversationSnapshot`, `ConversationSnapshotItem`, `RecordDetail`.
- Produces: `recordIdentity(source, externalId): string` and a `StorageRepository` contract with rich commit/query and conversation methods.

- [ ] **Step 1: Write failing identity and normalization tests**

```ts
it("uses one canonical identity across targets", () => {
  expect(recordIdentity("x", "42")).toBe(recordIdentity("x", "42"));
  expect(normalizeItem(firstTarget).id).toBe(normalizeItem(secondTarget).id);
});

it("accepts a media-only source item", () => {
  expect(normalizeItem({ ...input, item: { ...item, text: "", media: [image] } }).media)
    .toEqual([expect.objectContaining({ kind: "image" })]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run packages/contracts/test/contracts.test.ts packages/engine/test/ingest.test.ts`

Expected: FAIL because `recordIdentity` and rich fields do not exist and identity still includes `targetId`.

- [ ] **Step 3: Add the exact approved domain types and repository signatures**

```ts
export const recordIdentity = (source: SourceName, externalId: string): string =>
  createHash("sha256").update(`${source}\0${externalId}`).digest("hex");

export interface SourceMedia {
  sourceMediaId?: string;
  kind: "image" | "video" | "audio" | "document";
  url: string;
  previewUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  metadata?: Record<string, unknown>;
}
```

Add the remaining fields and constraints exactly as specified. Split `IngestionCommitResult` from an internal `IngestItemsResult` so record bodies never leak into logs. Add repository methods `getRecord`, `queryConversationSnapshots`, `upsertConversationTracking`, `listDueConversationTracking`, and `saveConversationSnapshot` with fully typed inputs.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run packages/contracts/test/contracts.test.ts packages/engine/test/ingest.test.ts && pnpm --filter @argus/contracts --filter @argus/engine typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/engine
git commit -m "feat: define rich record contracts"
```

### Task 2: SQLite Drizzle schema and initialization gate

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/storage-sqlite/package.json`
- Replace: `packages/storage-sqlite/src/schema.ts`
- Replace: `packages/storage-sqlite/src/db.ts`
- Create: `packages/storage-sqlite/drizzle.config.ts`
- Create: `packages/storage-sqlite/drizzle/0000_schema_v2.sql`
- Test: `packages/storage-sqlite/test/schema.test.ts`

**Interfaces:**
- Produces: exported SQLite Drizzle tables named after every approved table.
- Produces: `openSqlite(filename): { database: Database.Database; orm: BetterSQLite3Database }` after a strict schema-version check.

- [ ] **Step 1: Write failing empty/v1/v2 schema tests**

```ts
it("initializes an empty database at schema version 2", () => {
  const { database } = openSqlite(temporaryDatabase());
  expect(database.prepare("select version from schema_meta where id=1").pluck().get()).toBe(2);
});

it("rejects a version 1 database before mutation", () => {
  const filename = versionOneFixture();
  expect(() => openSqlite(filename)).toThrow(/schema version 1.*reset.*re-onboard/iu);
  expect(readTableNames(filename)).toEqual(["records"]);
});
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm vitest run packages/storage-sqlite/test/schema.test.ts`

Expected: FAIL because schema metadata and Drizzle initialization do not exist.

- [ ] **Step 3: Add Drizzle and the exact schema-v2 initialization migration**

Add `drizzle-orm` to the storage package and `drizzle-kit` to root development dependencies. Define tables with `sqliteTable`, foreign keys, unique constraints, and indexes from the spec. The opening algorithm is exactly:

```ts
const version = readSchemaVersion(database);
if (version === 1) throw incompatibleSchema(1);
if (version !== undefined && version !== 2) throw incompatibleSchema(version);
if (version === undefined && hasUserTables(database)) throw incompatibleSchema("unversioned");
if (version === undefined) applyInitializationMigration(database, migrationSql);
return { database, orm: drizzle(database, { schema }) };
```

The SQL migration creates all approved tables and inserts `(1, 2, CURRENT_TIMESTAMP)` into `schema_meta` in one transaction.

- [ ] **Step 4: Run schema tests and generate a Drizzle consistency check**

Run: `pnpm drizzle-kit check --config packages/storage-sqlite/drizzle.config.ts && pnpm vitest run packages/storage-sqlite/test/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml packages/storage-sqlite
git commit -m "feat: add sqlite rich schema"
```

### Task 3: SQLite rich repository

**Files:**
- Replace: `packages/storage-sqlite/src/repo.ts`
- Modify: `packages/storage-sqlite/src/index.ts`
- Replace: `packages/storage-sqlite/test/repository.test.ts`
- Create: `test/support/storage-contract.ts`

**Interfaces:**
- Consumes: rich `StorageRepository` and SQLite Drizzle tables.
- Produces: `SqliteRepository` satisfying the shared storage contract.

- [ ] **Step 1: Write the shared contract with literal rich fixtures**

```ts
export const storageContract = (factory: RepositoryFactory): void => {
  it("stores one record observed by two watches", async () => {
    const repository = await factory();
    await repository.commitIngestion(firstObservation);
    await repository.commitIngestion(secondObservation);
    const result = await repository.getRecord(firstObservation.records[0].id);
    expect(result?.watches.map(({ watchId }) => watchId).sort()).toEqual(["alerts", "markets"]);
  });
};
```

Cover atomic rich commits, relation resolution, unchanged engagement, changed engagement, revisions, media order, conversation tracking/snapshots, artifact joins, filters, cursors, jobs, diagnostics, and applied config.

- [ ] **Step 2: Run the SQLite repository test and verify RED**

Run: `pnpm vitest run packages/storage-sqlite/test/repository.test.ts`

Expected: FAIL on the first rich contract method.

- [ ] **Step 3: Implement the repository through Drizzle transactions**

Use `db.transaction` for `commitIngestion` and `saveConversationSnapshot`. On a duplicate content hash, still upsert `record_watches`, update `last_seen_at`, reconcile relation targets, and append an engagement snapshot only when counters changed. All query inputs remain parameterized through Drizzle expressions.

```ts
const existing = transaction.select().from(records).where(eq(records.id, record.id)).get();
transaction.insert(recordWatches).values(observation).onConflictDoUpdate({
  target: [recordWatches.recordId, recordWatches.watchId, recordWatches.targetId],
  set: { lastSeenAt: observation.lastSeenAt },
}).run();
```

- [ ] **Step 4: Run SQLite contract, typecheck, and lint**

Run: `pnpm vitest run packages/storage-sqlite/test/schema.test.ts packages/storage-sqlite/test/repository.test.ts && pnpm --filter @argus/storage-sqlite typecheck && pnpm lint`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add test/support/storage-contract.ts packages/storage-sqlite
git commit -m "feat: persist rich records in sqlite"
```

### Task 4: PostgreSQL Drizzle parity

**Files:**
- Modify: `packages/storage-postgres/package.json`
- Replace: `packages/storage-postgres/src/schema.ts`
- Replace: `packages/storage-postgres/src/repo.ts`
- Modify: `packages/storage-postgres/src/index.ts`
- Create: `packages/storage-postgres/drizzle.config.ts`
- Create: `packages/storage-postgres/drizzle/0000_schema_v2.sql`
- Replace: `packages/storage-postgres/test/repository.test.ts`

**Interfaces:**
- Consumes: shared storage contract.
- Produces: `PostgresRepository` with behavior equal to SQLite.

- [ ] **Step 1: Make PostgreSQL execute the shared contract in the existing required CI PostgreSQL job**

Replace the package-specific behavior cases with `storageContract`. Preserve the existing CI service and `TEST_DATABASE_URL`; retain `ARGUS_POSTGRES_TEST=1` only as the local Testcontainers opt-in.

- [ ] **Step 2: Run the contract and verify RED**

Run: `ARGUS_POSTGRES_TEST=1 pnpm vitest run packages/storage-postgres/test/repository.test.ts`

Expected: FAIL because the PostgreSQL v2 schema and rich methods do not exist.

- [ ] **Step 3: Implement PostgreSQL schema, migration gate, and repository**

Use `drizzle-orm/node-postgres`, `pgTable`, `jsonb`, and `timestamp({ withTimezone: true, mode: "string" })`. Lock the canonical record with `SELECT ... FOR UPDATE` inside rich commits where concurrent upserts require serialization. Use the same mapping functions and return shapes as SQLite.

```ts
await client.query("BEGIN");
await client.query("SELECT id FROM records WHERE id=$1 FOR UPDATE", [record.id]);
const tx = drizzle(client, { schema });
// Apply the same rich commit decisions as the shared contract.
await client.query("COMMIT");
```

- [ ] **Step 4: Run PostgreSQL and SQLite contracts together**

Run: `ARGUS_POSTGRES_TEST=1 pnpm vitest run packages/storage-sqlite/test/repository.test.ts packages/storage-postgres/test/repository.test.ts`

Expected: both adapters PASS the same behaviors.

- [ ] **Step 5: Commit**

```bash
git add packages/storage-postgres
git commit -m "feat: add postgres rich storage parity"
```

### Task 5: Runtime, API, and container migration integration

**Files:**
- Modify: `apps/argus/src/repository.ts`
- Modify: `apps/argus/src/app.ts`
- Modify: `apps/argus/test/app.test.ts`
- Modify: `apps/argus/test/repository.test.ts`
- Modify: `packages/query/src/service.ts`
- Modify: `packages/query/test/service.test.ts`
- Modify: `deploy/docker/Dockerfile`
- Test: `test/e2e/ingestion.test.ts`

**Interfaces:**
- Produces: rich `GET /v1/records`, `GET /v1/records/:recordId`, and `GET /v1/records/:recordId/conversation` responses.

- [ ] **Step 1: Write failing API and bundle tests**

```ts
expect((await app.request("/v1/records/<id>", authorized)).json()).resolves.toMatchObject({
  media: [{ kind: "image", url: "https://cdn.example/chart.png" }],
  relations: [],
  watches: [{ watchId: "markets" }],
});
```

Add a container-source test that proves both migration directories are copied into `/app/migrations/{sqlite,postgres}`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run apps/argus/test/app.test.ts apps/argus/test/repository.test.ts test/e2e/ingestion.test.ts`

Expected: FAIL on missing detail/conversation routes and migration assets.

- [ ] **Step 3: Wire rich query routes and runtime migration paths**

Add route constants and handlers with strict 64-character record IDs. Return `404` for missing records and preserve bounded cursor validation for conversations. Copy checked-in migrations in the Docker build and set explicit runtime paths consumed by storage initialization.

- [ ] **Step 4: Run phase verification**

Run: `pnpm test && pnpm typecheck && pnpm build && pnpm lint`

Expected: all non-opt-in tests PASS, builds exit `0`, and lint emits no warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/argus packages/query deploy/docker test/e2e
git commit -m "feat: expose rich record storage"
```
