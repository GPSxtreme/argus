# Runtime-Aware Doctor Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Doctor and SearXNG repair test dependencies from the same runtime contexts used by real ingestion, eliminating the two VPS false negatives without exposing services or changing deployment networking.

**Architecture:** Add one deployment helper that validates managed SearXNG by executing a bounded Node JSON-search probe inside the running `argus` Compose service. Doctor uses that helper for managed SearXNG, retains direct fetch only for external SearXNG, and derives FxEmbed health from the single existing X source-smoke promise instead of fetching the provider root. Repair reuses the managed helper.

**Tech Stack:** TypeScript 6, Node.js 24.19.0, Docker Compose v2, Vitest 3, pnpm 10, POSIX shell, GitHub Actions.

## Global Constraints

- Do not publish SearXNG port 8080 or change Compose networks.
- Do not change the immutable launcher's host-network contract.
- Do not add a public endpoint, provider-specific bare-root health request, compatibility path, or extra retry.
- Remove the obsolete managed-repair fetcher seam.
- Keep every command bounded and use the existing persisted Compose environment, project name `argus`, and deployment root.
- Pass the configured SearXNG endpoint as an argv value, never interpolate it into shell or JavaScript source.
- Never return endpoint payloads, command output, environment values, tokens, or private records in diagnostics.
- Create exactly one X diagnostic watch and cleanup when both X and FxEmbed are enabled.
- Preserve the diagnostic report schema and disabled-component behavior.
- Use Node.js 24.19.0 for every local gate.

---

### Task 1: Probe managed SearXNG inside the runtime network

**Files:**
- Modify: `packages/deployment/src/searxng.ts`
- Modify: `packages/deployment/test/searxng.test.ts`

**Interfaces:**
- Consumes: `CommandExecutor`, `loadPersistedComposeEnvironment`, the deployment root, and the configured SearXNG endpoint.
- Produces: `checkManagedSearxngHealth(context: ManagedSearxngHealthContext): Promise<SearxngHealth>` and `repairSearxng(context: SearxngRepairContext)` without a `fetcher` option.

- [ ] **Step 1: Add failing managed-runtime probe tests**

Add tests that persist valid Compose inputs and assert `checkManagedSearxngHealth` performs exactly:

```ts
await executor.run("docker", ["compose", "-p", "argus", "config"], {
  cwd: root,
  env: persistedEnvironment,
  timeoutMs: 5_000,
});
await executor.run(
  "docker",
  [
    "compose",
    "-p",
    "argus",
    "exec",
    "-T",
    "argus",
    "node",
    "--input-type=module",
    "-e",
    expect.stringContaining("Array.isArray(body.results)"),
    "http://searxng:8080",
  ],
  { cwd: root, env: persistedEnvironment, timeoutMs: 5_000 },
);
```

Cover these exact results:

- config exit 0 plus probe exit 0 and not timed out returns `{ healthy: true, resultCount: 0 }`;
- missing persisted inputs, config failure/timeout, probe failure/timeout, and thrown executor return `{ healthy: false, resultCount: 0 }`;
- an endpoint containing quotes/metacharacters remains one argv item and never appears inside the `-e` source string;
- executor stdout/stderr containing `secret-token` never appears in the returned result.

- [ ] **Step 2: Run RED under Node 24**

```sh
eval "$(fnm env --shell zsh)"
fnm use 24.19.0
pnpm vitest run packages/deployment/test/searxng.test.ts -t "managed runtime" --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because `checkManagedSearxngHealth` and `ManagedSearxngHealthContext` do not exist.

- [ ] **Step 3: Implement the managed helper minimally**

Add:

```ts
const managedProbe = `const endpoint = new URL("/search", process.argv[1]);
endpoint.searchParams.set("q", "argus");
endpoint.searchParams.set("format", "json");
const response = await fetch(endpoint, { headers: { accept: "application/json" } });
if (!response.ok) process.exit(1);
const body = await response.json();
if (!Array.isArray(body.results)) process.exit(1);`;

export interface ManagedSearxngHealthContext {
  root: string;
  executor: CommandExecutor;
  endpoint?: string;
  requestTimeoutMs?: number;
}

