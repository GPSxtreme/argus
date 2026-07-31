# Argus V1 Design

**Date:** 2026-07-31  
**Status:** Approved for implementation

## 1. Product Definition

Argus is a self-hosted, TypeScript-first data layer for collecting, normalizing,
storing, and deterministically querying public information. It watches three
source families:

- X accounts and X search queries
- Public Telegram announcement channels
- Web pages, RSS/Atom feeds, and web search queries

Argus can ingest passively through schedules or actively through authenticated
submission endpoints. Its core does not require an LLM, embedding model, or
hosted AI service.

An optional intelligence layer can create summaries and other derived artifacts
using OpenRouter. Downstream projects may ignore this layer and use Argus solely
as their data infrastructure.

V1 is a private experimental product. Public framework APIs and dynamic plugins
are intentionally deferred until real usage establishes stable abstractions.

## 2. V1 Goals

1. Configure sources, watches, schedules, and processors in a validated YAML
   file.
2. Atomically apply configuration changes without restarting the runtime.
3. Ingest from the X, Telegram, and Web source families.
4. Preserve raw source payloads and normalized source-neutral records.
5. Deduplicate repeated polling and retain revisions when upstream content
   changes.
6. Store data in SQLite for simple single-process deployments or PostgreSQL for
   multi-role deployments.
7. Provide deterministic filtering, full-text search, pagination, and record
   retrieval.
8. Expose durable ingestion events for processors and external consumers.
9. Optionally produce scheduled or on-demand summaries through OpenRouter.
10. Run as one service on a VPS or as split roles on platforms such as Railway.
11. Ship Docker and Railway deployment assets and include a self-hosted
    FxEmbed deployment path.

## 3. Non-Goals

- A polished end-user dashboard
- A stable third-party plugin ABI
- Anonymous monitoring of Telegram discussion groups
- Private Telegram content
- CAPTCHA bypassing, proxy evasion, or authenticated web scraping
- Mandatory embeddings, semantic search, or LLM-based querying
- Distributed infrastructure such as Kafka or Redis in V1
- Binary media archival by default

## 4. Repository Architecture

Argus is a pnpm workspace orchestrated by Turborepo.

```text
argus/
  apps/
    argus/                 HTTP API and role-selectable runtime
    cli/                   configuration and operational commands
  packages/
    contracts/             canonical types and adapter contracts
    config/                YAML parsing, validation, reconciliation
    engine/                ingestion orchestration
    scheduler/             jobs, leases, retries, checkpoints
    query/                 deterministic query service
    source-x/              FxEmbed integration
    source-telegram/       public Telegram channel integration
    source-web/            URL, feed, search, and crawl integration
    storage-sqlite/        SQLite implementation
    storage-postgres/      PostgreSQL implementation
    intelligence/          optional processors and OpenRouter
    sdk/                   internal programmatic client
  tooling/
  deploy/
```

These are compile-time package boundaries, not independently versioned
microservices. Turborepo manages development tasks but is not used at runtime.

The runtime supports five roles:

```text
all | api | scheduler | worker | processor
```

- `all` runs all enabled capabilities in one process.
- Split roles run the same image and coordinate through PostgreSQL.
- SQLite is supported only with the `all` role.
- PostgreSQL is required for split roles or multiple replicas.
- The `processor` role is optional.

## 5. Configuration

The default configuration file is `argus.config.yaml`. An alternate path can be
provided with `--config`.

The configuration contains:

- storage selection and connection settings
- enabled source adapters and their non-secret settings
- named watches
- source targets
- cron schedules
- deterministic classification rules
- retention settings
- optional intelligence processors

Secrets are referenced from environment variables and are never embedded in the
configuration.

```yaml
version: 1

storage:
  adapter: sqlite
  url: ./data/argus.db

sources:
  x:
    enabled: true
    endpoint: http://fxembed:8787
  telegram:
    enabled: true
    adapter: public-web
  web:
    enabled: true
    searchEndpoint: http://searxng:8080

watches:
  - id: crypto-markets
    enabled: true
    schedule: "*/5 * * * *"
    inputs:
      x:
        accounts: [solana, ethereum]
        queries: ["$SOL", "$ETH"]
      telegram:
        channels: [solana_announcements]
      web:
        urls: [https://example.com/news]
        feeds: [https://example.com/rss.xml]
        queries: ["Solana ecosystem news"]
    classify:
      keywords: [SOL, ETH, listing, exploit]

intelligence:
  enabled: false
```

`argus config validate` validates syntax, references, schedules, adapter
capabilities, and deployment constraints without modifying runtime state.

`argus config apply` validates the complete file and then atomically reconciles
the desired configuration with persisted watches, targets, schedules, and
processors. A failed validation or reconciliation leaves the previous applied
configuration active.

