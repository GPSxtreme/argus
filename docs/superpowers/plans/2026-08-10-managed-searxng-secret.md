# Managed SearXNG Secret Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver only the derived `SEARXNG_SECRET` to managed SearXNG so current pinned images boot during one-command VPS onboarding.

**Architecture:** Keep the existing deterministic secret derivation in `renderInstanceConfig`, split its serialized payload from Argus runtime secrets, atomically persist it at `searxng/secrets.env`, and attach that file only to the managed SearXNG Compose service. Reuse the production renderers in the live container test so the release artifact path—not a hand-written test stack—is exercised.

**Tech Stack:** TypeScript, Node.js 24, Vitest, Docker Compose, SearXNG.

## Global Constraints

- Do not add a prompt or public onboarding contract field.
- Do not expose Argus, PostgreSQL, Cloudflare, or OpenRouter credentials to SearXNG.
- Write secret files atomically with mode `0600`.
- Remove stale managed SearXNG secret files when managed mode is disabled.
- Preserve digest-pinned release images and bounded health checks.

---

### Task 1: Separate and Persist the SearXNG Secret

**Files:**
- Modify: `packages/deployment/src/config.ts`
- Modify: `packages/deployment/src/files.ts`
- Test: `packages/deployment/test/config.test.ts`
- Test: `packages/deployment/test/files.test.ts`

**Interfaces:**
- Consumes: `renderInstanceConfig(answers: OnboardingAnswersV1, endpoints: InstanceEndpoints): RenderedInstanceConfig`
- Produces: `RenderedInstanceConfig.searxngSecrets?: string` and `InstancePaths.searxngSecrets: string`

- [ ] **Step 1: Write failing config tests**

Assert that managed mode returns exactly one line matching
`SEARXNG_SECRET=[a-f0-9]{64}\n`, that `rendered.secrets` excludes that name,
and disabled mode omits `searxngSecrets`.

- [ ] **Step 2: Run the config test and verify RED**

Run: `pnpm vitest run packages/deployment/test/config.test.ts`

Expected: FAIL because `searxngSecrets` is absent and the main secrets payload still contains `SEARXNG_SECRET`.

- [ ] **Step 3: Implement the render split**

Extend `RenderedInstanceConfig` with `searxngSecrets?: string`. Keep the derived
value in `secretEnvironment` for deterministic validation/hash behavior, filter
it out of `secrets`, and serialize it independently only in managed mode.

- [ ] **Step 4: Run the config test and verify GREEN**

Run: `pnpm vitest run packages/deployment/test/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing file tests**

Assert that `writeInstanceFiles` creates `searxng/secrets.env` with mode `0600`
and only the SearXNG key, includes the path in `instancePaths`, and removes a
stale file when `searxngSecrets` is absent.

- [ ] **Step 6: Run the file test and verify RED**

Run: `pnpm vitest run packages/deployment/test/files.test.ts`

Expected: FAIL because the dedicated path is not written or removed.

- [ ] **Step 7: Implement atomic dedicated-file persistence**

Add `searxngSecrets` to `instancePaths`. In `writeInstanceFiles`, atomically
write `rendered.searxngSecrets` as `0600`; otherwise unlink the stale file while
ignoring only `ENOENT`. Preserve temporary-file cleanup and directory syncing.

- [ ] **Step 8: Run focused tests and commit**

Run: `pnpm vitest run packages/deployment/test/config.test.ts packages/deployment/test/files.test.ts`

Expected: PASS.

Commit: `fix: isolate managed searxng secret`

### Task 2: Deliver the Secret Through Production Compose

**Files:**
- Modify: `packages/deployment/src/compose.ts`
- Modify: `deploy/managed/compose.fixture.yaml`
- Test: `packages/deployment/test/compose.test.ts`
- Test: `packages/deployment/test/searxng.live.test.ts`

**Interfaces:**
- Consumes: `renderCompose(input: ComposeInput): string`, `renderInstanceConfig`, `writeInstanceFiles`
- Produces: managed SearXNG service with `env_file: ./searxng/secrets.env` and no other secret source

- [ ] **Step 1: Write the failing Compose boundary test**

Parse rendered Compose and assert SearXNG has exactly one raw env file at
`searxng/secrets.env`, while Argus retains only `secrets.env`.

- [ ] **Step 2: Run the Compose test and verify RED**

Run: `pnpm vitest run packages/deployment/test/compose.test.ts`

Expected: FAIL because SearXNG has no env file.

- [ ] **Step 3: Implement minimal Compose delivery**

Add the dedicated raw env file to `searxngService` and update the committed
fixture. Do not share the root `secrets.env` with SearXNG.

- [ ] **Step 4: Run Compose tests and verify GREEN**

Run: `pnpm vitest run packages/deployment/test/compose.test.ts`

Expected: PASS, including Docker Compose parser coverage when Docker is available.

- [ ] **Step 5: Make the live test exercise production renderers**

Build the smoke stack with `renderInstanceConfig`, `writeInstanceFiles`,
`renderSearxngSettings`, and `renderCompose`; start only `searxng`; query JSON
through the private network; assert at least one result; always tear down.

- [ ] **Step 6: Run the pinned live test**

Run with the release manifest's pinned SearXNG and smoke-client image values:
`ARGUS_SEARXNG_TEST=1 pnpm vitest run packages/deployment/test/searxng.live.test.ts`

Expected: PASS with the current SearXNG image that rejected `ultrasecretkey`.

- [ ] **Step 7: Run deployment tests and commit**

Run: `pnpm vitest run packages/deployment/test`

Expected: PASS.

Commit: `test: cover managed searxng secret delivery`

### Task 3: Verify, Release, and Re-run VPS Acceptance

**Files:**
- Modify only release metadata required by the repository release workflow.
- No manual edits under `/opt/argus` are accepted as the product fix.

**Interfaces:**
- Consumes: repository release scripts and signed stable manifest
- Produces: patched stable installer/CLI release and a healthy `prudhvi-laptop` deployment

- [ ] **Step 1: Run repository gates**

Run the documented Node 24 lint, typecheck, unit, integration, release, and installer commands from `package.json` and CI workflows.

Expected: all gates pass without warnings attributable to the change.

- [ ] **Step 2: Review the diff and commit any gate-only corrections**

Run: `git diff --check && git status --short && git log --oneline main..HEAD`

Expected: only the design, plan, production fix, tests, fixture, and required release metadata differ from `main`.

- [ ] **Step 3: Publish the patched release through the repository workflow**

Follow `docs/operations.md` and repository release scripts exactly; verify the stable manifest and installer point to the new signed CLI digest.

- [ ] **Step 4: Reinstall and onboard on `prudhvi-laptop`**

Use the public `install.sh`, the movie/TV-news onboarding answers, managed SearXNG, official external FxEmbed, SQLite, and no intelligence provider.

Expected: `argus status --json` and `argus doctor --json` report healthy Argus and SearXNG services.

- [ ] **Step 5: Prove all three source families**

Trigger or wait for the `screen-news` watch and query stored/API records. Verify
at least one X record from `DiscussingFilm` or `FilmUpdates`, one Telegram record
from `mcunewsandrumors`, and one web record from Deadline URL/RSS or the managed
SearXNG query. Preserve source links in evidence and disclose any upstream
failure precisely.

- [ ] **Step 6: Restart and prove persistence**

Run `argus restart --yes --json`, repeat status/doctor, and verify previously
stored records remain queryable.

- [ ] **Step 7: Merge and push after verified acceptance**

Fast-forward the reviewed branch to `main`, push, and verify GitHub CI and web
deployment checks for the release commit.
