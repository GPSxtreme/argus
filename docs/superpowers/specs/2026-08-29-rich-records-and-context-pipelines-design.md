# Argus Rich Records and Context Pipelines Design

## Status

Approved in conversation on 2026-08-29. This specification defines the breaking Argus `0.2.0` data model and the first complete context-pipelining surface.

## Goal

Make Argus preserve the evidence that gives collected text meaning: media pointers, relationships, engagement history, and bounded X reply context. Agents must also be able to traverse the raw read primitives Argus already depends on without causing persistent ingestion.

## Delivery boundaries

The work ships in four dependency-ordered phases. Every phase leaves the repository in a working, testable state.

1. Replace duplicated handwritten persistence with a Drizzle-backed rich-record model for SQLite and PostgreSQL.
2. Enrich X, Telegram, and Web ingestion, including scheduled X reply tracking.
3. Add an authenticated, transient primitive gateway for FxTwitter and SearXNG.
4. Add multimodal OpenRouter inputs, onboarding UX, handbook coverage, and the `argus-research` Agent Skill.

Telegram discussion groups, generic website comments, media file downloads, object storage, arbitrary upstream write operations, and MCP are not part of `0.2.0`.

## Breaking release policy

Argus `0.2.0` uses configuration version `2` and database schema version `2`. It does not read or migrate version `1` configuration or databases.

New databases are initialized from checked-in Drizzle migrations. When Argus finds a version `1` database, startup fails before mutation with an error that identifies the incompatible schema and tells the operator to reset and re-onboard. There is no compatibility mapper, dual-read path, or data migration.

The prudhvi-laptop VPS was deliberately wiped before this work. Its fresh installation is the final operator acceptance test after a signed release exists.

## Persistence architecture

### Drizzle

`drizzle-orm` becomes the query and schema layer. SQLite continues to use `better-sqlite3`; PostgreSQL continues to use `pg`. Each storage package owns dialect-specific table declarations because timestamps and JSON are represented differently, while both implement one shared behavioral repository contract.

Drizzle Kit produces checked-in schema-version-2 initialization migrations. Application startup verifies `schema_meta.version` before applying an initialization migration. Raw SQL is allowed only for a query that Drizzle cannot express clearly; it must remain parameterized and covered by the shared repository contract suite.

### Canonical identity

A source item is globally canonical within its source. `record.id` is the SHA-256 digest of the UTF-8 string `<source>\0<externalId>`. The database enforces `UNIQUE(source, external_id)`.

Targets and watches no longer participate in canonical identity. When two watches discover the same X post, Argus stores one record and two `record_watches` observations.

### Tables

#### `schema_meta`

- `id`: fixed integer `1`
- `version`: integer, exactly `2`
- `created_at`: timestamp

#### `records`

- `id`: 64-character lowercase SHA-256 text primary key
- `source`: `x`, `telegram`, or `web`
- `external_id`: source-native identifier
- `url`: canonical source URL
- `title`: nullable text
- `text`: text; an empty string is valid when media is present
- `author`: nullable text
- `published_at`: nullable timestamp
- `raw`: source payload JSON
- `metadata`: nullable normalized metadata JSON
- `content_hash`: SHA-256 of content fields, normalized media descriptors, and normalized relationships
- `first_seen_at`: timestamp
- `last_seen_at`: timestamp
- unique `(source, external_id)`

A source item is valid when it contains non-empty text or at least one normalized media asset. Empty text without media remains invalid.

#### `record_watches`

- `record_id`: foreign key to `records`
- `watch_id`: configured watch identifier
- `target_id`: scheduled target that observed the record
- `first_seen_at`: timestamp
- `last_seen_at`: timestamp
- primary key `(record_id, watch_id, target_id)`

#### `record_revisions`

- `id`: UUID primary key
- `record_id`: foreign key to `records`
- `content_hash`: SHA-256
- `snapshot`: JSON containing the canonical content, raw payload, normalized media descriptors, and normalized relations for that revision
- `created_at`: timestamp
- unique `(record_id, content_hash)`

Engagement counters do not affect `content_hash` and therefore do not create content revisions.

#### `media_assets`

