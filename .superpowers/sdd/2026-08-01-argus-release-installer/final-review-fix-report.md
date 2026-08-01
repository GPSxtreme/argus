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

## Credential persistence follow-up

Date: 2026-08-02

Verified and fixed a narrow security follow-up in managed PostgreSQL config
reconciliation:

- The live resolved PostgreSQL URL remains unchanged and is passed in full to
  the PostgreSQL repository.
- Applied config and redacted YAML retain only the credential-free URL endpoint.
  The same structural protection covers credential-bearing source URLs.
- Credential changes remain detectable through a domain-separated HMAC-SHA256
  fingerprint keyed by the live API token. The token and URL credentials are
  absent from `applied_config`, public plan hashes, management responses, and
  redacted serialization, so the public hash is not an offline password oracle.
- A credential-bearing config without an independent API-token key fails closed
  with a static error that contains no credential material.
- SQLite and URLs without credentials retain their prior persistence and hash
  behavior.

TDD evidence:

- Initial RED: 2 failures and 6 passes proved the percent-encoded reserved
  password leaked through `reconcileConfig` persistence and
  `serializeRedactedConfig`.
- Oracle RED: different hidden API-token peppers produced the same public hash.
  GREEN proves different peppers produce different hashes and missing peppers
  fail closed without secret-bearing errors.
- Focused config/runtime/management/storage matrix: 39 passed; 9 opt-in
  PostgreSQL tests skipped.
- Real PostgreSQL 17 reserved-credential probe: first reconcile changed, second
  was idempotent, persisted URL was credential-free, and the live URL remained
  unchanged.
- Full suite: 451 passed and 14 skipped before four unrelated release-installer
  timing failures under file-parallel load. Serial reruns passed 42/42 and
  29/29 with one smoke test skipped.
- Node 24 typecheck and build: 15/15 packages. Lint and `git diff --check`:
  clean.

### PostgreSQL query-credential follow-up

Verified the installed `pg` 8.22 / `pg-connection-string` 2.14 behavior:
lowercase query `user` and `password` override authority credentials when
truthy, exact-key duplicates are last-wins, empty query values fall back to
authority, and case variants are ignored by `pg`.

The PostgreSQL projection now:

- removes authority credentials and every case-insensitive `user`/`password`
  query occurrence from persistence and redacted output;
- fingerprints only the effective lowercase credentials accepted by `pg`, so
  effective user/password changes reconcile while shadowed duplicates and
  ignored case variants do not;
- preserves safe query parameters and their order, including `sslmode` and
  `application_name`;
- keeps the complete live URL byte-for-byte for the PostgreSQL driver; and
- retains the independent API-token-keyed HMAC and static no-key failure.

TDD and verification:

- RED: 2 failures and 9 passes reproduced query-password/user leakage through
  applied config and redacted YAML.
- GREEN security matrix: 39 passed; 9 opt-in PostgreSQL tests skipped.
- Real PostgreSQL 17 accepted a reserved-character password supplied only via
  the query string. First reconciliation changed, the second was idempotent,
  the persisted URL retained only safe parameters, and the live URL was
  unchanged.
- Node 24 typecheck/build: 15/15 packages; lint and diff checks clean.