export const checkManagedSearxngHealth = async (
  context: ManagedSearxngHealthContext,
): Promise<SearxngHealth> => {
  const unhealthy = { healthy: false, resultCount: 0 };
  try {
    const environment = await loadPersistedComposeEnvironment(context);
    const timeoutMs = boundedComposeTimeout(context.requestTimeoutMs ?? 5_000);
    const configured = await context.executor.run(
      "docker",
      ["compose", "-p", "argus", "config"],
      { cwd: context.root, env: environment, timeoutMs },
    );
    if (configured.exitCode !== 0 || configured.timedOut) return unhealthy;
    const probe = await context.executor.run(
      "docker",
      [
        "compose", "-p", "argus", "exec", "-T", "argus",
        "node", "--input-type=module", "-e", managedProbe,
        context.endpoint ?? "http://searxng:8080",
      ],
      { cwd: context.root, env: environment, timeoutMs },
    );
    return probe.exitCode === 0 && !probe.timedOut
      ? { healthy: true, resultCount: 0 }
      : unhealthy;
  } catch {
    return unhealthy;
  }
};
```

Use the existing `boundedComposeTimeout` with a default of 5,000 ms for this health operation. The inline module must construct `new URL("/search", process.argv[1])`, set `q=argus` and `format=json`, require `response.ok`, parse JSON, and exit nonzero unless `body.results` is an array. Do not parse or expose command output; exit status is the contract.

- [ ] **Step 4: Run the managed helper tests GREEN**

Run the Step 2 command and expect PASS.

- [ ] **Step 5: Replace repair's host-context fetch with the helper**

First change the existing repair test so its executor returns two unhealthy runtime probe exits followed by one healthy exit and asserts three `docker compose exec -T argus node` calls. Remove `fetcher` from the test input and assert no direct-fetch seam exists in `SearxngRepairContext`.

Run:

```sh
pnpm vitest run packages/deployment/test/searxng.test.ts -t "rewrites only managed settings" --maxWorkers=1 --minWorkers=1
```

Expected RED: repair still calls `waitForSearxng` with the old fetcher.

Then remove `fetcher?: SearxngFetcher` from `SearxngRepairContext`, replace `waitForSearxng` with bounded calls to `checkManagedSearxngHealth`, and preserve the existing three-attempt exponential sleep and stable diagnostics.

- [ ] **Step 6: Run Task 1 verification and mutation proof**

```sh
pnpm vitest run packages/deployment/test/searxng.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @argus/deployment typecheck
pnpm exec biome check packages/deployment/src/searxng.ts packages/deployment/test/searxng.test.ts
git diff --check
```

Temporarily execute the managed probe directly from the management process instead of Compose `argus`; confirm the managed-runtime test fails. Restore and rerun all commands; expect PASS.

- [ ] **Step 7: Commit Task 1**

```sh
git add packages/deployment/src/searxng.ts packages/deployment/test/searxng.test.ts
git commit -m "fix: probe searxng from runtime network"
```

---

### Task 2: Make Doctor reuse runtime SearXNG and X/FxEmbed diagnostics

**Files:**
- Modify: `packages/deployment/src/doctor.ts`
- Modify: `packages/deployment/test/doctor.test.ts`
- Modify: `apps/cli/src/program.ts`
- Modify: `packages/release/test/workflows.test.ts`
- Modify: `scripts/e2e/vps-smoke.sh`

**Interfaces:**
- Consumes: `checkManagedSearxngHealth`, `checkSearxngHealth`, `DoctorContext`, and `smokeCheck("x", context, signal)`.
- Produces: a Doctor report where managed SearXNG uses runtime execution and FxEmbed mirrors one shared X diagnostic without fetching its base endpoint.

- [ ] **Step 1: Add failing Doctor SearXNG-context tests**

In `doctor.test.ts`, add executor call recording and valid persisted Compose inputs. Cover:

- `managed.searxng === "managed"` invokes the Task 1 Compose runtime helper and never calls `context.fetcher`;
- `managed.searxng === "external"` still calls the configured external `/search?q=argus&format=json` endpoint through `context.fetcher`;
- managed runtime failure returns component `searxng`, status `unhealthy`, code `SEARXNG_HEALTHCHECK_FAILED` without command output;
- disabled SearXNG remains skipped.

- [ ] **Step 2: Add failing shared X/FxEmbed tests**

Use an enabled X source with a configured diagnostic target and `managed.fxembed` set to both `managed` and `external`. Supply a `fetcher` that throws if it receives the FxEmbed base URL. Assert:

```ts
expect(api.createSmokeWatch).toHaveBeenCalledTimes(1);
expect(api.removeSmokeWatch).toHaveBeenCalledTimes(1);
expect(report.checks).toEqual(expect.arrayContaining([
  expect.objectContaining({ component: "x", status: "healthy", code: "SOURCE_SMOKE_HEALTHY" }),
  expect.objectContaining({ component: "fxembed", status: "healthy", code: "FXEMBED_HEALTHY" }),
]));
```

Also cover one failed X smoke producing X's existing precise failure plus FxEmbed code `FXEMBED_X_SMOKE_FAILED`; a skipped X smoke producing skipped FxEmbed code `FXEMBED_DIAGNOSTIC_SKIPPED`; and disabled FxEmbed remaining skipped without creating an extra watch.

- [ ] **Step 3: Run RED**

```sh
pnpm vitest run packages/deployment/test/doctor.test.ts -t "managed SearXNG|FxEmbed-backed|single X" --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because Doctor directly fetches both endpoints and separately schedules X.

- [ ] **Step 4: Split SearXNG component behavior by management mode**

Replace the two-component `endpointCheck` with a SearXNG-specific check:

- disabled: the existing skipped diagnostic;
- managed: call `checkManagedSearxngHealth({ root, executor, endpoint, requestTimeoutMs: per-check bound })`;
- external: call `checkSearxngHealth(endpoint, context.fetcher ?? fetch, { requestTimeoutMs: per-check bound })`.

