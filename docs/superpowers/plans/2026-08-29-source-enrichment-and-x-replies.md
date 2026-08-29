# Source Enrichment and X Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize source media and relationships, accept media-only records, and automatically maintain bounded provenance-rich X conversation snapshots.

**Architecture:** Each adapter translates source payloads into the rich contract. Pure reply scheduling and selection modules decide when and what to retain. Dynamic conversation jobs reuse the existing leased job queue and call a dedicated FxTwitter conversation client path.

**Tech Stack:** TypeScript, Cheerio, JSDOM/Readability, fast-xml-parser, Croner, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-rich-records-and-context-pipelines-design.md`

## Global Constraints

- Store only media pointers and metadata.
- Telegram discussions and generic website comments remain out of scope.
- Automatic X reply collection is opt-in and bounded to 500 observed replies per refresh.
- Reply selection language must say "observed" and preserve completeness metadata.

---

### Task 1: X rich payload normalization

**Files:**
- Create: `packages/source-x/src/normalize.ts`
- Modify: `packages/source-x/src/client.ts`
- Modify: `packages/source-x/src/index.ts`
- Replace: `packages/source-x/test/client.test.ts`
- Create: `packages/source-x/test/fixtures/status-rich.json`

**Interfaces:**
- Produces: `normalizeXStatus(status): SourceItem | undefined`.
- Produces: `FxEmbedClient.conversation(id, cursor?): Promise<XConversationPage>`.

- [ ] **Step 1: Write failing fixture tests** covering a text-empty chart image, mixed image/video media, quote, reply parent, repost, and every engagement counter.
- [ ] **Step 2: Run `pnpm vitest run packages/source-x/test/client.test.ts` and verify failures name missing media/relations.**
- [ ] **Step 3: Implement strict structural parsing without unsafe casts.**

```ts
return {
  externalId: id,
  url: canonicalStatusUrl(author, id),
  text: stringValue(status.text) ?? "",
  media: normalizeXMedia(status.media),
  relations: normalizeXRelations(status),
  engagement: normalizeEngagement(status),
  raw: status,
};
```

Reject only when ID is absent or both text and normalized media are empty. Parse `/2/conversation/{id}` responses into root, thread, replies, author, and cursor without treating tombstones as records.

- [ ] **Step 4: Run the test and package typecheck; expect PASS.**
- [ ] **Step 5: Commit with `git commit -m "feat: normalize rich x records"`.**

### Task 2: Telegram and Web media pointers

**Files:**
- Modify: `packages/source-telegram/src/parse.ts`
- Replace: `packages/source-telegram/test/parse.test.ts`
- Modify: `packages/source-web/src/url.ts`
- Modify: `packages/source-web/src/feed.ts`
- Replace: `packages/source-web/test/web.test.ts`

**Interfaces:**
- Produces media-only Telegram records and ordered page/feed media arrays.

- [ ] **Step 1: Add literal HTML/XML fixtures** for Telegram photo, video poster, audio, document, page Open Graph/Twitter image, HTML media, relative URLs, RSS enclosure, and Atom media content.
- [ ] **Step 2: Run source tests and verify RED on absent media and discarded media-only Telegram posts.**
- [ ] **Step 3: Implement extraction with URL resolution against the final page/feed URL.**

```ts
const absolute = (value: string, base: string): string | undefined => {
  const resolved = new URL(value, base);
  return resolved.protocol === "https:" || resolved.protocol === "http:"
    ? resolved.href
    : undefined;
};
```

Deduplicate media by `(kind,url)` while retaining first source position. Never fetch a pointer merely to validate it.

- [ ] **Step 4: Run `pnpm vitest run packages/source-telegram packages/source-web`; expect PASS.**
- [ ] **Step 5: Commit with `git commit -m "feat: collect source media pointers"`.**

### Task 3: Reply cadence and deterministic selection

**Files:**
- Create: `packages/scheduler/src/replies.ts`
- Modify: `packages/scheduler/src/index.ts`
- Create: `packages/scheduler/test/replies.test.ts`

**Interfaces:**
- Produces: `nextReplyRun(input): string | undefined`.
- Produces: `selectObservedReplies(items, orderBy, limit): SelectedReply[]`.

- [ ] **Step 1: Write failing table-driven cadence tests** for ages 0, 1h, 6h, 24h, 72h, horizon, old discovery, growth burst, and one-time rediscovery.
- [ ] **Step 2: Write failing selection tests** for all seven order modes, missing metrics, ties, deduplication, and a 50-of-500 cap.
- [ ] **Step 3: Run `pnpm vitest run packages/scheduler/test/replies.test.ts`; verify RED.**
- [ ] **Step 4: Implement pure functions with literal cadence boundaries.**

```ts
const intervalMs = ageMs < HOUR ? 15 * MINUTE
  : ageMs < 6 * HOUR ? HOUR
  : ageMs < 24 * HOUR ? 6 * HOUR
  : ageMs < 72 * HOUR ? 24 * HOUR
  : 72 * HOUR;
