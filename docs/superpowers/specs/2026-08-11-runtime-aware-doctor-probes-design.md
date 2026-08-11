# Runtime-Aware Doctor Probes Design

## Problem

Argus v0.1.15 installs and ingests correctly, but `argus doctor --json` reports SearXNG and FxEmbed as unhealthy on the real VPS.

The two failures are false negatives:

- The immutable management launcher runs the CLI container with host networking. Managed SearXNG is deliberately private to the Compose networks and is reachable as `http://searxng:8080` only from the Argus runtime container.
- The configured FxEmbed base URL is not a health endpoint. Its root redirects, while the `/2` API requests used by the X adapter succeed.

The same host-context SearXNG check makes `argus repair searxng` report failure after a successful recreation.

## Goals

- Make Doctor report the deployed system's real health from the same contexts used by ingestion.
- Keep managed SearXNG private; do not publish port 8080.
- Keep the immutable launcher on host networking; do not attach it to deployment networks.
- Make SearXNG repair verification use the same truthful runtime-context check.
- Exercise FxEmbed through the existing end-to-end X diagnostic instead of inventing a provider health route.
- Preserve bounded timeouts, secret-safe diagnostics, and the existing report schema.

## Non-goals

- No service, networking, Compose, onboarding, or user-configuration changes.
- No retries beyond the existing bounded Doctor and repair behavior.
- No compatibility layer for the invalid bare FxEmbed request.
- No new public endpoint or health API.
- No unrelated diagnostic refactor.

## Considered Approaches

### 1. Probe from the real runtime contexts — selected

For managed SearXNG, execute a bounded Node JSON-search probe through `docker compose exec -T argus`. For FxEmbed, reuse the single X source-smoke result already produced by Doctor. This matches production data flow and adds no network exposure.

### 2. Publish SearXNG to the host

This would make the existing management-container fetch work, but expands the network attack surface and changes a deliberately private service solely for diagnostics.

### 3. Attach the management container to deployment networks

This complicates bootstrap and failure handling because the networks may not exist when the CLI starts, and the CLI also needs host/external access for unrelated commands.

## Design

### Managed SearXNG probe

Add one deployment-level helper that checks managed SearXNG from the running `argus` service:

1. Load the persisted, verified Compose environment.
2. Validate the resolved Compose project with the existing `docker compose -p argus config` pattern.
3. Run `docker compose -p argus exec -T argus node --input-type=module -e <probe> <endpoint>` with the configured endpoint passed as an argv value, never interpolated into shell source.
4. The bounded probe requests `/search?q=argus&format=json`, requires an HTTP-success response, parses JSON, and requires `results` to be an array.
5. Return only a boolean/structured health result. Do not return endpoint payloads, command output, environment values, or secrets.

Doctor uses this helper when SearXNG is managed. External SearXNG keeps the existing bounded direct-fetch check because an external endpoint is expected to be reachable from the management container. Disabled SearXNG remains skipped.

`repairSearxng` uses the same managed helper after recreation for each existing bounded attempt. The obsolete repair fetcher option is removed rather than retained as a compatibility path. Direct fetching remains only for explicitly external Doctor health checks; repair no longer verifies a private endpoint from the host-network management container.

### FxEmbed health

Doctor creates the X source-smoke operation once and shares its single promise between the `x` and `fxembed` report entries.

- Disabled FxEmbed remains skipped.
- When X smoke is healthy, FxEmbed is healthy with a stable code/message stating that the FxEmbed-backed X diagnostic completed.
- When X smoke is unhealthy or times out, FxEmbed is unhealthy with a stable code/message stating that the FxEmbed-backed diagnostic failed; the original X check retains the precise source-smoke failure and recovery guidance.
- When X smoke is skipped because no diagnostic target is configured, FxEmbed is also skipped rather than inventing an endpoint result.
- Doctor never requests the bare FxEmbed base URL.

Sharing one promise is required: Doctor must not create two diagnostic watches, duplicate provider traffic, or perform cleanup twice.

### Execution and error handling

- All Compose commands use the existing command executor, persisted environment, root directory, project name, and bounded timeout conventions.
- Failure to load or validate Compose state, execute the runtime probe, parse JSON, or meet the deadline returns the existing secret-safe SearXNG unhealthy diagnostic.
- The aggregate Doctor deadline remains authoritative.
- A failed X smoke makes both the X dependency path and FxEmbed component unhealthy without claiming that a bare provider root is a supported health route.

## Testing

Use TDD and prove both old failures before production changes.

1. Doctor unit tests:
   - managed SearXNG health is determined through the Compose `argus` runtime command, not `fetcher`;
   - external SearXNG still uses the direct bounded fetch;
   - invalid runtime JSON, nonzero exit, timeout, and unavailable persisted Compose inputs fail closed;
   - the bare FxEmbed endpoint is never fetched;
   - one X smoke operation produces both X and FxEmbed results and performs one cleanup;
   - disabled FxEmbed remains skipped and failed X smoke yields explicit unhealthy entries.
2. SearXNG repair tests:
   - successful recreation polls with the runtime-context helper;
   - host DNS/direct fetch is not used for managed repair;
   - runtime probe failure remains bounded and returns `SEARXNG_HEALTHCHECK_FAILED`.
3. CLI/wrapper integration:
   - reproduce the installed launcher's host-network boundary while managed SearXNG remains private;
   - use an FxEmbed fixture whose root redirects/fails while its real `/2` diagnostic path succeeds;
   - assert `argus doctor --json` reports healthy.
4. Run focused deployment/CLI/release tests, all package typechecks, lint, build, and VPS acceptance after release.

## Acceptance

- On the existing VPS, `argus doctor --json` reports Docker, Argus, SQLite, SearXNG, FxEmbed, X, Telegram, and Web healthy.
- SearXNG remains unexposed to the host.
- X/TG/Web checkpoints and SQLite counts continue advancing.
- `argus repair searxng` verification uses the private runtime network and no longer false-fails.
- No secret or private record content appears in diagnostics or logs.