- `id`: deterministic SHA-256 of record ID, source media ID when present, kind, and URL
- `record_id`: foreign key to `records`
- `source_media_id`: nullable source-native media identifier
- `kind`: `image`, `video`, `audio`, or `document`
- `url`: original storage/CDN pointer
- `preview_url`: nullable thumbnail or poster pointer
- `mime_type`: nullable media type
- `width`: nullable positive integer
- `height`: nullable positive integer
- `duration_ms`: nullable non-negative integer
- `alt_text`: nullable text
- `position`: non-negative integer preserving source order
- `metadata`: nullable JSON for source-specific fields
- `first_seen_at`: timestamp
- `last_seen_at`: timestamp

Argus never downloads media bytes in `0.2.0`.

#### `record_relations`

- `id`: deterministic SHA-256 of subject, relation type, target source, and target external ID
- `subject_record_id`: foreign key to `records`
- `kind`: `reply_to`, `quote_of`, `repost_of`, `thread_parent`, or `links_to`
- `object_source`: source name
- `object_external_id`: source-native target identifier
- `object_record_id`: nullable foreign key populated when the target is present locally
- `object_url`: nullable canonical target URL
- `metadata`: nullable JSON
- `first_seen_at`: timestamp
- `last_seen_at`: timestamp

A relation can point to an item Argus has not ingested. When that item later arrives, repository reconciliation fills `object_record_id`.

#### `engagement_snapshots`

- `id`: UUID primary key
- `record_id`: foreign key to `records`
- `likes`, `replies`, `reposts`, `quotes`, `views`, `bookmarks`: nullable non-negative integers
- `collected_at`: timestamp

Argus writes a new engagement snapshot only when at least one available counter differs from the latest snapshot.

#### `conversation_tracking`

- `root_record_id`: primary key and foreign key to `records`
- `watch_id`: watch responsible for automatic tracking
- `status`: `active`, `complete`, or `failed`
- `order_by`: one of `likes`, `newest`, `oldest`, `replies`, `reposts`, `views`, or `source`
- `max_per_post`: integer from `1` through `200`
- `max_tracking_hours`: integer from `1` through `2160`
- `published_at`: timestamp used to calculate the primary tracking horizon
- `next_run_at`: nullable timestamp
- `stops_at`: timestamp
- `last_observed_replies`: nullable non-negative integer
- `burst_until`: nullable timestamp for renewed activity
- `last_error`: nullable bounded text
- `updated_at`: timestamp

#### `conversation_snapshots`

- `id`: UUID primary key
- `root_record_id`: foreign key to `records`
- `observed_count`: number of distinct replies inspected in this refresh
- `retained_count`: number selected, never greater than `max_per_post`
- `order_by`: configured selection order
- `pages_fetched`: positive integer
- `complete`: boolean indicating whether the available upstream traversal completed
- `truncated`: boolean
- `truncation_reason`: nullable `selection_limit`, `observation_limit`, `upstream_cursor_failure`, or `upstream_unavailable`
- `upstream_cursor`: nullable last cursor
- `collected_at`: timestamp

#### `conversation_snapshot_items`

- `snapshot_id`: foreign key to `conversation_snapshots`
- `reply_record_id`: foreign key to `records`
- `rank`: one-based integer
- `sort_value`: nullable numeric value used by the chosen order
- primary key `(snapshot_id, reply_record_id)`
- unique `(snapshot_id, rank)`

#### Existing operational tables

`checkpoints`, `jobs`, `diagnostic_watches`, and `applied_config` retain their responsibilities under Drizzle.

`artifacts` retains the artifact body, kind, provider, model, provenance, and creation timestamp. Record membership moves from a JSON ID array into `artifact_records(artifact_id, record_id, position)`. Media actually supplied to intelligence is recorded in `artifact_media(artifact_id, media_asset_id, position, disposition)`, where disposition describes whether it was analyzed or omitted and why.

## Source contract

`SourceItem` gains normalized `media`, `relations`, and `engagement` properties. Source adapters remain responsible only for validation, safe upstream access, and normalization into this contract. They do not write storage directly.

