# Task 4 report: promote verified management releases

## Implementation

- Added `promoteManagementRelease(VerifiedReleaseManifest)` to the production update integration.
- The method validates the exact fetched verified release, derives management state with `managementStateForRelease`, and atomically writes it to `join(root, basename(MANAGEMENT_WRAPPER_REQUIREMENTS.stateFile))`.
- Update application stages signed context, applies and health-verifies the deployment, promotes signed context, then promotes management state.

## Coverage

- Ordered lifecycle coverage includes signed-context staging, backup, pull, migrate, reconcile, health, deployment-state save, signed-context promotion, and management-state promotion.
- Added verified-release-only management state coverage, healthy no-op stale-state repair, unhealthy no-op refusal, and no-final-verification cases for failures before and during management promotion.

## Verification

- `fnm exec --using 24.19.0 pnpm vitest run apps/cli/test/integrations.test.ts apps/cli/test/program.test.ts`
- `fnm exec --using 24.19.0 pnpm typecheck`
- `fnm exec --using 24.19.0 pnpm exec biome check apps/cli/src/integrations.ts apps/cli/src/program.ts apps/cli/test/integrations.test.ts apps/cli/test/program.test.ts`

## Fix round 1 evidence

- RED: `fnm exec --using 24.19.0 pnpm vitest run apps/cli/test/integrations.test.ts apps/cli/test/program.test.ts` reported two failures: a cloned release with the original manifest hash and a swapped valid CLI digest reached management-state validation, and the atomic-writer failure case resolved because no writer seam existed.
- GREEN: after full canonical manifest identity comparison, deriving management state from the stored fetched release, and adding the injected atomic writer seam, the same command passed 47 tests across 2 files.
- Final checks: `fnm exec --using 24.19.0 pnpm typecheck`, `fnm exec --using 24.19.0 pnpm lint`, and `git diff --check` completed successfully.
