# Healthy No-op Update Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an exact, healthy, already-current update succeed without parsing an obsolete rollback journal while keeping interrupted recovery and rollback fail-closed.

**Architecture:** Keep the strict deployment transaction parser unchanged. The CLI orchestration already has a branded current-release inspection with an explicit `recovery` discriminator, so it will bypass transaction finalization only for `plan.noop && recovery === "none"`; recovery no-ops still call the strict finalizer. The production regression uses a v0.1.15-shaped terminal journal and proves the journal remains unusable for rollback.

**Tech Stack:** TypeScript, Commander CLI orchestration, Vitest, Node.js 24, pnpm, Biome.

## Global Constraints

- Do not add a legacy parser, migration, fallback, or rollback path.
- Do not rewrite or delete the obsolete update journal during a healthy no-op.
- A v0.1.15 `backup.sqliteFiles` journal remains invalid for rollback.
- Pending and restarted update recovery must continue through strict transaction finalization.
- Do not change non-noop update, SQLite snapshot, restore, or rollback behavior.

---

### Task 1: Separate ordinary no-op completion from transaction finalization

**Files:**
- Modify: `apps/cli/test/integrations.test.ts` beside `repairs stale management state for a healthy no-op update`
- Modify: `apps/cli/src/program.ts` inside `createNodeCliDependencies().deployment.applyUpdate`

**Interfaces:**
- Consumes: `VerifiedCurrentReleaseInspection.recovery`, `UpdatePlan.noop`, and the healthy `AppliedUpdate` result already returned by `@argus/deployment`.
- Produces: the existing update result shape `{ version: string; phase: "verified"; health: UpdateHealthReport }`; no new exported API.

- [ ] **Step 1: Add the exact failing production regression**

Extend the healthy management-state no-op integration fixture with a terminal v0.1.15-shaped journal. Use the verified current and stale releases plus `loadDeploymentState(root)` to write the complete journal, with the obsolete field deliberately present:

```ts
const currentRelease = verifyReleaseManifestWithIdentity(
  current.manifestBytes,
  current.signature,
  current.publicKeyPem,
);
const staleRelease = verifyReleaseManifestWithIdentity(
  stale.manifestBytes,
  stale.signature,
  stale.publicKeyPem,
);
const deployed = await loadDeploymentState(root);
if (deployed === undefined) throw new Error("expected managed deployment state");
const priorRoot = await mkdtemp(join(tmpdir(), "argus-legacy-prior-state-"));
await saveManagedState(priorRoot, stale);
const priorState = await loadDeploymentState(priorRoot);
if (priorState === undefined) throw new Error("expected prior deployment state");
const legacyJournal = `${JSON.stringify({
  phase: "verified",
  plan: { currentVersion: stale.version, targetVersion: current.version },
  previousState: priorState,
  release: currentRelease,
  rollbackRelease: staleRelease,
  backup: {
    path: join(root, "backups", `legacy-${stale.version}`),
    state: priorState,
    sqliteFiles: [],
    signedContext: {
      relativePath: `backups/legacy-${stale.version}/release-context.json`,
      sha256: digest("9"),
    },
  },
}, null, 2)}\n`;
await writeFile(join(root, "update-state.json"), legacyJournal);
```

Drive the real CLI with `update --json --yes`. Record executor arguments and assert:

```ts
expect(JSON.parse(stdout)).toMatchObject({
  contractVersion: 1,
  ok: true,
  data: { version: current.version, health: { healthy: true } },
});
expect(executorCalls.filter((args) => !args.includes("ps"))).toEqual([]);
expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(legacyJournal);
expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(context);
```

Then drive `update --rollback --json --yes` and assert its JSON error code is exactly `UPDATE_ROLLBACK_UNAVAILABLE`, while the deployment, signed context, management state, and legacy journal remain unchanged.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
eval "$(fnm env)" && fnm use 24.19.0 >/dev/null
pnpm vitest run apps/cli/test/integrations.test.ts -t "repairs stale management state for a healthy no-op update"
```

Expected: FAIL because the first no-op update returns `UPDATE_ROLLBACK_UNAVAILABLE` from strict `update-state.json` parsing.

- [ ] **Step 3: Implement the narrow orchestration branch**

In `apps/cli/src/program.ts`, keep health verification, current-context reconciliation, and management-state promotion in their existing order. After management promotion, return directly only for an ordinary no-op:

```ts
if (plan.noop && currentReleaseInspection.recovery === "none") {
  return {
    version: applied.version,
    phase: "verified" as const,
    health: applied.health,
  };
}
return finalizeUpdate({ root, plan, applied });
```

Do not catch `UPDATE_ROLLBACK_UNAVAILABLE`, change the persisted schema, or remove the existing `finalizeUpdate` call for any recovery inspection.

- [ ] **Step 4: Run GREEN and mutation proofs**

Run the focused regression, then temporarily broaden the branch to all no-ops and confirm the existing interrupted-management recovery test fails because `update-state.json` remains `restarted`. Restore the exact `recovery === "none"` guard and rerun:

```bash
pnpm vitest run apps/cli/test/integrations.test.ts
pnpm vitest run packages/deployment/test/update.test.ts apps/cli/test/program.test.ts
```

Expected: all focused suites PASS. The mutation must fail before restoration and pass afterward.

- [ ] **Step 5: Run complete verification**

```bash
pnpm typecheck
pnpm lint:check
pnpm test
pnpm build
git diff --check
```

Expected: every command exits 0 under Node.js 24.19.0. Docker-backed live tests may remain explicitly skipped locally; the signed release gate is responsible for the opt-in real volume test.

- [ ] **Step 6: Request independent review and commit**

Request a read-only review of the exact range against this spec. Resolve every Critical or Important finding, rerun affected gates, then commit only the production file and regression test (the approved spec and plan are already committed):

```bash
git add apps/cli/src/program.ts apps/cli/test/integrations.test.ts
git commit -m "fix: complete healthy no-op updates"
```

- [ ] **Step 7: Release acceptance**

Open a focused PR. Merge only after remote CI, Web, lint, and Vercel checks pass. Tag the next immutable release, require the signed release and real SQLite named-volume gate to pass, promote the exact signed stable assets, then verify on the VPS:

```bash
argus update --json --yes
argus update --json --yes
argus doctor --json
```

Expected: first update advances to the release, second update succeeds as a healthy no-op without changing the launcher or journal, Doctor is fully healthy, and X/Telegram/Web checkpoints advance.
