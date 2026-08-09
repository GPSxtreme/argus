# Argus Verification and Permanent VPS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce unit coverage, first-class PostgreSQL/SearXNG integration tests, real-storage API behavior, signed-release gates, and repeatable acceptance on the permanent VPS.

**Architecture:** Keep Vitest and existing Testcontainers/Docker patterns. Separate fast deterministic checks from container-backed integration in CI, keep release matrices isolated, and use the Mac to run a non-destructive SSH acceptance harness against published releases on `vps`.

**Tech Stack:** Node.js 24.16.0, pnpm 10.33.0, Vitest 3.2, official V8 coverage, Testcontainers, PostgreSQL 17, digest-pinned SearXNG/curl, Docker Compose, GitHub Actions, SSH.

## Global Constraints

- Execute after the operator-documentation plan in an isolated worktree.
- Preserve all pre-existing modified and untracked files.
- Do not weaken or skip existing tests to pass new gates.
- PR CI must not depend on public sources, credentials, the permanent VPS, or the GPU desktop.
- Pin every CI container image by digest and bound every external operation.
- Each integration test removes its containers, networks, volumes, temporary files, and rows.
- The permanent VPS runs published signed releases only and retains its data.
- Never request, print, store, or transmit the VPS sudo password.
- The GPU desktop remains untouched.

---

### Task 1: Add official coverage and explicit source boundaries

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.config.ts`
- Create: `vitest.critical.config.ts`
- Create: `test/coverage/source-boundary.test.ts`

**Interfaces:**
- Consumes: all `apps/*/src` and `packages/*/src` modules.
- Produces: `test:unit`, `test:coverage`, and `test:coverage:critical`.

- [ ] **Step 1: Write the source-boundary test**

Recursively inventory TypeScript implementation files and assert critical modules remain included:

```ts
expect(sourceFiles).toEqual(expect.arrayContaining([
  "packages/config/src/schema.ts",
  "packages/contracts/src/storage.ts",
  "packages/engine/src/ingest.ts",
  "packages/query/src/service.ts",
  "packages/scheduler/src/scheduler.ts",
  "packages/storage-postgres/src/repo.ts",
  "packages/storage-sqlite/src/repo.ts",
  "apps/argus/src/app.ts",
  "apps/cli/src/program.ts",
]));
```

- [ ] **Step 2: Verify the existing baseline**

```bash
pnpm vitest run test/coverage/source-boundary.test.ts
pnpm test
```

Expected: existing tests pass before coverage changes.

- [ ] **Step 3: Install the matching official provider**

```bash
pnpm add -Dw @vitest/coverage-v8@^3.2.0
```

- [ ] **Step 4: Configure broad coverage**

Add to the root Vitest configuration:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "json-summary", "html"],
  reportsDirectory: "coverage/all",
  include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
  exclude: ["**/*.d.ts", "**/dist/**", "apps/web/.source/**"],
  all: true,
},
```

Add scripts:

```json
{
  "test:unit": "vitest run --exclude '**/*.live.test.ts' --exclude 'test/integration/**'",
  "test:coverage": "vitest run --coverage --exclude '**/*.live.test.ts' --exclude 'test/integration/**'",
  "test:coverage:critical": "vitest run --config vitest.critical.config.ts --coverage"
}
```

Run the broad command once and set global thresholds to the integer floors reported in `coverage/all/coverage-summary.json`; never lower them in the same PR.

- [ ] **Step 5: Enforce critical-package thresholds**

The critical config includes configuration, contracts, engine, query, scheduler, and both storage packages with:

```ts
thresholds: {
  lines: 85,
  statements: 85,
  functions: 85,
  branches: 75,
},
```

Run:

```bash
pnpm test:coverage
pnpm test:coverage:critical
```

