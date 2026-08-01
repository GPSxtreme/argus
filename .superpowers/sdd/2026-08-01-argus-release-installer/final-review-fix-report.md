# Final review fix report

Date: 2026-08-01

## Scope

Resolved the five Important whole-branch review findings without expanding the
release/onboarding scope:

1. Managed Compose now gives Argus and SearXNG a private service network plus a
   non-internal egress network. PostgreSQL remains private-only and has no host
   port.
2. Managed PostgreSQL config references the complete `ARGUS_POSTGRES_URL`.
   `secrets.env` stores the raw `POSTGRES_PASSWORD` and a full URL whose password
   is percent-encoded, including reserved-character coverage.
3. Safe HTTP has one clamped hard deadline across resolution, connect, headers,
   redirects, body reads, cancellation, and dispatcher cleanup. Bodies are
   byte-bounded, cleanup is idempotent, and late work is observed.
4. SQLite and PostgreSQL jobs use owner-and-token lease fencing, atomically
   reclaim expired running jobs, reject stale settlement, increment crash/retry
   attempts, and terminalize exhausted leases. Diagnostic ingestion requires and
   verifies the active lease before writing.
5. Record pagination uses an opaque versioned keyset cursor for
   `(ingested_at DESC, id ASC)`. Legacy, malformed, oversized, or
   version-mismatched cursors fail closed and the API returns a stable 400.

## TDD evidence

- Compose/config RED: 4 expected failures, 6 passes. GREEN: 10/10, including
  authoritative `docker compose config` parsing and reserved secret round-trip.
- Safe HTTP RED: stalled headers and body timed out at the test harness and an
  over-limit body incorrectly resolved. GREEN: 18/18.
- Storage/API RED: 5 expected failures, 20 passes (PostgreSQL opt-in tests
  skipped). GREEN: SQLite/API/diagnostic focused matrix 32/32.
- Self-review RED: diagnostic ingestion without lease identity incorrectly
  committed through the normal path. GREEN: engine 4/4 and no record persisted.

## Migration compatibility

- SQLite detects an existing `jobs` table and adds nullable `lease_token`; the
  migration test verifies a legacy queued row survives.
- PostgreSQL uses `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token text`;
  a real PostgreSQL 17 test drops the column from a populated table, reruns the
  migration, and verifies the row and nullable column.

## Verification

- Real PostgreSQL 17 repository suite: 9/9.
- SQLite repository suite: 19/19.
- Focused changed-area suites: green, including Compose 4/4, config 6/6,
  SearXNG 11/11, safe HTTP 18/18, engine 4/4, runtime/API/diagnostics.
- Full test run: 455 passed, 5 skipped; one stale SearXNG expectation was fixed.
  Three unrelated installer-smoke timing cases failed under parallel load and
  passed serially (29 passed, 1 skipped).
- `pnpm typecheck`: 15/15 packages.
- `pnpm lint`: clean.
- `pnpm build`: 15/15 packages.
- `git diff --check`: clean.

## Self-review

Checked both SQL implementations for ordering/predicate equivalence, atomic
claim behavior, migration idempotency, stale owner/token rejection, retry caps,
and diagnostic write fencing. Checked safe HTTP for duplicate closes, cleanup
rejections, stalled abort/cancel behavior, late unhandled rejections, timeout
clamping, and body limits. No unresolved Important finding remains.