```ts
type MediaKind = "image" | "video" | "audio" | "document";
type RelationKind = "reply_to" | "quote_of" | "repost_of" | "thread_parent" | "links_to";

interface SourceMedia {
  sourceMediaId?: string;
  kind: MediaKind;
  url: string;
  previewUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  metadata?: Record<string, unknown>;
}

interface SourceRelation {
  kind: RelationKind;
  objectSource: SourceName;
  objectExternalId: string;
  objectUrl?: string;
  metadata?: Record<string, unknown>;
}

interface Engagement {
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  views?: number;
  bookmarks?: number;
}
```

The engine hashes canonical content plus ordered media and relation descriptors, commits a record, upserts watch observations, reconciles relation targets, and records changed engagement in one storage transaction.

## Source enrichment

### X

FxTwitter v2 payloads are normalized into records even when `text` is empty and media exists. Argus captures images, videos, audio, documents, previews, dimensions, duration, alt text, quote relationships, reply parents, repost relationships, and available engagement counters.

Account and search ingestion remain the roots configured by a watch. Replies discovered by automatic conversation tracking inherit the root's watch ID but use a conversation target ID so their provenance remains distinguishable.

### Telegram

The public channel preview parser accepts media-only announcement posts. It extracts source-hosted photos, video posters and video URLs when exposed, audio pointers, and document links. Telegram channel comments and linked discussion groups are not traversed.

### Web

Page ingestion extracts Open Graph and Twitter card images, HTML image/audio/video/source elements associated with the readable document, and linked documents. Feed ingestion extracts RSS and Atom enclosures and media namespace entries. SearXNG result ingestion retains only media pointers present in its response; it does not fetch every result page solely to discover media.

All pointers must be absolute HTTP or HTTPS URLs after resolution against the final document URL. Existing safe HTTP and network policies remain in force for Argus-owned fetches.

## Automatic X reply tracking

### Configuration

Reply tracking is a source-level policy applied to X roots in every watch.

```yaml
version: 2
sources:
  x:
    enabled: true
    endpoint: https://api.fxtwitter.com/
    replies:
      enabled: true
      maxPerPost: 50
      maxTrackingHours: 168
      orderBy: likes
```

`enabled` defaults to `false` in hand-authored config so collection cost is never introduced silently. Interactive onboarding asks explicitly and recommends enabling it.

### Onboarding profiles

- Hot topic: `maxTrackingHours: 24`
- Standard: `maxTrackingHours: 168`; recommended default
- Niche topic: `maxTrackingHours: 720`
- Custom: operator selects `1` through `2160` hours, `1` through `200` retained replies, and an ordering mode

All named profiles retain 50 replies ordered by likes.

### Refresh cadence

Tracking uses the root post's publication time, not initial ingestion time.

- Age below 1 hour: refresh every 15 minutes.
- Age from 1 through 6 hours: refresh hourly.
- Age from 6 through 24 hours: refresh every 6 hours.
- Age from 24 through 72 hours: refresh daily.
- Age above 72 hours: refresh every 72 hours until `stops_at`.
- A post first discovered after its primary tracking horizon receives one immediate snapshot and is marked complete.

When observed reply count grows by at least 10 replies or 20 percent since the prior snapshot, whichever threshold is lower but at least one reply, Argus schedules a one-hour burst bounded to the next six hours. The maximum tracking horizon does not move.

If a completed root is later rediscovered with a higher upstream reply count, Argus opens one new 24-hour reactivation window from rediscovery. Repeated rediscovery cannot extend the same reactivation window.

### Observation and selection

Each refresh follows FxTwitter conversation cursors until the upstream ends, 500 distinct replies have been observed, or an error prevents continuation. `maxPerPost` controls retention in the current snapshot, not the observation cap.

Argus deduplicates observed replies, sorts them deterministically, and retains the first configured count. Ties break by reply publication time and then external ID. `source` preserves the first observed upstream order. Missing values sort after present values for metric-based orderings.

The product and its summaries call these the "most-liked observed replies" or equivalent. They never claim the retained set represents all X replies.

Finding `maxPerPost` replies does not stop tracking. A final snapshot occurs at or immediately after the configured horizon.

