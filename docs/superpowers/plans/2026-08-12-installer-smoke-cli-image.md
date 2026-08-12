# Installer Smoke CLI Image Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the full post-release clean-host matrix by removing the incorrect duplicate 65-character CLI-image validator while preserving exact signed-state equality.

**Architecture:** The smoke harness keeps its authoritative pre-install OCI `{64}` validation and post-install byte-for-byte state equality. A real shell-boundary test accepts a valid canonical state, rejects malformed expected images before mutation, and rejects a different valid digest at the equality boundary.

**Tech Stack:** POSIX `sh`, Node.js 24.19.0, TypeScript/Vitest 3, pnpm 10, GitHub Actions matrix containers.

## Global Constraints

- No production installer, wrapper, state, trust, image, release, or onboarding behavior changes.
- Remove the duplicate management-state OCI grammar; do not replace it with another validator.
- Preserve pre-install `{64}` expected-image validation and exact post-install state equality.
- Preserve every matrix variant and fail-closed behavior.
- Use Node.js 24.19.0 for every local gate.

---

### Task 1: Remove the broken duplicate validator

**Files:**
- Modify: `scripts/e2e/installer-smoke.sh`
- Modify: `packages/release/test/installer-smoke.test.ts`

**Interfaces:**
- Consumes: `ARGUS_EXPECTED_CLI_IMAGE` and the canonical `/opt/argus/management.state` created by the real installer fixture.
- Produces: smoke acceptance only when parsed `cli_image` exactly equals the already-validated expected digest-pinned reference.

- [ ] **Step 1: Add a real 64-character acceptance regression**

Extend the existing installer-smoke fixture that performs the signed wrapper/state installation. Ensure it supplies:

```ts
const expectedCliImage =
  `ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}`;
```

Run through the real `argus_verify_management_state` boundary and assert it advances beyond state validation rather than emitting `management state has an invalid CLI image`.

- [ ] **Step 2: Add negative boundary cases**

Using the same executable harness boundary, assert:

- expected images with 63 or 65 digest characters fail the early `ARGUS_EXPECTED_CLI_IMAGE must be digest pinned` check;
- canonical state containing a different valid 64-character digest fails `management state has the wrong CLI image`;
- no invalid case advances to onboarding.

- [ ] **Step 3: Run RED under Node 24**

```sh
eval "$(fnm env --shell zsh)"
fnm use 24.19.0
pnpm vitest run packages/release/test/installer-smoke.test.ts -t "management state CLI image" --maxWorkers=1 --minWorkers=1
```

Expected: valid 64-character state fails at the current 65-character `case` glob.

- [ ] **Step 4: Remove only the redundant block**

Delete:

```sh
case "$argus_management_cli_image" in
  cli_image=*@sha256:[a-f0-9]...) ;;
  *) argus_die "management state has an invalid CLI image" ;;
esac
```

Retain unchanged:

```sh
[ "$argus_management_cli_image" = "cli_image=$ARGUS_EXPECTED_CLI_IMAGE" ] ||
  argus_die "management state has the wrong CLI image"
```

- [ ] **Step 5: Run GREEN and mutation proof**

Run Step 3 and expect PASS. Change the installed fixture state to a different valid digest and require the equality regression to fail. Restore and rerun PASS.

- [ ] **Step 6: Run local gates**

```sh
sh -n scripts/e2e/installer-smoke.sh
pnpm vitest run packages/release/test/installer-smoke.test.ts packages/release/test/workflows.test.ts packages/release/test/installer.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @argus/release typecheck
pnpm test
pnpm typecheck
pnpm lint:check
pnpm build
git diff --check
```

Expected: every command exits 0 under Node 24.19.0.

- [ ] **Step 7: Commit**

```sh
git add scripts/e2e/installer-smoke.sh packages/release/test/installer-smoke.test.ts
git commit -m "fix: validate smoke management image exactly"
```

---

### Task 2: Merge and restore the release matrix

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: reviewed Task 1 commit and published v0.1.16 assets.
- Produces: green fix PR and a successful rerun of every v0.1.16 Installer smoke matrix job.

- [ ] **Step 1: Obtain task and whole-branch reviews**

Require spec PASS, quality APPROVE, and no open Critical/Important findings.

- [ ] **Step 2: Push and merge a separate smoke-harness PR**

Open a lean ready PR to `main`; require CI, lint, Web, Vercel, and review green before merge.

- [ ] **Step 3: Rerun the v0.1.16 Installer smoke workflow**

Use the workflow's supported dispatch/rerun path with immutable v0.1.16 assets and the trusted merged harness. Require the candidate job plus every distribution/architecture/Docker-presence matrix job to pass signed install and onboarding.

- [ ] **Step 4: Record evidence**

Report the fix PR/merge, workflow URL, matrix job list, and confirmation that no production release artifact or VPS state changed.