## 6. Canonical Data Model

Each adapter emits a source item that normalizes into this conceptual envelope:

```ts
type RecordEnvelope = {
  id: string;
  source: "x" | "telegram" | "web" | "custom";
  kind: string;
  targetId: string;
  externalId: string;
  canonicalUrl: string | null;
  author: {
    id?: string;
    handle?: string;
    name?: string;
  };
  content: {
    text: string;
    title?: string;
    language?: string;
  };
  publishedAt: string;
  ingestedAt: string;
  contentHash: string;
  revision: number;
  relations: {
    replyTo?: string;
    quoteOf?: string;
    repostOf?: string;
  };
  media: Array<{
    type: string;
    url: string;
    metadata?: Record<string, unknown>;
  }>;
  metadata: Record<string, unknown>;
  raw: unknown;
};
```

The persistence model includes:

- applied configurations
- watches
- targets
- jobs
- runs and attempts
- checkpoints
- records
- record revisions
- watch matches
- derived artifacts
- outbox events
- leases

The source identity `(source, target_id, external_id)` is unique. Repeated
content hashes are ignored. Changed hashes create a new immutable revision and
update the current record projection.

Raw source payloads are preserved. Media URLs and metadata are stored, but
binary downloads are opt-in.

## 7. Ingestion Flow

```text
config apply
  -> reconcile watches and targets
  -> scheduler creates due jobs
  -> worker claims a job lease
  -> adapter fetches or receives source items
  -> raw payload is preserved
  -> item is normalized
  -> record is inserted, deduplicated, or revised
  -> deterministic rules classify the record
  -> durable outbox event is committed
  -> checkpoint advances after the transaction succeeds
  -> optional processors consume the event
```

Delivery is at least once. Idempotent writes make retries safe. Checkpoints never
advance past data that failed to commit.

Active ingestion uses the same pipeline through an authenticated endpoint:

```text
POST /v1/ingest/:source
```

This endpoint supports custom collectors and future webhook or streaming
adapters without bypassing normalization and deduplication.

## 8. Source Adapters

### 8.1 Adapter Contract

Every adapter declares capabilities and implements validation plus pull
ingestion. Streaming adapters may additionally implement subscription.

```ts
interface SourceAdapter<TConfig, TCheckpoint> {
  capabilities: {
    pull: boolean;
    subscribe: boolean;
    backfill: boolean;
  };
  validate(config: TConfig): Promise<ValidationResult>;
  pull(input: PullInput<TConfig, TCheckpoint>): AsyncIterable<SourceItem>;
  subscribe?(
    input: SubscriptionInput<TConfig>,
    emit: (item: SourceItem) => Promise<void>
  ): Promise<void>;
}
```

Adapters do not depend on a storage implementation or intelligence provider.

### 8.2 X

The X adapter calls a configurable FxEmbed API endpoint.

V1 supports:

- account timelines
- search queries
- timestamp-based incremental polling
- cursor-based backfill
- posts, authors, metrics, quotes, replies, reposts, and media

FxEmbed credentials remain inside FxEmbed. Argus stores only the FxEmbed
endpoint and ingestion checkpoints.

### 8.3 Telegram

V1 monitors public announcement channels anonymously using Telegram's public
web preview.

V1 supports:

- `https://t.me/s/<username>` polling
- post-ID backfill pagination
- new-post detection
- recent edit detection
- text, timestamps, views, forwards, links, and available media

Targets without a usable public preview are marked `preview-unavailable`.
Telegram bots, MTProto user sessions, private channels, and discussion groups
are deferred.

### 8.4 Web

The Web source includes:

- URL targets: fetch and extract readable content, creating revisions only when
  content changes
- RSS/Atom targets: ingest each feed entry as an independent record
- search targets: use self-hosted SearXNG for discovery, then fetch and
  normalize the selected results

The fetch chain uses HTTP and Cheerio through Crawlee first. Playwright is an
optional fallback for JavaScript-rendered pages. V1 does not bypass access
controls.

## 9. Deterministic Processing and Querying

All configured source records are stored. Deterministic filters classify and
tag records rather than discarding them.

Core query capabilities:

- source and record kind
- watch and target
- author or channel
- published and ingestion time ranges
- keywords and tags
- full-text search
- revision history
- cursor pagination
- ascending or descending chronological order

Representative endpoints:

```text
GET  /v1/records
GET  /v1/records/:id
GET  /v1/records/:id/revisions
GET  /v1/watches
GET  /v1/watches/:id/records
GET  /v1/targets
GET  /v1/runs
GET  /v1/health
POST /v1/ingest/:source
```

SQLite FTS and PostgreSQL full-text search provide the same functional query
contract. Semantic retrieval is not part of the core query API.