return new Date(Math.min(now + intervalMs, stopsAt)).toISOString();
```

Metric modes sort descending, `newest` descending, `oldest` ascending, and `source` by first observed position. Every tie uses publication timestamp then external ID.

- [ ] **Step 5: Run tests/typecheck and commit `feat: schedule bounded x replies`.**

### Task 4: Conversation tracking orchestration

**Files:**
- Modify: `packages/engine/src/ingest.ts`
- Modify: `packages/engine/test/ingest.test.ts`
- Modify: `packages/scheduler/src/scheduler.ts`
- Modify: `packages/scheduler/test/scheduler.test.ts`
- Modify: `apps/argus/src/worker.ts`
- Modify: `apps/argus/src/runtime.ts`
- Create: `apps/argus/src/conversations.ts`
- Create: `apps/argus/test/conversations.test.ts`
- Modify: `apps/argus/test/runtime-jobs.test.ts`

**Interfaces:**
- Produces dynamic target IDs `__argus_x_conversation:<64-char-record-id>`.
- Produces `runConversationRefresh(tracking, client, repository, now): Promise<IngestionCommitResult>`.

- [ ] **Step 1: Write failing orchestration tests** proving root success is independent, due tracking enqueues once, pagination stops at 500, partial pages persist, and final snapshot marks tracking complete.
- [ ] **Step 2: Run focused engine/scheduler/runtime tests and verify RED.**
- [ ] **Step 3: Make `ingestItems` return committed records separately from log counters**, then upsert tracking only for configured X account/query roots.
- [ ] **Step 4: Implement dynamic conversation job execution.**

```ts
if (job.targetId.startsWith("__argus_x_conversation:")) {
  return runConversationRefresh(
    await repository.getConversationTracking(recordIdFrom(job.targetId)),
    adapters.x,
    repository,
    now,
  );
}
```

Persist replies through the normal rich ingestion transaction, then save the conversation snapshot and next tracking state. Do not recursively schedule automatic tracking for reply records.

- [ ] **Step 5: Run focused tests and commit `feat: track x conversations`.**

### Task 5: Reply config and API representation

**Files:**
- Modify: `packages/config/src/schema.ts`
- Modify: `packages/config/test/load.test.ts`
- Modify: `apps/argus/src/app.ts`
- Modify: `apps/argus/test/app.test.ts`
- Modify: `apps/argus/src/worker.ts`

**Interfaces:**
- Produces strict `sources.x.replies` configuration and conversation API responses.

- [ ] **Step 1: Write failing config tests** for defaults, invalid ranges, invalid order, and replies enabled while X is disabled.
- [ ] **Step 2: Write failing API tests** for latest/historical conversation snapshots, ranked replies, partial provenance, `404`, and cursor errors.
- [ ] **Step 3: Run focused tests and verify RED.**
- [ ] **Step 4: Implement strict schema and handlers** exactly matching the spec; hand-authored reply tracking defaults to disabled.
- [ ] **Step 5: Run `pnpm test && pnpm typecheck && pnpm build && pnpm lint`; commit `feat: expose x conversation context`.**

