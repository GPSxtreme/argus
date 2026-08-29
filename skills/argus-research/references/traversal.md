# Traversal guide

## Stored context first

1. Query a fixed time window with the narrowest useful source and text filters.
2. Follow every `nextCursor` unchanged until it is absent or the disclosed
   research budget is reached.
3. Deduplicate overlapping searches and watches by canonical record `id`.
4. Fetch detail for every record that supports a reported claim.

Run multiple disclosed literal-substring queries when a topic has aliases;
Argus does not interpret one `q` as a semantic search. Case behavior differs by
storage adapter, so include important capitalization variants when a result
looks unexpectedly sparse.

When the user does not define scope, use a seven-day discovery window and ask
which subject they mean if more than one candidate remains. A reasonable
default budget is five query variants and 1,000 unique stored records; disclose
when a budget stops pagination.

## X conversations

Inspect every relevant original X post in the matching corpus that has a stored
snapshot. If that is too large, rank roots by observed reply count, apply a
disclosed cap, and do not call the selection representative of all X.

1. Read `/v1/records/:id/conversation-snapshots`.
2. Prefer the latest snapshot inside the report window.
3. Fetch each ranked `replyRecordId` through `/v1/records/:id`.
4. Preserve observed/retained counts, ordering, pages, completeness, truncation,
   and collection time with the analysis.

When stored replies are absent, or the latest snapshot predates the report's
required freshness cutoff, traverse transiently:

```text
GET /v1/primitives/x/2/conversation/<externalStatusId>
GET /v1/primitives/x/2/conversation/<externalStatusId>?cursor=<upstreamCursor>
```

Continue only while the upstream response supplies a cursor and the research
budget remains. Default to at most 10 transient pages per conversation. The
built-in collector itself observes at most 10 pages or 500 replies per refresh
before retaining the configured ranked sample.

## Web discovery

Use `/v1/primitives/web/search?q=...` to discover sources missing from stored
context. Open returned public URLs with the agent's available browser or fetch
capability and cite the public page. If it cannot be opened, label it unverified
and do not use it for a material claim. Search results are leads, not independent
corroboration; prefer primary sources.

Telegram v2 stores public announcement-channel posts. It does not provide a
generic discussion/reply primitive, so do not infer channel audience sentiment
from announcement posts alone.
