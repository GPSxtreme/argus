# Stable Bundle No-op Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a deterministic stable promotion to change only the signed manifest pair when canonical `install.sh` bytes are unchanged, while rejecting every partial or extra stable mutation.

**Architecture:** Keep the path-only CI guard small: require `manifest.json` and `manifest.sig` together and permit `install.sh` only as an optional third member. Existing promotion and stable-asset tests continue verifying the resulting bytes, signature, trust root, and canonical installer.

**Tech Stack:** Node.js 24.19.0, JavaScript ESM, TypeScript/Vitest 3, temporary Git repositories, pnpm 10, GitHub Actions.

## Global Constraints

- No change to release artifacts, promotion transaction, installer renderer, trust root, route, or runtime behavior.
- Accept only `{manifest.json, manifest.sig}` or `{install.sh, manifest.json, manifest.sig}` under the stable directory.
- Reject every other nonempty stable changed set and every unexpected stable path.
- Allow unrelated repository changes alongside either valid stable set.
- Preserve the existing hermetic Git fixture environment sanitization.
- Use Node.js 24.19.0 for every gate.

---

### Task 1: Enforce semantic stable changed sets

**Files:**
- Modify: `scripts/ci/assert-stable-bundle-change.mjs`
- Modify: `packages/release/test/stable-bundle-change-policy.test.ts`

**Interfaces:**
- Consumes: `BASE_SHA HEAD_SHA` and `git diff --name-only --no-renames -z`.
- Produces: exit 0 for no stable changes or the two exact accepted sets; exit 1 with secret-safe changed-set diagnostics otherwise.

- [ ] **Step 1: Add the complete changed-set table RED-first**

Refactor test fixtures only as needed to express this table:

```ts
const manifest = "apps/web/public/releases/stable/manifest.json";
const signature = "apps/web/public/releases/stable/manifest.sig";
const installer = "apps/web/public/releases/stable/install.sh";

it.each([
  [[manifest, signature], 0],
  [[installer, manifest, signature], 0],
  [[manifest], 1],
  [[signature], 1],
  [[installer], 1],
  [[manifest, installer], 1],
  [[signature, installer], 1],
])("enforces stable changed set %j", (paths, status) => { /* real temporary Git commit + policy */ });
```

Add explicit cases proving unrelated paths are allowed beside either valid set and `notes.txt` is rejected beside both valid sets.

- [ ] **Step 2: Run RED under Node 24**

```sh
eval "$(fnm env --shell zsh)"
fnm use 24.19.0
pnpm vitest run packages/release/test/stable-bundle-change-policy.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: the two-file manifest/signature case fails with `missing install.sh`.

- [ ] **Step 3: Implement the minimal set rule**

Keep the existing unexpected-path rejection. Replace the exact-three requirement with these invariants:

```js
const manifestChanged = changed.has("manifest.json");
const signatureChanged = changed.has("manifest.sig");
const installerChanged = changed.has("install.sh");

if (!manifestChanged || !signatureChanged || unexpected.length > 0) {
  fail(/* deterministic missing/unexpected details */);
}
if (installerChanged && (!manifestChanged || !signatureChanged)) {
  fail(/* signed pair required */);
}
```

The accepted set must be checked exactly; do not accept duplicates, nested paths, or any fourth member.

- [ ] **Step 4: Run GREEN and mutation proof**

Run Step 2 and expect PASS. Temporarily make `install.sh` mandatory again; require the two-file case to fail. Restore and rerun PASS.

- [ ] **Step 5: Run repository gates**

```sh
pnpm vitest run packages/release/test/stable-bundle-change-policy.test.ts packages/release/test/promote-stable.test.ts apps/web/test/stable-release-assets.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @argus/release typecheck
pnpm --filter @argus/web typecheck
pnpm test
pnpm typecheck
pnpm lint:check
pnpm build
git diff --check
```

Expected: every command exits 0 under Node 24.19.0.

- [ ] **Step 6: Commit**

```sh
git add scripts/ci/assert-stable-bundle-change.mjs packages/release/test/stable-bundle-change-policy.test.ts
git commit -m "fix: allow deterministic stable promotion"
```

---

### Task 2: Review, merge, and prove the real promotion diff

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: reviewed Task 1 commit and the frozen v0.1.16 promotion output.
- Produces: green policy PR merged to `main` and a fresh policy execution accepting exactly the real v0.1.16 manifest/signature diff.

- [ ] **Step 1: Obtain task and whole-branch reviews**

Require spec PASS, quality APPROVE, and no open Critical/Important findings.

- [ ] **Step 2: Push and merge a separate policy PR**

Open a lean ready PR to `main`; require CI, lint, Web, Vercel, and review green before merge.

- [ ] **Step 3: Prove the real v0.1.16 case**

Create a fresh main-based temporary promotion worktree, regenerate v0.1.16 stable output, verify Git records only:

```text
apps/web/public/releases/stable/manifest.json
apps/web/public/releases/stable/manifest.sig
```

Run `scripts/ci/assert-stable-bundle-change.mjs BASE HEAD` against a temporary commit containing that real diff and require exit 0. Do not merge the promotion in this task; hand the clean proof to the resumed release task.
