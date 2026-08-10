# Durable Management Launcher Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `/usr/local/bin/argus` an immutable, release-independent launcher whose selected signed management release is controlled by a strict, atomically promoted `/opt/argus/management.state` file.

**Architecture:** The release package defines one canonical management-state contract and renders a launcher that only validates local state and `exec`s a digest-pinned CLI image. The signed installer bootstraps the launcher and state as one recoverable transaction. The CLI update integration promotes verified release context and management state in the designed order, while deployment update code keeps both Compose and service image metadata exact.

**Tech Stack:** TypeScript 6, Node.js 24, POSIX `sh`, Vitest, Zod, Docker Compose v2, pnpm/Turborepo.

---

## Contract and file map

- Modify: `packages/contracts/src/management-wrapper.ts`
  - Add `stateFile: "/opt/argus/management.state"`, `stateSchema: 1`, and `maximumStateBytes` to the shared data-only host boundary.
- Create: `packages/release/src/management-state.ts`
  - Export `ManagementStateV1`, `managementStateForRelease`, `parseManagementState`, `serializeManagementState`, and `writeManagementStateAtomic`.
- Modify: `packages/release/src/index.ts`
  - Export the management-state module.
- Modify: `packages/release/src/wrapper.ts`
  - Remove `ArgusWrapperOptions`; replace `renderArgusWrapper(options)` with deterministic `renderArgusWrapper()`.
- Modify: `packages/release/src/installer.ts`
  - Bootstrap exact state from the verified manifest, validate the durable wrapper, and transactionally install both files.
- Modify: `scripts/release/create-manifest.ts`, `scripts/release/export-wrapper.ts`
  - Stop supplying release-specific values to the wrapper renderer.
- Modify: `apps/cli/src/integrations.ts`, `apps/cli/src/program.ts`
  - Stage verified context, promote context after runtime health, promote management state last, and repair it on a healthy no-op update.
- Modify: `packages/deployment/src/update.ts`
  - Keep `services.*.image` synchronized with the signed release, including rollback.
- Modify tests in `packages/release/test/`, `apps/cli/test/`, `packages/deployment/test/`, and `scripts/e2e/vps-smoke.sh`.
- Modify operator docs only where the launcher/update behavior is described.

The release-layer API must settle on these shapes:

```ts
export interface ManagementStateV1 {
  schema: 1;
  version: string;
  cliImage: `${string}@sha256:${string}`;
}

export const managementStateForRelease = (
  release: VerifiedReleaseManifest,
): ManagementStateV1 => ({
  schema: 1,
  version: release.manifest.version,
  cliImage: release.manifest.images.cli.reference,
});

export function parseManagementState(source: string): ManagementStateV1;
export function serializeManagementState(state: ManagementStateV1): string;
export async function writeManagementStateAtomic(
  path: string,
  state: ManagementStateV1,
): Promise<void>;
export function renderArgusWrapper(): string;
```

The only accepted bytes are:

```text
schema=1
version=<normalized SemVer>
cli_image=<credential-free canonical image>@sha256:<64 lowercase hex>
```

with exactly one trailing newline and no additional lines or whitespace.

### Task 1: Establish the management-state contract

**Files:**
- Modify: `packages/contracts/src/management-wrapper.ts`
- Create: `packages/release/src/management-state.ts`
- Modify: `packages/release/src/index.ts`
- Create: `packages/release/test/management-state.test.ts`

- [ ] **Step 1: Write failing parser/serializer tests**

Cover the exact three-line happy path, deterministic serialization, normalized SemVer, digest-pinned credential-free image references, missing/extra/reordered/duplicate keys, CRLF, blank lines, leading/trailing whitespace, uppercase digest, credentials, tags without digest, NUL bytes, oversize input, and wrong schema.

```ts
expect(parseManagementState(valid)).toEqual({
  schema: 1,
  version: "0.1.13",
  cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${"a".repeat(64)}`,
});
expect(() => parseManagementState(`${valid}extra=x\n`)).toThrow(
  "management state",
);
```

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run packages/release/test/management-state.test.ts`