Map healthy/unhealthy results to the existing `SEARXNG_HEALTHY` and `SEARXNG_HEALTHCHECK_FAILED` codes and messages.

- [ ] **Step 5: Share one X smoke promise with FxEmbed**

Create one lazily initialized promise per `runDoctor` call:

```ts
let xSmokePromise: Promise<Check> | undefined;
const xSmoke = (signal: AbortSignal): Promise<Check> => {
  xSmokePromise ??= smokeCheck("x", context, signal);
  return xSmokePromise;
};
```

The X check returns `xSmoke(signal)`. The FxEmbed check returns skipped when disabled; otherwise it awaits `xSmoke(signal)` and maps a healthy X result to `FXEMBED_HEALTHY`, an unhealthy X result to `FXEMBED_X_SMOKE_FAILED`, and a skipped X result to skipped `FXEMBED_DIAGNOSTIC_SKIPPED`. Remove `fxembedEndpoint` from `DoctorContext` and stop adding it in `apps/cli/src/program.ts`. Do not fetch that endpoint. Preserve check ordering.

- [ ] **Step 6: Strengthen clean-VPS workflow coverage**

Keep the existing `argus doctor --json` and `.data.healthy == true` VPS assertions. Remove the redundant standalone temporary-container SearXNG block from `scripts/e2e/vps-smoke.sh`. Assert in `workflows.test.ts` that the harness contains the Doctor health gate and no `--network argus_argus-private` SearXNG probe.

- [ ] **Step 7: Run Task 2 tests GREEN and mutation proof**

```sh
pnpm vitest run packages/deployment/test/doctor.test.ts packages/deployment/test/searxng.test.ts packages/release/test/workflows.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @argus/deployment typecheck
pnpm --filter @argus/cli typecheck
pnpm --filter @argus/release typecheck
pnpm lint:check
git diff --check
```

Temporarily restore the FxEmbed base fetch and confirm the shared-X regression fails. Restore the implementation and rerun; expect PASS.

- [ ] **Step 8: Run whole-repository gates**

```sh
pnpm test
pnpm typecheck
pnpm lint:check
pnpm build
git diff --check
```

Expected: all commands exit 0 under Node 24.19.0.

- [ ] **Step 9: Commit Task 2**

```sh
git add packages/deployment/src/doctor.ts packages/deployment/test/doctor.test.ts apps/cli/src/program.ts packages/release/test/workflows.test.ts scripts/e2e/vps-smoke.sh
git commit -m "fix: align doctor probes with runtime"
```

Stage only files actually changed; the command's list is the complete allowed scope.

---

### Task 3: Release and verify the Doctor fix

**Files:**
- Modify through verified promotion: `apps/web/public/releases/stable/install.sh`
- Modify through verified promotion: `apps/web/public/releases/stable/manifest.json`
- Modify through verified promotion: `apps/web/public/releases/stable/manifest.sig`
- Modify: `apps/web/test/stable-release-assets.test.ts`

**Interfaces:**
- Consumes: reviewed Task 1 and Task 2 commits, signed release workflow, stable promotion verifier, and the existing VPS installation.
- Produces: immutable v0.1.16 release, atomically promoted public stable v0.1.16 bundle, and real VPS Doctor/repair acceptance evidence.

- [ ] **Step 1: Review and merge the implementation**

Run an independent task review after each implementation task and a whole-branch review. Push a ready PR; require lint, CI, Web, Vercel, and review to pass before merging to `main`.

- [ ] **Step 2: Publish immutable v0.1.16**

Create lightweight tag `v0.1.16` at the exact green main merge commit. Wait for the signed release workflow and verify all eight immutable assets plus `stable-promotion-input` against signed manifest hashes.

- [ ] **Step 3: Promote stable atomically**

In a separate clean worktree/branch, download the verified promotion input, update the stable identity test RED-first, run `promote-stable.ts`, and commit exactly the three stable members plus the identity-test update. Require the exact-three policy, signature verification, `sh -n`, focused tests, typechecks, lint, build, PR checks, and independent review before merge.

- [ ] **Step 4: Update the VPS and verify Doctor**

Over `ssh vps`, record launcher SHA and database/source baselines. Run:

```sh
argus update --json --yes
argus doctor --json
argus status --json
```

Require v0.1.16 runtime/management identity, unchanged immutable launcher SHA, overall Doctor `healthy: true`, and healthy Docker, Argus, SQLite, SearXNG, FxEmbed, X, Telegram, and Web checks.

- [ ] **Step 5: Verify privacy, repair, and data integrity**

Confirm Docker publishes only port 8788, SearXNG remains private, source checkpoints advance, SQLite counts do not decrease, and recent records remain readable. Run `argus repair searxng --dry-run --json` first and require a plan targeting only managed SearXNG. Then run `argus repair searxng --yes --json`; require repair health success and a subsequent overall healthy Doctor result.

- [ ] **Step 6: Verify idempotency and record evidence**

Run a second no-op update; require unchanged launcher/runtime identity, counts, and checkpoints apart from normal ingestion. Record PR/release URLs, public hashes, Doctor checks, Docker ports, repair result, and before/after data counts without secrets or private record contents.
