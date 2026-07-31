# Argus operations

## Choosing a topology

Use SQLite with `runtime.role: all` for one VPS. It has the fewest moving
parts and remains the recommended starting point.

Use PostgreSQL for multiple services. Run one or more API and worker replicas,
one scheduler, and an optional processor. Set `ARGUS_ROLE` per service; it
overrides the role in the shared YAML file. Jobs use expiring database leases,
so worker crashes are retried without Redis or Kafka.

## Source setup

### X

Deploy the upstream FxEmbed Worker into a Cloudflare account you control.
Configure its X credentials according to that project, then set
`sources.x.endpoint` to the API realm, for example
`https://api.fx.example.com` or `http://localhost:8787/api` during local
development. Argus calls the profile-status and search endpoints.

### Telegram

Provide public channel usernames without `@`. Argus polls Telegram's public
preview (`t.me/s/<channel>`) anonymously. The channel must expose a public
preview. V1 intentionally has no bot token, user session, group-chat access,
or private-channel support.

### Web

URL targets are fetched and reduced to readable title/text. Feed targets accept
RSS and Atom. Query targets require a SearXNG base URL with JSON output enabled.
Argus respects ordinary HTTP failures and does not bypass authentication,
CAPTCHA, robots policy, or network controls.

## Secrets

Put secret references such as `${ARGUS_API_TOKEN}` in YAML and the values in
the process environment. Required values:

- `ARGUS_API_TOKEN` when API authentication is configured
- `OPENROUTER_API_KEY` only when intelligence is enabled
- database credentials when PostgreSQL is used

Applied configuration snapshots remove API and OpenRouter secrets. Logs do not
print configuration objects or authorization headers.

## Backup and recovery

For SQLite, stop Argus and copy the database plus any `-wal` and `-shm` files,
or use SQLite's online backup tooling. Restore all files together.

For PostgreSQL, use regular `pg_dump`/`pg_restore` or provider snapshots.
Records and revisions are immutable history; current records can be rebuilt
from revisions if necessary. After restore, restart the scheduler and workers.
Idempotent identities prevent unchanged source items from duplicating.

## Health and querying

`GET /health` reports process health and does not require a token. All `/v1`
routes use bearer authentication when `api.token` is configured.

Record query parameters:

- `q`: full-text query
- repeated `source`: `x`, `telegram`, or `web`
- repeated `target`: canonical target ID
- `since` / `until`: ISO timestamps
- `limit`: 1–200
- `cursor`: opaque cursor returned by the prior page

`POST /v1/watches/:watchId/ingest` queues an immediate run of every target in a
watch. `GET /v1/artifacts` returns stored intelligence outputs without mixing
them into canonical source records.

## Updating configuration

Validate and apply before restarting:

```bash
pnpm argus config validate /app/argus.yaml
pnpm argus config apply /app/argus.yaml
```

Invalid files never replace the current snapshot. Reapplying identical content
is a no-op. Runtime services should all mount the same config revision.
