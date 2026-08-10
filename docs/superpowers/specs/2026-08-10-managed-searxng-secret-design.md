# Managed SearXNG Secret Design

## Problem

Argus 0.1.9 derives `SEARXNG_SECRET` during onboarding but writes it only to
the Argus service's `secrets.env`. The managed SearXNG service does not receive
that variable, so current SearXNG images retain the forbidden default
`ultrasecretkey`, exit immediately, and prevent onboarding verification.

## Decision

Keep the existing deterministic, per-instance secret derivation from the
operator-provided Argus API token. Render that value into a dedicated
`searxng/secrets.env` file with mode `0600`, and attach only that file to the
managed SearXNG service through Compose `env_file`. Do not expose the Argus API
token, database password, OpenRouter key, or any other service secret to
SearXNG.

The dedicated file is present only when managed SearXNG is selected. External
or disabled SearXNG deployments do not render it or reference it in Compose.
Re-onboarding with the same API token is deterministic; rotating the API token
also rotates the SearXNG secret.

## Components

- `packages/deployment/src/config.ts` renders the dedicated SearXNG secret
  payload separately from Argus service secrets.
- `packages/deployment/src/files.ts` atomically writes
  `/opt/argus/searxng/secrets.env` as `0600` when present.
- `packages/deployment/src/compose.ts` gives only the SearXNG service that
  dedicated environment file.
- Existing onboarding, repair, update, and rollback paths continue using the
  rendered deployment files; no new prompt, public contract, or dependency is
  introduced.

## Failure Handling

File writes retain the existing atomic-write and directory-sync behavior. A
failed secret-file write aborts before Compose reconciliation. SearXNG remains
subject to the existing bounded health verification, diagnostics, and repair
commands.

## Verification

1. Unit tests prove the dedicated file contains only `SEARXNG_SECRET`, is mode
   `0600`, and is omitted outside managed mode.
2. Compose tests prove only SearXNG consumes the dedicated file.
3. The pinned SearXNG live test boots with rendered production settings and
   secret delivery, then returns JSON search results.
4. Full lint, typecheck, unit, integration, release, and installer gates pass.
5. Publish a patched release, reinstall or update `prudhvi-laptop`, onboard the
   movie/TV-news watch, and prove records from X, Telegram, and web separately.

## Non-goals

- Adding a SearXNG secret prompt.
- Sharing the complete Argus secrets file with SearXNG.
- Pinning an obsolete SearXNG image.
- Changing source adapters or ingestion behavior.
