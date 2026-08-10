# Task 5 report: synchronize deployed image metadata

## Implementation

- Added one `stateForRelease` transformation shared by update and rollback state writes.
- It derives the three managed image references directly from the verified signed release, updates only managed service entries, and preserves unrelated service entries and deployment metadata.
- Both `compose.images` and managed `services.*.image` now record the exact release references after update and rollback.
- Management-state promotion was left outside the deployment package.

## TDD evidence

- RED: `fnm exec --using 24.19.0 -- pnpm vitest run packages/deployment/test/update.test.ts` failed because managed service images remained stale and the unrelated service health was overwritten.
- GREEN: the same test command passed all 14 update-state tests after the shared transformation was added.

## Verification

- `fnm exec --using 24.19.0 -- sh -c 'pnpm vitest run packages/deployment/test/update.test.ts && pnpm typecheck'`
- `git diff --check`

## Fix round 1

- `stateForRelease` now requires Compose state and always writes exact managed Compose image metadata; it no longer has a compose-less compatibility branch.
- Added a rollback regression that removes `backup.state.compose` from persisted update state, requires `UPDATE_STATE_UNAVAILABLE`, and verifies the deployment state file is not written.
- RED: `fnm exec --using 24.19.0 -- pnpm vitest run packages/deployment/test/update.test.ts` resolved rollback successfully before the fix.
- GREEN: the same command passed all 15 update-state tests after the Compose-state invariant was enforced.