## 10. Optional Intelligence Layer

Intelligence processors consume records and write immutable derived artifacts.
They never mutate or replace source records.

V1 includes an optional summarizer with:

- OpenRouter as the first provider
- scheduled summaries per watch and time window
- on-demand summaries through the API and CLI
- strict structured output when supported
- source record IDs and URLs as evidence
- model, provider, prompt version, token usage, cost, and creation timestamp
- configurable model fallbacks
- configurable data-retention routing preferences

Representative endpoints:

```text
POST /v1/summaries
GET  /v1/summaries
GET  /v1/summaries/:id
```

If intelligence is disabled or misconfigured, ingestion and querying continue
normally.

Embeddings, sentiment analysis, and model-driven retrieval use the same
processor and derived-artifact contracts but are deferred until after the V1
summarizer proves the boundary.

## 11. Storage and Coordination

Both adapters implement a shared repository contract with transactions.

SQLite:

- default for local development and simple VPS installations
- WAL mode
- single `all` runtime
- SQLite FTS for text search

PostgreSQL:

- required for split roles and multiple replicas
- row-level job claiming with expiring leases
- PostgreSQL full-text search
- durable outbox polling
- advisory or row locks for singleton reconciliation operations

V1 uses database-backed jobs and events. Redis, Kafka, and an external job queue
are not required.

## 12. Failure Handling

Adapter failures are isolated by target and classified as:

- retryable
- rate limited
- authentication required
- unsupported
- permanent

Retryable failures use bounded exponential backoff with jitter. Each run records
attempts and the latest normalized error without exposing secrets.

Expired leases make abandoned jobs claimable after worker failure. Poison jobs
move to a failed terminal state after the configured attempt limit and can be
retried manually.

Configuration application is atomic. Processor failures do not roll back
successfully stored source records. Checkpoints advance only after record,
classification, and outbox writes commit.

## 13. Observability and Security

V1 emits structured JSON logs with run, job, watch, target, and record
correlation IDs.

Metrics include:

- records fetched, inserted, revised, and deduplicated
- ingestion latency
- run success and failure counts
- retry and rate-limit counts
- queue depth and lease age
- per-source target health
- processor duration, token usage, and cost

Health endpoints distinguish liveness from readiness.

Secrets are loaded from environment variables, redacted from logs, and never
returned through configuration APIs. Active ingestion and administrative
endpoints require an API token. SSRF protections block private and local network
destinations in user-configured Web targets unless explicitly allowlisted.

## 14. Deployment

### Single VPS

Docker Compose runs:

- Argus in `all` mode
- PostgreSQL or a persisted SQLite volume
- self-hosted FxEmbed
- self-hosted SearXNG
- an optional Playwright worker

### Railway

The same Argus image is deployed with separate `api`, `scheduler`, `worker`, and
optional `processor` roles. All roles share PostgreSQL. FxEmbed and SearXNG use
separate services or externally reachable self-hosted endpoints.

Deployment templates document required secrets, persistent volumes, health
checks, migrations, and upgrade order.

## 15. Testing

Testing layers:

1. Contract tests for every source and storage adapter
2. Fixture-based normalization tests for X, Telegram, HTML, RSS, and SearXNG
3. Storage integration suites run against both SQLite and PostgreSQL
4. Scheduler tests with a controllable clock
5. Idempotency, retry, lease-expiry, and checkpoint tests
6. API tests for filtering, pagination, active ingestion, and summaries
7. Docker Compose smoke tests covering a complete scheduled ingestion flow

External-source tests use recorded fixtures by default. A separately invoked
live smoke suite validates current upstream compatibility without making the
normal test suite flaky.

## 16. V1 Acceptance Criteria

V1 is complete when:

1. A fresh checkout installs and passes lint, typecheck, unit, integration, and
   build tasks.
2. `argus config validate` reports useful errors for invalid configuration.
3. `argus config apply` atomically creates and updates watches, targets, and
   schedules.
4. X account and search targets ingest through a configurable FxEmbed endpoint.
5. public Telegram announcement channels ingest anonymously with checkpointed
   polling and backfill.
6. URL, RSS/Atom, and SearXNG search targets ingest into canonical records.
7. repeated jobs are idempotent and upstream edits create revisions.
8. SQLite and PostgreSQL both pass the shared storage contract suite.
9. deterministic query APIs support documented filters, text search, and
   pagination.
10. active ingestion enters the same normalized pipeline.
11. optional scheduled and on-demand OpenRouter summaries produce attributable
    derived artifacts.
12. the documented Docker Compose deployment works on one host.
13. role-separated PostgreSQL deployment starts successfully using the Railway
    configuration.
14. all V1 behavior is documented with an example configuration and operational
    guide.