Expected: FAIL because the module and contract fields do not exist.

- [ ] **Step 3: Implement the smallest strict parser and serializer**

Use the existing normalized SemVer and pinned-reference primitives instead of a second permissive grammar. Compare re-serialization byte-for-byte after parsing so alternate encodings cannot pass.

- [ ] **Step 4: Add atomic writer tests and implementation**

Inject or expose only the minimum filesystem seam necessary to verify: mode `0644`, temp file in the same directory, file fsync before rename, directory fsync after rename, cleanup on pre-rename failure, and old state preserved on failure. Reject a symlink target before opening or replacing it.

- [ ] **Step 5: Run GREEN and commit**

Run: `pnpm vitest run packages/release/test/management-state.test.ts && pnpm typecheck`

Expected: PASS.

Commit: `git commit -am "feat: add management state contract"`

### Task 2: Render one durable launcher

**Files:**
- Modify: `packages/release/src/wrapper.ts`
- Modify: `packages/release/test/wrapper.test.ts`
- Modify: `scripts/release/create-manifest.ts`
- Modify: `scripts/release/export-wrapper.ts`

- [ ] **Step 1: Replace release-specific wrapper tests with durable-state tests**

Assert two renderer calls return identical bytes without arguments. Execute the generated shell against a fake Docker binary and temporary fixture state. Cover argument fidelity, spaces/quotes/empty strings, TTY/no-TTY, all required mounts and hardening flags, `ARGUS_VERSION`, the exact pinned image, inspect mode, unsupported architecture, Docker/socket errors, and signal/exit propagation.

- [ ] **Step 2: Add hostile host-file tests**

The shell must reject missing state, symlink state, oversize state, wrong mode/file type where applicable, and every malformed case from Task 1 before invoking Docker. It must never `.`/`source`/`eval` the state.

```sh
argus_state=/opt/argus/management.state
[ -f "$argus_state" ] && [ ! -L "$argus_state" ] || argus_state_error
[ "$(wc -c < "$argus_state")" -le 1024 ] || argus_state_error
IFS= read -r argus_schema < "$argus_state" || argus_state_error
IFS= read -r argus_version <&3 || argus_state_error
IFS= read -r argus_cli_image <&3 || argus_state_error
```

Use a single file descriptor/read sequence that detects fourth lines and missing terminal newline; do not use `eval`, command interpolation of file contents, or general key/value parsing.

- [ ] **Step 3: Run RED**

Run: `pnpm vitest run packages/release/test/wrapper.test.ts`

Expected: FAIL because the wrapper still embeds version/image and accepts renderer options.

- [ ] **Step 4: Implement the durable shell and remove obsolete API paths**

Delete `ArgusWrapperOptions` and all release-specific renderer arguments. Update both release scripts to call `renderArgusWrapper()` only. Preserve `exec docker` so signals and exit codes flow through unchanged.

- [ ] **Step 5: Run GREEN and commit**

Run: `pnpm vitest run packages/release/test/wrapper.test.ts && pnpm typecheck`

Expected: PASS.

Commit: `git commit -am "feat: make management launcher durable"`

### Task 3: Bootstrap launcher and state transactionally

**Files:**
- Modify: `packages/release/src/installer.ts`
- Modify: `packages/release/test/installer.test.ts`
- Modify: `packages/release/test/installer-smoke.test.ts`

- [ ] **Step 1: Add installer RED tests**

Assert the installer derives state only from the already verified manifest, installs `/opt/argus/management.state` as `0644`, validates the temporary launcher against temporary state, refuses symlinked targets/root/state, and preserves the complete prior launcher+state pair on every injected failure. Assert rerunning the same installer is idempotent.

- [ ] **Step 2: Add the one-time legacy replacement test**

Given a recognized schema-1 release-specific Argus wrapper, the installer may replace it once with the durable signed wrapper. An unrelated target still fails closed. Do not retain a runtime fallback for legacy wrappers.

- [ ] **Step 3: Run RED**