Expected: PASS. Add behavior-focused tests for gaps; do not exclude source or add ignore comments.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts vitest.critical.config.ts test/coverage apps packages
git commit -m "test: enforce unit coverage boundaries"
```

### Task 2: Create non-skipping PostgreSQL and SearXNG integration gates

**Files:**
- Create: `test/integration/storage-parity.test.ts`
- Create: `test/integration/searxng-runtime.test.ts`
- Modify: `packages/storage-postgres/test/repository.test.ts`
- Modify: `packages/storage-sqlite/test/repository.test.ts`
- Modify: `packages/deployment/test/searxng.live.test.ts`
- Modify only if tests prove defects: `packages/storage-postgres/src/repo.ts`
- Modify only if tests prove defects: `packages/storage-sqlite/src/repo.ts`

**Interfaces:**
- Consumes: `StorageRepository`, both repository factories, managed SearXNG renderer, Web search adapter.
- Produces: deterministic adapter parity and private-network search integration.

- [ ] **Step 1: Write a backend-agnostic storage suite**

Use:

```ts
interface RepositoryFixture {
  name: "sqlite" | "postgres";
  create(): Promise<StorageRepository>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
```

Run identical tests for create/duplicate/revision counts, literal `%` and `_` search, filters, cursor pagination during inserts, artifacts, diagnostic isolation, checkpoints, leases, and cleanup. UUID-scope every ID.

- [ ] **Step 2: Add concurrent-write contracts**

Run 20 simultaneous first inserts and assert one created result, nineteen duplicates, one record, and one revision. Run competing distinct hashes and assert unique revisions and a complete final row. Add equivalent public-result assertions for SQLite.

- [ ] **Step 3: Run and record the first mismatch**

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
pnpm vitest run test/integration/storage-parity.test.ts \
  packages/storage-postgres/test/repository.test.ts \
  packages/storage-sqlite/test/repository.test.ts
```

Expected: record any mismatch before changing implementation.

- [ ] **Step 4: Apply only proven storage corrections**

Use one atomic PostgreSQL `INSERT ... ON CONFLICT ... WHERE content_hash IS DISTINCT FROM ... RETURNING` path for single and batch writes. Reuse unique revision constraints. Batch SQLite artifact visibility queries instead of querying once per record ID. Add no migration unless a failing test proves it necessary.

- [ ] **Step 5: Make SearXNG requested integration fail instead of skip**

When `ARGUS_SEARXNG_TEST=1`, missing Docker, invalid references, absent images, or failed health must throw. Local runs without the flag may skip:

```ts
if (enabled && reason) throw new Error(reason);
if (!enabled) return context.skip("Set ARGUS_SEARXNG_TEST=1 to run Docker integration.");
```

The runtime test starts managed private/egress networks, calls SearXNG through the pinned curl container, invokes the actual Web search normalization, and always runs Compose down with volumes in `finally`.

- [ ] **Step 6: Run exact pinned integration**

```bash
docker pull docker.io/searxng/searxng@sha256:ec536bcd1e83577aad4cc07f7ecb9a30858a9a905d2d57c8796abc83f872a036
docker pull docker.io/curlimages/curl@sha256:9a1ed35addb45476afa911696297f8e115993df459278ed036182dd2cd22b67b
ARGUS_SEARXNG_TEST=1 \
ARGUS_SEARXNG_IMAGE=docker.io/searxng/searxng@sha256:ec536bcd1e83577aad4cc07f7ecb9a30858a9a905d2d57c8796abc83f872a036 \
ARGUS_SEARXNG_SMOKE_CLIENT_IMAGE=docker.io/curlimages/curl@sha256:9a1ed35addb45476afa911696297f8e115993df459278ed036182dd2cd22b67b \
pnpm vitest run packages/deployment/test/searxng.live.test.ts test/integration/searxng-runtime.test.ts
```

Expected: PASS and no test containers remain.

- [ ] **Step 7: Repeat and commit**

Run storage and search integrations three times, then:

```bash
git add test/integration packages/storage-postgres packages/storage-sqlite packages/deployment/test/searxng.live.test.ts
git commit -m "test: enforce storage and search integration"
```

### Task 3: Test authenticated API and runtime roles with real PostgreSQL

**Files:**
- Create: `test/integration/api-postgres.test.ts`
- Create: `test/integration/runtime-roles.test.ts`
- Modify only if tests prove defects: `apps/argus/src/app.ts`
- Modify only if tests prove defects: `apps/argus/src/runtime.ts`
- Modify only if tests prove defects: `apps/argus/src/worker.ts`
- Modify only if tests prove defects: `apps/argus/src/processor.ts`

**Interfaces:**
- Consumes: `createApp`, PostgreSQL repository, runtime role constructors, deterministic local source/OpenRouter fixtures.
- Produces: real-storage API and multi-role coordination coverage.

- [ ] **Step 1: Write authenticated API integration**

Assert public health, rejection of missing/wrong tokens for every `/v1/*` route, repeated filters, ISO bounds, literal text search, stable cursors, watch enqueueing, artifact visibility, and stable `400` errors for malformed management, cursor, timestamp, and limit inputs.

- [ ] **Step 2: Run and record failures**

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
pnpm vitest run test/integration/api-postgres.test.ts
```

- [ ] **Step 3: Write multi-role orchestration**

Start API, scheduler, two workers, and one processor against UUID-scoped PostgreSQL state and local fixtures. Enqueue one watch; assert one lease owner, one stored record, one summary artifact, and clean shutdown with no timers, leases, or connections.

- [ ] **Step 4: Make the smallest corrections**

Reuse existing constructors and dependency injection. Do not introduce a new runtime abstraction unless a failing interface contract makes it unavoidable.

- [ ] **Step 5: Repeat and commit**

```bash
for run in 1 2 3; do
  TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
  pnpm vitest run test/integration/api-postgres.test.ts test/integration/runtime-roles.test.ts || exit 1
done
git add test/integration apps/argus/src
git commit -m "test: verify API and runtime roles with postgres"
```

### Task 4: Separate quality, unit, integration, and release CI

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Delete: `.github/workflows/push.yaml`
- Modify: `.github/workflows/release.yml`
- Modify: `packages/release/test/workflows.test.ts`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: Tasks 1–3 commands.
- Produces: named PR checks and layered pre-publication release checks.

- [ ] **Step 1: Write failing workflow contracts**

Require jobs named `quality`, `unit`, and `integration`. Require quality to run lint/typecheck/build, unit to run both coverage commands, integration to run `pnpm test:integration`, all with Node 24.16.0, frozen installs, pinned actions, and timeouts. Require release verification before image publication.

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/release/test/workflows.test.ts
```

Expected: FAIL against the current single `verify` job.

- [ ] **Step 3: Add the integration script**

```json
{
  "test:integration": "vitest run test/integration packages/storage-postgres/test/repository.test.ts packages/deployment/test/searxng.live.test.ts"
}
```

- [ ] **Step 4: Rewrite CI**

Use:
- `quality`: 15 minutes, lint → typecheck → build;
- `unit`: 15 minutes, broad and critical coverage;
- `integration`: 20 minutes, healthy PostgreSQL service, Docker, pulled pinned SearXNG/curl, integration command.

Set exact integration environment:

```yaml
TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
ARGUS_POSTGRES_TEST: "1"
ARGUS_SEARXNG_TEST: "1"
ARGUS_SEARXNG_IMAGE: docker.io/searxng/searxng@sha256:ec536bcd1e83577aad4cc07f7ecb9a30858a9a905d2d57c8796abc83f872a036
ARGUS_SEARXNG_SMOKE_CLIENT_IMAGE: docker.io/curlimages/curl@sha256:9a1ed35addb45476afa911696297f8e115993df459278ed036182dd2cd22b67b
```

Delete the redundant push-lint workflow rather than keeping duplicate checks.

- [ ] **Step 5: Gate release publication**

Before image push, run lint, typecheck, both coverage commands, integration, and build. Preserve signing, digest generation, installer matrix, and immutable tag identity. Document the distinction between disposable installer smoke, disposable VPS smoke, and the permanent SSH VPS.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run packages/release/test/workflows.test.ts
pnpm lint
git add package.json .github/workflows packages/release/test/workflows.test.ts docs/operations.md
git commit -m "ci: enforce layered verification"
```

### Task 5: Add a non-destructive permanent-VPS acceptance harness

**Files:**
- Create: `scripts/e2e/permanent-vps-acceptance.sh`
- Create: `packages/release/test/permanent-vps-acceptance.test.ts`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: local SSH alias `vps`, stable signed manifest, installed released CLI.
- Produces: sanitized acceptance evidence without deleting persistent records.

- [ ] **Step 1: Write failing safety tests**

Require:

```ts
for (const required of [
  "set -eu", "ARGUS_VPS_HOST", "ARGUS_EXPECTED_VERSION",
  "argus status --json", "argus doctor --json",
  "argus config apply --dry-run --json", "argus update --dry-run --json",
]) expect(source).toContain(required);

for (const forbidden of [
  "rm -rf", "docker system prune", "docker volume prune",
  "docker compose down -v", "cat /opt/argus/secrets.env",
]) expect(source).not.toContain(forbidden);
```

Require default host `vps`, an explicit expected version, local `mktemp -d` evidence with mode `0700`, bounded SSH, and token/secret redaction.

- [ ] **Step 2: Verify failure**

```bash
pnpm vitest run packages/release/test/permanent-vps-acceptance.test.ts
```

- [ ] **Step 3: Implement inspect-only default**

Verify the stable signature locally, known-host SSH identity, OS/architecture/disk, Docker, installed version, status, doctor, published ports, and backup metadata. Default mode must never run sudo, install, onboard, apply, update, rollback, restart, or repair.

- [ ] **Step 4: Add explicit phases**

Support exactly:

```text
inspect
verify-ingestion
verify-restart
verify-backup
plan-update
```

Non-inspect phases require `ARGUS_VPS_ALLOW_MUTATION=1`, print the exact plan, and affect only the controlled watch or normal Argus lifecycle. Rollback remains dry-run only.

- [ ] **Step 5: Document privileged bootstrap**

The user—not the agent—runs:

```bash
ssh -t vps 'curl -fsSL https://argus.gpsxtre.me/install.sh | sudo sh'
```

Precede it with inspect-first instructions. Never pass the sudo password through chat, stdin automation, an environment variable, or a file.

- [ ] **Step 6: Test fake-SSH scenarios**

Test healthy, wrong-version, unhealthy, unexpected-port, timeout, and redaction fixtures without contacting the VPS:

```bash
pnpm vitest run packages/release/test/permanent-vps-acceptance.test.ts
sh -n scripts/e2e/permanent-vps-acceptance.sh
```

- [ ] **Step 7: Commit**

```bash
git add scripts/e2e/permanent-vps-acceptance.sh packages/release/test/permanent-vps-acceptance.test.ts docs/operations.md
git commit -m "test: add permanent VPS acceptance"
```

### Task 6: Verify, merge, and prove the published release on `vps`

**Files:**
- Modify only files owned by the focused failing task when evidence proves a defect.
- Do not commit coverage output, acceptance evidence, secrets, or VPS data.

**Interfaces:**
- Consumes: every previous task and the latest stable signed release.
- Produces: green PR evidence and one healthy persistent Argus instance.

- [ ] **Step 1: Run all Mac gates**

```bash
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm test:coverage:critical
pnpm test:integration
pnpm build
pnpm --filter @argus/web check:links
pnpm --filter @argus/web exec lhci autorun --config=lighthouserc.json
```

Expected: PASS with no skipped PostgreSQL or SearXNG integration.

- [ ] **Step 2: Push and merge through PR**

Use branch `test/layered-verification`. Require quality, unit, integration, and web/docs checks. Keep the PR description lean and merge only after green checks.

- [ ] **Step 3: Run disposable release workflows**

```bash
gh workflow run installer-smoke.yml -f release_tag="$ARGUS_STABLE_TAG"
gh workflow run vps-smoke.yml -f release_tag="$ARGUS_STABLE_TAG" -f controlled_web_url=https://argus.gpsxtre.me/
```

Expected: all candidate and matrix jobs pass.

- [ ] **Step 4: Request the one user-run privileged bootstrap if Argus is absent**

Continue only after `ssh vps 'argus --version'` succeeds. Never ask for the sudo password.

- [ ] **Step 5: Onboard the permanent instance**

Use SQLite, managed SearXNG, a controlled Web watch for `https://argus.gpsxtre.me/`, and a token entered through the CLI hidden prompt. Show the plan before approval. Leave X, Telegram, and OpenRouter disabled until real targets or credentials are supplied.

- [ ] **Step 6: Run acceptance**

```bash
ARGUS_EXPECTED_VERSION="$ARGUS_STABLE_VERSION" scripts/e2e/permanent-vps-acceptance.sh inspect
ARGUS_EXPECTED_VERSION="$ARGUS_STABLE_VERSION" ARGUS_VPS_ALLOW_MUTATION=1 scripts/e2e/permanent-vps-acceptance.sh verify-ingestion
ARGUS_EXPECTED_VERSION="$ARGUS_STABLE_VERSION" ARGUS_VPS_ALLOW_MUTATION=1 scripts/e2e/permanent-vps-acceptance.sh verify-restart
ARGUS_EXPECTED_VERSION="$ARGUS_STABLE_VERSION" ARGUS_VPS_ALLOW_MUTATION=1 scripts/e2e/permanent-vps-acceptance.sh verify-backup
ARGUS_EXPECTED_VERSION="$ARGUS_STABLE_VERSION" ARGUS_VPS_ALLOW_MUTATION=1 scripts/e2e/permanent-vps-acceptance.sh plan-update
```

Expected: controlled record queryable with source URL, restart persistence, backup metadata present, update plan valid, and no unintended port exposed.

- [ ] **Step 7: Leave the VPS healthy and report sanitized evidence**

Report release version, service health, enabled source categories, controlled record count, and exposed Argus ports. Do not report tokens, secret values, private records, Docker auth, or key paths.
