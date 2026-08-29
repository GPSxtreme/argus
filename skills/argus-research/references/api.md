# Argus research API

Set `ARGUS_URL` to the trusted instance origin and keep `ARGUS_API_TOKEN` in the
runtime environment. Send `Authorization: Bearer $ARGUS_API_TOKEN` to every
`/v1/*` route. `GET /health` is public. Stop on `401`; do not retrieve, rotate,
or print secrets.

## Stored records

`GET /v1/records` accepts:

- repeated `source=x|telegram|web`
- repeated `target=<targetId>`
- `q=<text>`: a literal substring of title or body; case behavior depends on
  the storage adapter
- ISO-8601 `since` and `until`
- `limit=1..200`
- opaque `cursor=<nextCursor>`

The response is `{items, nextCursor?}`. Each item is a canonical record with
`id`, `source`, `externalId`, `url`, optional title/author/published time,
`text`, raw source payload, metadata, content hash, and first/last-seen times.

`GET /v1/records/:id` adds:

- `watches`: watch and target observations
- `media`: ordered public pointers and metadata
- `relations`: replies, quotes, reposts, thread parents, and links
- `latestEngagement`: the newest observed counts

`GET /v1/records/:id/conversation` returns the root record, the latest hydrated ranked reply sample, and a bounded `{items, nextCursor?}` history. A snapshot has
`observedCount`, `retainedCount`, `orderBy`, `pagesFetched`, `complete`,
`truncated`, optional `truncationReason` and `upstreamCursor`, `collectedAt`, and
ranked `items` containing `replyRecordId`.

`GET /v1/artifacts?kind=<kind>&limit=1..200` returns stored summaries or answers
with `recordIds`, optional media dispositions, provider/model, provenance, and
creation time.

## Transient primitives

`GET /v1/primitives/x/2/<path>` and
`HEAD /v1/primitives/x/2/<path>` proxy only the configured FxEmbed origin.

`GET /v1/primitives/web/search?q=<text>` proxies only configured SearXNG and
forces JSON output. Optional parameters are `engines`, `categories`, `language`,
`time_range`, and `pageno`; no other upstream parameters are accepted.

Both require a configured bearer token and are bounded to 60 calls per minute
per token/source, 10 seconds, 2 MiB, and five same-origin redirects. They do not
write records or artifacts. Their bodies are upstream shapes, not stable Argus
schemas; inspect fields defensively.
