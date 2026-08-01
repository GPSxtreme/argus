# Biome and Husky quality gates

## Decision

Add Biome as the repository linter and Husky as the Git-hook manager.

The root scripts are:

- `pnpm lint`: run Biome lint across the repository.
- `pnpm lint:check`: run the same non-mutating lint precheck explicitly.

Hooks are intentionally balanced:

- pre-commit runs `pnpm lint`.
- pre-push runs `pnpm lint`, `pnpm typecheck`, and `pnpm test`.

## Continuous integration

Add `.github/workflows/push.yaml`, triggered by every push. It installs Node.js
24 and pnpm 10.33.0, performs a frozen install, and runs `pnpm lint`.

The existing `ci.yml` remains responsible for tests, typechecking, and builds.

## Configuration

Use one root `biome.json` with recommended lint rules. Generated output,
dependencies, coverage, local data, and worktrees are excluded. Biome is a
linter in this change; repository-wide formatting is not introduced.

Husky is installed through the root `prepare` script so a normal `pnpm install`
initializes hooks. Hook files contain only portable pnpm commands.

## Failure behavior

Any non-zero lint, typecheck, or test result blocks the applicable Git action.
Hooks do not mutate source files automatically. CI uses the same root lint
script as local development to prevent drift.

## Verification

- Install dependencies and initialize Husky.
- Run Biome lint, fixing existing lint violations.
- Execute both hook scripts directly.
- Run tests, typecheck, and build.
- Validate both GitHub workflow YAML files.
