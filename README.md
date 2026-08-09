# Argus

Argus is a self-hosted data layer for AI agents. It collects from X, public
Telegram announcement channels, and the Web; stores canonical revisioned
records; and provides deterministic queries with source links. Optional
OpenRouter summaries remain outside the ingestion path.

## Capabilities

- X account and search ingestion through your FxEmbed endpoint
- public Telegram announcement, URL, RSS/Atom, and SearXNG-backed Web sources
- scheduled watches, leases, retries, deduplication, revisions, and checkpoints
- SQLite for a one-process deployment or PostgreSQL for separated runtime roles
- authenticated JSON API and optional sourced intelligence artifacts

Argus does not access private Telegram chats, bypass site controls, or require
an LLM for collection and querying.

## Install

Install the signed public release on a supported VPS, then start interactive
onboarding:

```bash
curl -fsSL https://argus.gpsxtre.me/install.sh | sh
argus onboard
```

The installer verifies the release manifest signature and wrapper hash before
installation. See the [quick start](https://argus.gpsxtre.me/docs/quick-start)
and the current [v0.1.9 release](https://github.com/GPSxtreme/argus/releases/tag/v0.1.9).

## Development

Use Node.js 24 and pnpm 10.33.0:

```bash
corepack enable
pnpm install --frozen-lockfile
cp argus.example.yaml argus.yaml
cp .env.example .env
set -a
source .env
set +a
pnpm argus config validate
pnpm argus config apply
pnpm start
```

Keep `argus.yaml` and `.env` local. Never commit runtime configuration,
credentials, or generated instance state.

## Documentation

- [Operator handbook](https://argus.gpsxtre.me/docs)
- [Contributor guide](https://argus.gpsxtre.me/docs/contributing)
- [Agent interfaces](https://argus.gpsxtre.me/docs/agents)
- [Current architecture guide](https://argus.gpsxtre.me/docs/contributing/architecture)
- [Architecture and verification design](docs/superpowers/specs/2026-08-09-operator-documentation-and-verification-design.md)

## Test

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```
