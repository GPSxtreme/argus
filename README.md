# Argus

Argus is a self-hosted data layer for AI agents. It continuously collects from
X, public Telegram announcement channels, and the Web; stores canonical,
revisioned records; and exposes deterministic queries with source links.
OpenRouter summaries are optional and remain separate from the ingestion path.

## What V1 includes

- X account and search ingestion through your own FxEmbed endpoint
- anonymous monitoring of public Telegram announcement channels
- URL extraction, RSS/Atom ingestion, and SearXNG web discovery
- cron watches, checkpoints, retries, leases, deduplication, and revisions
- SQLite for a one-process VPS deployment
- PostgreSQL for `api`, `scheduler`, `worker`, and `processor` roles
- authenticated JSON API and optional sourced OpenRouter summaries
- one versioned YAML configuration; environment variables only for secrets

Argus does not access private Telegram chats, bypass site access controls, or
make an LLM part of the core data path.

## Quick start

Requirements: Node.js 24 and pnpm 10.

```bash
pnpm install
cp argus.config.example.yaml argus.config.yaml
cp .env.example .env
set -a
source .env
set +a
pnpm argus config validate
pnpm argus config apply
pnpm start
```

Edit `argus.config.yaml` before applying it. Remove unused secret references or
set their environment variables. The API listens on `http://localhost:8788`;
`GET /health` is public and `/v1/*` accepts `Authorization: Bearer <token>`.

```bash
curl http://localhost:8788/health
curl -H "Authorization: Bearer $ARGUS_API_TOKEN" \
  "http://localhost:8788/v1/records?q=security&source=telegram"
```

Create a sourced summary when intelligence is enabled:

```bash
curl -X POST \
  -H "Authorization: Bearer $ARGUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"security release","limit":30}' \
  http://localhost:8788/v1/summaries
```

## Configuration

`argus.config.example.yaml` shows the full surface. A watch chooses any
combination of X accounts/searches, Telegram channel usernames, URLs, feeds,
and web queries. `classify.keywords` adds match metadata; it never discards the
original record.

Run `pnpm argus config validate [path]` before
`pnpm argus config apply [path]`. Apply is content-addressed and idempotent.
Resolved secrets are never stored in the applied snapshot.

## Deployment

For a single VPS, use SQLite and:

```bash
docker compose -f deploy/docker/compose.yaml up -d --build
```

Add `--profile search` to run SearXNG, or `--profile postgres` for the bundled
database. For Railway, use PostgreSQL and create services from the role
templates in `deploy/railway/`. See [docs/operations.md](docs/operations.md).

FxEmbed is a Cloudflare Worker upstream rather than a normal long-running
container. Deploy your own copy under your Cloudflare account and set the X
source endpoint to its `/api` realm; Argus itself has no dependency on a
third-party public FxTwitter instance.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

The architecture and decisions are documented in
`docs/superpowers/specs/2026-07-31-argus-v1-design.md`.