### Failures

Failure to fetch replies never rolls back the root record. The tracking job follows the existing retry policy. Exhausted failures record a partial snapshot when any page succeeded, set an explicit truncation reason, and leave an actionable bounded error in tracking state and job logs.

Known upstream pagination failures are therefore visible rather than interpreted as a complete conversation.

## Transient primitive gateway

The gateway exists for agents that need traversal beyond scheduled ingestion. It is a read-only proxy and never calls repository mutation methods.

### Authentication and routing

Every primitive request requires the configured Argus bearer token. If no API token is configured, primitive routes return an actionable service-unavailable error.

X requests use:

```http
GET /v1/primitives/x/2/{upstream-path-and-query}
```

The gateway maps only normalized paths beneath `/2/` to the configured FxTwitter endpoint. It rejects dot segments, encoded path ambiguity, user information, fragments, non-HTTP(S) endpoints, request bodies, and methods other than `GET` or `HEAD`.

Web search requests use:

```http
GET /v1/primitives/web/search?q=...&engines=...&categories=...&language=...&time_range=...&pageno=...
```

The gateway maps to the configured SearXNG `/search` endpoint, forces JSON output, and accepts SearXNG search parameters rather than administrative paths.

### Boundary behavior

- Request authorization, cookies, forwarding headers, and arbitrary client headers are never sent upstream.
- Argus supplies its own user agent and `Accept` header.
- Redirects are accepted only when every hop remains on the configured upstream origin.
- Existing DNS rebinding and private-network policy applies to external endpoints; explicitly trusted managed service origins retain their existing boundary.
- Request URL length, timeout, redirect count, and response body size are bounded with the existing safe HTTP constants. Oversized bodies stop streaming immediately.
- An in-process token-and-source bucket permits 60 primitive requests per minute. Excess requests receive `429` with a retry hint.
- Upstream status, body bytes, and safe content type are returned unchanged. Argus-generated boundary failures use the normal API error envelope.
- Logs contain source, normalized operation path, status, duration, and byte count. They never contain response bodies, bearer tokens, cookies, or the raw query string.

Primitive responses do not create records, revisions, media assets, relations, engagement snapshots, conversation state, artifacts, jobs, or checkpoints.

## Multimodal intelligence

OpenRouter remains the only `0.2.0` intelligence provider. The provider builds content parts from the selected canonical records, retained conversation snapshot, and bounded media pointers.

- Original text and source URLs are always supplied.
- Image URLs are supplied as image content parts when the selected model declares image support.
- Video uses a preview image plus the original video URL unless the selected model declares direct video support.
- Audio and document URLs are supplied only through content-part types declared by the selected model and supported by OpenRouter.
- Argus does not download, transcode, or base64-encode remote media.
- At most 20 media assets are supplied per generation, ordered by record order and source position.
- Source content and media are explicitly labeled untrusted in the system instruction.

Before generation, Argus resolves the selected model's supported input modalities through OpenRouter model metadata with a bounded cache. If metadata is unavailable, Argus falls back to text-only and records the reason. It never guesses that a model consumed a media type.

Artifact provenance records the conversation snapshot, selected record IDs, analyzed media IDs, omitted media IDs with reasons, provider generation ID, model, prompt, and collection timestamps. Generated prose must cite the supplied record index and must describe reply sentiment as sampled observation rather than population truth.

## API representation

Record list and detail responses expose normalized `media`, `relations`, the latest `engagement`, and watch observations. List responses remain bounded and cursor-paginated.

Conversation detail is exposed separately so normal record lists do not expand into graphs:

```http
GET /v1/records/{recordId}/conversation
```

The response contains the root record, latest conversation snapshot, ranked retained reply records, completeness fields, and collection provenance. Historical snapshots remain queryable through a bounded cursor.

Artifact responses expose record and media provenance without embedding media bytes.

## Configuration and operator UX

Configuration version `2` is strict. Reply settings are legal only when X is enabled. `maxPerPost`, `maxTrackingHours`, and `orderBy` are validated at load time with specific paths and recovery messages.

Interactive onboarding asks:

1. Whether to retain replies when X is enabled.
2. Hot, Standard, Niche, or Custom tracking when replies are enabled.
3. Custom duration, retained count, and ordering only for Custom.

Human-readable `argus config` output explains the selected profile-equivalent duration. `argus doctor` reports X root ingestion and reply tracking separately so a conversation failure does not imply that root collection is down.

## Documentation and Agent Skill

The handbook documents:

- the complete version-2 schema and storage differences;
- media-pointer behavior and URL-expiry limitations;
- reply tracking cadence, profiles, selection modes, observation limits, and sampling language;
- normalized record, conversation, and artifact APIs;
- every primitive route, boundary, and traversal example;
- OpenRouter modality behavior and provenance;
- reset/re-onboard instructions for the breaking release;
- SQLite and PostgreSQL deployment paths.

The existing setup skill remains focused on installation and operations. A separate `argus-research` skill teaches Claude, Codex, Hermes, OpenClaw, and other agents to authenticate, page through records, inspect conversations, call transient primitives, preserve citations, avoid leaking tokens, and distinguish observed samples from complete populations. MCP remains deferred.

`llms.txt` and the documentation index link directly to both normalized APIs and primitive traversal guidance.

## Security

- All upstream and stored content is untrusted data, including text embedded in images and documents.
- Media URLs are validated as absolute HTTP(S) pointers but are not fetched during ingestion merely for validation.
- Intelligence never receives API tokens, configuration secrets, raw job errors, or unrelated record payloads.
- Primitive paths cannot select an upstream host and cannot access SearXNG administration.
- Raw primitive responses are bounded before buffering.
- Database JSON parsing remains validated at repository boundaries.
- Errors and logs preserve the existing redaction contract.

## Testing and acceptance

### Unit tests

- Literal fixtures cover every media kind, media-only Telegram and X records, relationships, engagement normalization, and malformed pointers.
- Reply cadence tests cover publication-relative scheduling, old discoveries, final horizon snapshots, activity bursts, and rediscovery reactivation.
- Selection tests cover every ordering, missing counters, deterministic ties, deduplication, and observation truncation.
- Primitive gateway tests cover authentication, path confusion, redirects, response caps, timeouts, rate limiting, header stripping, and zero repository writes.
- Intelligence tests cover each modality, model capability omission, provenance, citations, and sampled-sentiment wording.

### Shared storage contract

The same repository behavior suite runs against in-memory SQLite and Testcontainers PostgreSQL. It covers canonical deduplication across watches, atomic rich-record commits, relation resolution, content revisions, engagement change detection, conversation snapshots, artifact joins, pagination, and schema-version rejection.

PostgreSQL contract tests are a required CI job rather than silently skipped in the default release gate.

### Integration tests

- Real HTTP test servers emulate complete FxTwitter, partial/paginated conversations, SearXNG, redirects, and OpenRouter metadata/generation.
- Scheduler-worker tests prove reply work is bounded and independent from root ingestion.
- API tests prove normalized conversation output and byte-preserving transient responses.
- CLI tests cover every onboarding profile and non-interactive version-2 answers file.

### Release acceptance

Before release, run lint, typecheck, build, all unit/integration tests, the PostgreSQL contract job, installer smoke tests, and a manual live-source acceptance against public X, Telegram, Web, SearXNG, and OpenRouter.

The signed `0.2.0` release is not promoted until those gates pass. After promotion, Prudhvi performs the fresh prudhvi-laptop installation and onboarding personally. Argus does not preinstall or restore the erased VPS state.

## Success criteria

The design is complete when:

- a media-only X or Telegram post becomes a queryable canonical record;
- normalized media pointers and relationships behave identically in SQLite and PostgreSQL;
- the same post observed by multiple watches is stored once;
- enabled X roots produce bounded, provenance-rich conversation snapshots through the configured horizon;
- agents can traverse FxTwitter and SearXNG transiently without any database mutation;
- OpenRouter artifacts state exactly which media and sampled replies were analyzed or omitted;
- onboarding, handbook, `llms.txt`, and `argus-research` explain the behavior without requiring source-code knowledge;
- a clean signed install can be completed by the operator on the wiped VPS.