Run: `pnpm vitest run packages/release/test/installer.test.ts packages/release/test/installer-smoke.test.ts`

Expected: FAIL because no management state is installed and wrapper identity remains release-specific.

- [ ] **Step 4: Implement recoverable pair installation**

Create and fsync a temporary management state within `/opt/argus`, test the temporary wrapper with an explicit fixture-only state path hook, preserve prior files, then rename state and launcher with directory syncs. If any promotion or post-promotion verification fails, restore both prior files before exiting. Keep the production state path fixed.

- [ ] **Step 5: Verify installed state and immutable wrapper identity**

After install, execute `argus --version`, compare to the signed manifest version, parse the installed state exactly, and ensure the installed launcher checksum matches the signed wrapper asset.

- [ ] **Step 6: Run GREEN and commit**

Run: `pnpm vitest run packages/release/test/installer.test.ts packages/release/test/installer-smoke.test.ts`

Expected: PASS.

Commit: `git commit -am "feat: bootstrap durable management launcher"`

### Task 4: Promote verified management releases during update

**Files:**
- Modify: `apps/cli/src/integrations.ts`
- Modify: `apps/cli/src/program.ts`
- Modify: `apps/cli/test/integrations.test.ts`
- Modify the focused CLI program test file selected by `rg -n "applyUpdate|promoteCurrentRelease" apps/cli/test`

- [ ] **Step 1: Write ordered lifecycle RED tests**

Capture events and require this order for a non-noop update:

```ts
expect(events).toEqual([
  "stage-release-context",
  "backup",
  "pull",
  "migrate",
  "reconcile",
  "health",
  "save-deployment-state",
  "promote-release-context",
  "promote-management-state",
]);
```

Add failures immediately before management promotion and during management promotion. In both cases the old management state must remain selected and the update must not report final verification.

- [ ] **Step 2: Add no-op repair RED tests**

A healthy deployment already matching the signed release must repair missing or stale management state. An unhealthy no-op must not promote it.

- [ ] **Step 3: Run RED**

Run: `pnpm vitest run apps/cli/test/integrations.test.ts <focused-program-test>`

Expected: FAIL because the integration has only signed-context staging/promotion.

- [ ] **Step 4: Implement explicit promotion methods**

Extend `ProductionUpdateIntegration` with a management promotion operation that accepts only `VerifiedReleaseManifest` and calls `writeManagementStateAtomic`. Keep signed-context promotion and management-state promotion separate so program ordering is visible and testable.

```ts
await updateIntegration.stageCurrentRelease(plan.release);
const applied = await applyUpdate({ root, plan, executor });
assertHealthy(applied);
await updateIntegration.promoteCurrentRelease(plan.release);
await updateIntegration.promoteManagementRelease(plan.release);
```

Do not write management state from raw CLI flags, remote bytes, or deployment state.

- [ ] **Step 5: Run GREEN and commit**

Run: `pnpm vitest run apps/cli/test/integrations.test.ts <focused-program-test> && pnpm typecheck`

Expected: PASS.

Commit: `git commit -am "feat: promote verified management releases"`

### Task 5: Keep deployment image metadata exact across update and rollback

**Files:**
- Modify: `packages/deployment/src/update.ts`
- Modify: `packages/deployment/test/update.test.ts`

- [ ] **Step 1: Add stale-service-image RED tests**

After update, assert `state.compose.images.{argus,postgres,searxng}` and the corresponding `state.services.*.image` values all equal the signed target references. After rollback, assert all values equal the restored signed rollback references. Preserve unrelated service metadata.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run packages/deployment/test/update.test.ts`

Expected: FAIL because update currently marks services healthy without replacing their image values.

- [ ] **Step 3: Implement one exact state transformation**

Use a focused helper that maps managed service names to the release manifest references and is shared by update/rollback state writes. Avoid a compatibility branch for stale state.

- [ ] **Step 4: Run GREEN and commit**

Run: `pnpm vitest run packages/deployment/test/update.test.ts && pnpm typecheck`

Expected: PASS.

Commit: `git commit -am "fix: synchronize deployed image metadata"`

### Task 6: Lock release artifacts to the immutable launcher

**Files:**
- Modify: the focused release builder/manifest tests found with `rg -n "wrapper.sha256|renderArgusWrapper" packages/release/test scripts`
- Modify: release scripts only if uncovered in Task 2

- [ ] **Step 1: Add cross-release identity test**

Build two manifests with different versions and CLI image digests, then assert their wrapper asset bytes and SHA-256 are identical while their signed manifests and management states differ.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run packages/release/test`

