# Task 7 report: durable launcher lifecycle smoke coverage

## Implementation

- The VPS workflow now resolves the requested immutable signed release as the
  stable update target and the latest prior stable release as the installed
  baseline. It verifies that the public stable manifest bytes are the exact
  requested candidate before creating the disposable host.
- VPS smoke parses canonical `management.state`, records
  `sha256sum /usr/local/bin/argus` before `argus update --json --yes`, and
  requires the exact target version and CLI image to replace distinct baseline
  values while the launcher checksum remains identical.
- The local update fixture injects an interrupted management-state promotion,
  retries the healthy no-op recovery path, and verifies a canonical target
  state with no temporary files.

## TDD evidence

- RED: the focused VPS lifecycle test failed because the harness had no update
  candidate inputs or lifecycle assertions.
- GREEN: after the candidate and harness changes, the focused lifecycle test
  passed.

## Verification

- Node 24: `pnpm vitest run apps/cli/test/integrations.test.ts packages/release/test/workflows.test.ts` — 34 passed.
- Node 24: `packages/release/test/installer-smoke.test.ts` completed in
  bounded groups because the desktop foreground cap interrupts the full
  30+ second fixture file: 33 passed, 1 platform-conditional skip.
- Node 24: Biome checks for all changed TypeScript tests — passed.
- Node 24: `pnpm --filter @argus/cli typecheck` and
  `pnpm --filter @argus/release typecheck` — passed.
- `sh -n scripts/e2e/vps-smoke.sh` and `git diff --check` — passed.

## Scope

No real VPS or GPU host was accessed. The interrupted-promotion injection is
confined to the local CLI fixture.