Expected: FAIL if any release path still renders version/image into wrapper bytes.

- [ ] **Step 3: Remove remaining release-specific wrapper generation**

There must be exactly one renderer call shape in the repository: `renderArgusWrapper()`.

- [ ] **Step 4: Run GREEN and commit**

Run: `pnpm vitest run packages/release/test`

Expected: PASS.

Commit: `git commit -am "test: lock launcher identity across releases"`

### Task 7: Extend clean-host and VPS acceptance coverage

**Files:**
- Modify: `scripts/e2e/vps-smoke.sh`
- Modify: the CI workflow invoking VPS smoke, if its assertions need new outputs

- [ ] **Step 1: Capture launcher checksum before update**

The smoke must record `sha256sum /usr/local/bin/argus`, parse `/opt/argus/management.state`, run the signed update, then assert the launcher checksum is unchanged while state version/image advance together.

- [ ] **Step 2: Add interrupted-promotion recovery assertion**

Use the existing fixture/failure-injection mechanism in local smoke tests. Do not corrupt the real VPS. Verify retry converges to one valid state with no temp files.

- [ ] **Step 3: Run local smoke tests**

Run: `pnpm vitest run packages/release/test/installer-smoke.test.ts && sh -n scripts/e2e/vps-smoke.sh`

Expected: PASS.

- [ ] **Step 4: Commit**

Commit: `git commit -am "test: verify durable launcher lifecycle"`

### Task 8: Update operator documentation and run complete verification

**Files:**
- Modify only docs found by `rg -n "install.sh|argus update|/usr/local/bin/argus|wrapper" README.md apps docs`

- [ ] **Step 1: Document the observable contract**

Explain in plain language: installer is required once to move from the legacy wrapper; future `argus update` advances the signed management state without replacing `/usr/local/bin/argus`; missing/malformed management state fails closed; rerunning the installer repairs bootstrap state.

- [ ] **Step 2: Run spec-coverage review**

Check every requirement in `docs/superpowers/specs/2026-08-10-durable-management-launcher-design.md` against code/tests. Search for placeholder implementations and obsolete APIs:

```sh
rg -n "TODO|FIXME|ArgusWrapperOptions|renderArgusWrapper\(" packages apps scripts docs
```

Expected: no placeholder for this feature, no `ArgusWrapperOptions`, and every renderer call has zero arguments.

- [ ] **Step 3: Run full Node 24 gates**

Run:

```sh
pnpm test
pnpm typecheck
pnpm lint:check
pnpm build
git diff --check
```

Expected: all PASS.

- [ ] **Step 4: Request independent code review**

Use `superpowers:requesting-code-review`; resolve only verified findings and rerun the affected focused suite plus all full gates.

- [ ] **Step 5: Commit documentation/review fixes**

Commit: `git commit -am "docs: explain durable management updates"`

- [ ] **Step 6: Merge, release, and test the real VPS only after CI succeeds**

Create a PR with a lean description, wait for required CI, merge to `main`, publish the next signed release, then run the official stable installer once on `ssh vps`. Confirm:

```sh
sha256sum /usr/local/bin/argus
argus --version
sed -n '1,3p' /opt/argus/management.state
argus update --yes --json
sha256sum /usr/local/bin/argus
argus doctor --json
```

Expected: the two launcher hashes match, version/state select the signed release, update is healthy, and the existing ingestion data remains intact. Never touch `ssh gpu` or unrelated `atlas-db`.

