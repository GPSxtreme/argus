# SQLite Docker-Volume Backup and Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make signed SQLite updates and rollbacks snapshot and restore the real Compose-managed Docker volume instead of nonexistent host database paths.

**Architecture:** A focused deployment module discovers the exact `/app/data` named volume through Compose/Docker inspection and runs the verified current Argus image as a network-disabled SQLite helper. Update orchestration briefly stops only Argus, durably commits a verified snapshot before target mutation, and rollback verifies then atomically restores that snapshot before starting the signed prior image.

**Tech Stack:** TypeScript, Node.js 24, Zod, Execa, Docker Engine/Compose, better-sqlite3 inside the digest-pinned Argus application image, Vitest, POSIX shell, GitHub Actions.

## Global Constraints

- SQLite update downtime is approved; stop only the `argus` service and leave unrelated services running.
- Remove obsolete host-root and `root/data` SQLite backup paths; do not retain fallbacks or migrations.
- Discover the deployed volume structurally; never construct `argus_argus-data` from strings.
- The helper receives no network, secrets, configuration environment, or Docker socket.
- Snapshot and restore use the digest-pinned current/rollback application image already bound by signed deployment state.
- PostgreSQL update behavior remains unchanged and does not create a SQLite snapshot.
- Snapshot verification and rollback validation happen before destructive database mutation.
- Persisted paths remain confined beneath the instance root and all diagnostics remain secret-safe.
- Use the repository-pinned Node.js 24 runtime for every test, typecheck, lint, and build command.

---

## File Structure

- Create `packages/deployment/src/sqlite-volume.ts`: strict volume discovery, helper command construction, helper-output parsing, snapshot creation/verification, and atomic restore.
- Create `packages/deployment/test/sqlite-volume.test.ts`: pure/fake-executor contract and failure-order coverage for the focused module.
- Create `packages/deployment/test/sqlite-volume.live.test.ts`: opt-in Docker named-volume regression using the pinned application image.
- Modify `packages/deployment/src/update.ts`: replace `sqliteFiles` with `sqliteSnapshot`, orchestrate stop/snapshot/restart-on-backup-failure, and restore through the focused module.
- Modify `packages/deployment/src/index.ts`: export the focused SQLite volume interfaces.
- Modify `packages/deployment/test/update.test.ts`: replace host-path fixtures with snapshot contracts and assert update/rollback ordering.
- Modify `.github/workflows/release.yml`: run the real named-volume regression against the just-published digest-pinned application image.
- Modify `scripts/e2e/vps-smoke.sh`: require a verified SQLite snapshot after a non-noop SQLite update.
- Modify `packages/release/test/workflows.test.ts`: lock the release and VPS workflow contracts.
- Modify `docs/operations.md`: describe brief downtime, volume snapshots, rollback verification, and off-host backup boundaries.

---

### Task 1: Strict Compose Volume Discovery

**Files:**
- Create: `packages/deployment/src/sqlite-volume.ts`
- Create: `packages/deployment/test/sqlite-volume.test.ts`
- Modify: `packages/deployment/src/index.ts`

**Interfaces:**
- Consumes: `CommandExecutor`, deployment root, compose environment, and project name `argus`.
- Produces:

```ts
export interface SqliteVolumeIdentity {
  name: string;
  project: "argus";
  logicalName: "argus-data";
  destination: "/app/data";
}

export interface InspectSqliteVolumeInput {
  root: string;
  executor: CommandExecutor;
  environment: Record<string, string>;
}

export const inspectSqliteVolume: (
  input: InspectSqliteVolumeInput,
) => Promise<SqliteVolumeIdentity>;
```

- [ ] **Step 1: Write failing service/mount discovery tests**

Add a recording executor that returns a container ID for
`docker compose -p argus ps -q argus`, mount JSON for `docker inspect`, and
volume-label JSON for `docker volume inspect`. Cover the valid contract plus:

```ts
it.each([
  ["missing service", ""],
  ["multiple service containers", "one\ntwo\n"],
])("rejects %s before volume inspection", async (_name, stdout) => {
  const executor = scriptedExecutor([{ stdout }]);
  await expect(inspectSqliteVolume({ root, executor, environment })).rejects.toMatchObject({
    code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
  });
});
```

Add separate cases for no `/app/data` mount, two `/app/data` mounts, bind mounts,
empty/unsafe names, missing labels, wrong project, and wrong logical volume.
Assert no later executor calls occur after every rejection.

- [ ] **Step 2: Run the focused RED test**

Run:

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.test.ts
```

Expected: FAIL because `sqlite-volume.ts` and `inspectSqliteVolume` do not exist.

- [ ] **Step 3: Implement strict parsers and discovery**

In `sqlite-volume.ts`, add strict schemas and one bounded Docker runner:

```ts
const mountSchema = z.object({
  Type: z.literal("volume"),
  Name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
  Destination: z.literal("/app/data"),
}).passthrough();

const labelsSchema = z.object({
  "com.docker.compose.project": z.literal("argus"),
  "com.docker.compose.volume": z.literal("argus-data"),
}).passthrough();
```

Run exact commands with a 10-second timeout:

```ts
["compose", "-p", "argus", "ps", "-q", "argus"]
["inspect", "--format", "{{json .Mounts}}", containerId]
["volume", "inspect", "--format", "{{json .Labels}}", volumeName]
```

Require exactly one non-empty container ID and exactly one matching mount. Wrap
command, timeout, JSON, and schema failures in
`UPDATE_SQLITE_VOLUME_UNAVAILABLE` with `argus doctor --json` recovery text.

- [ ] **Step 4: Export and run GREEN**

Export `sqlite-volume.ts` from `packages/deployment/src/index.ts`, then run:

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.test.ts
pnpm --filter @argus/deployment typecheck
pnpm exec biome check packages/deployment/src/sqlite-volume.ts packages/deployment/test/sqlite-volume.test.ts packages/deployment/src/index.ts
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the discovery boundary**

```bash
git add packages/deployment/src/sqlite-volume.ts packages/deployment/test/sqlite-volume.test.ts packages/deployment/src/index.ts
git commit -m "feat: discover managed SQLite volume"
```

---

### Task 2: Verified Quiesced Snapshot Creation

**Files:**
- Modify: `packages/deployment/src/sqlite-volume.ts`
- Modify: `packages/deployment/test/sqlite-volume.test.ts`
- Modify: `packages/deployment/src/update.ts`
- Modify: `packages/deployment/test/update.test.ts`

**Interfaces:**
- Consumes: `SqliteVolumeIdentity`, verified rollback release image, unique backup directory, and `CommandExecutor`.
- Produces:

```ts
export interface SqliteSnapshot {
  relativePath: string;
  sha256: string;
  bytes: number;
  quickCheck: "ok";
  counts: { records: number; revisions: number; jobs: number };
  volume: SqliteVolumeIdentity;
}

export interface CreateSqliteSnapshotInput {
  root: string;
  backupRoot: string;
  executor: CommandExecutor;
  environment: Record<string, string>;
  image: string;
  volume: SqliteVolumeIdentity;
}

export const createSqliteSnapshot: (
  input: CreateSqliteSnapshotInput,
) => Promise<SqliteSnapshot>;
```

- [ ] **Step 1: Write RED helper-command and output-validation tests**

Require this command shape, with the volume and bind values passed as Docker
arguments rather than interpolated into JavaScript:

```ts
[
  "run", "--rm", "--network", "none", "--user", "0:0",
  "--mount", `type=volume,src=${volume.name},dst=/data`,
  "--mount", `type=bind,src=${backupRoot},dst=/backup`,
  "--entrypoint", "node", image, "--input-type=module", "-e",
  expect.any(String), "--", "/data/argus.db", "/backup/argus.db",
]
```

The helper stdout must be one strict JSON object matching `SqliteSnapshot`
fields except `relativePath` and volume, which the host integration supplies.
Reject nonzero exit, timeout, extra output, invalid JSON, `quickCheck !== "ok"`,
negative/non-integer counts, nonpositive bytes, and malformed SHA-256.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.test.ts -t "snapshot"
```

Expected: FAIL because `createSqliteSnapshot` is absent.

- [ ] **Step 3: Implement the network-disabled snapshot helper**

The inline module must:

```ts
const source = new Database(process.argv[1], { readonly: true, fileMustExist: true });
if (source.pragma("quick_check", { simple: true }) !== "ok") process.exit(21);
await source.backup(process.argv[2]);
source.close();
const snapshot = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const quickCheck = snapshot.pragma("quick_check", { simple: true });
const counts = {
  records: snapshot.prepare("SELECT count(*) AS count FROM records").get().count,
  revisions: snapshot.prepare("SELECT count(*) AS count FROM revisions").get().count,
  jobs: snapshot.prepare("SELECT count(*) AS count FROM jobs").get().count,
};
snapshot.close();
```

Hash the final bytes, fsync the file and `/backup`, print one JSON line, and do
not print database content or paths. The host derives a root-confined
`relativePath` and rejects symlink/non-regular snapshot paths before persistence.

- [ ] **Step 4: Replace the persisted `sqliteFiles` contract**

In `update.ts`:

```ts
export interface InstanceBackup {
  path: string;
  state: DeploymentStateV1;
  sqliteSnapshot?: SqliteSnapshot;
  signedContext: { relativePath: string; sha256: string };
}
```

Delete `sqliteFiles()`, host file copying, and the `sqliteFiles` schema. Add
`executor` to `BackupInstanceInput`. For SQLite only:

1. obtain and durably write state/signed rollback context;
2. inspect the volume before mutation;
3. run `docker compose -p argus stop argus` with current-release environment;
4. create and verify the snapshot;
5. persist `phase: "backed_up"` only after the snapshot is durable.

If steps 3–4 fail, run `docker compose -p argus up -d argus` using the verified
current release, check it is running, preserve owned staging material, and
rethrow the original structured error. PostgreSQL skips volume discovery and
snapshot creation.

- [ ] **Step 5: Replace host-path update tests**

Delete tests that write `root/argus.db` or `root/data/argus.db`. Extend the
recording executor to script discovery, stop, helper output, pull, migration,
up, and health. Assert exact order:

```ts
expect(events).toEqual([
  "rollback-context", "compose-ps", "container-inspect", "volume-inspect",
  "stop-argus", "snapshot-helper", "pull", "migrate", "up", "health",
]);
```

Add SQLite snapshot failure/restart and PostgreSQL-no-helper cases. Assert a
failed snapshot never writes a new authoritative `update-state.json` and never
pulls or migrates.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.test.ts packages/deployment/test/update.test.ts
pnpm --filter @argus/deployment typecheck
pnpm exec biome check packages/deployment/src/sqlite-volume.ts packages/deployment/src/update.ts packages/deployment/test/sqlite-volume.test.ts packages/deployment/test/update.test.ts
git diff --check
git add packages/deployment/src/sqlite-volume.ts packages/deployment/src/update.ts packages/deployment/test/sqlite-volume.test.ts packages/deployment/test/update.test.ts
git commit -m "fix: snapshot managed SQLite volume"
```

Expected: tests, typecheck, lint, and diff check exit 0.

---

### Task 3: Verified Atomic Volume Restore

**Files:**
- Modify: `packages/deployment/src/sqlite-volume.ts`
- Modify: `packages/deployment/test/sqlite-volume.test.ts`
- Modify: `packages/deployment/src/update.ts`
- Modify: `packages/deployment/test/update.test.ts`

**Interfaces:**
- Consumes: persisted `SqliteSnapshot`, exact rediscovered volume, signed rollback image, and `CommandExecutor`.
- Produces:

```ts
export interface RestoreSqliteSnapshotInput {
  root: string;
  backupRoot: string;
  snapshot: SqliteSnapshot;
  executor: CommandExecutor;
  environment: Record<string, string>;
  image: string;
  volume: SqliteVolumeIdentity;
}

export const verifySqliteSnapshot: (
  input: Omit<RestoreSqliteSnapshotInput, "volume">,
) => Promise<void>;

export const restoreSqliteSnapshot: (
  input: RestoreSqliteSnapshotInput,
) => Promise<void>;
```

- [ ] **Step 1: Write RED verification and restore-order tests**

Cover deletion, path escape, symlink, size mismatch, SHA mismatch, quick-check
failure, count mismatch, changed volume identity, helper timeout, and malformed
stdout. For every preflight failure assert no `stop`, restore helper, `up`, or
state write occurs.

Require rollback order:

```ts
[
  "verify-backup-helper", "compose-ps", "container-inspect", "volume-inspect",
  "stop-argus", "restore-helper", "up-prior", "health-prior",
]
```

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.test.ts packages/deployment/test/update.test.ts -t "restore|rollback"
```

Expected: FAIL because snapshot verification/restore are not wired.

- [ ] **Step 3: Implement preflight verification**

Confine the persisted path beneath `backup.path`, then beneath the instance
root. Require a regular non-symlink file. Run the helper with only the backup
directory mounted read-only and compare its strict JSON output to every
persisted field. Rediscover `/app/data` and require exact equality with the
persisted volume identity before stopping Argus.

- [ ] **Step 4: Implement atomic restore inside the volume**

Run the pinned prior app image with no network, the exact data volume read-write,
and backup directory read-only. The inline module must:

1. reverify source SHA, size, `quick_check`, and counts;
2. copy to `/data/.argus-restore-<random>.db` using exclusive creation;
3. verify and fsync the staged database;
4. checkpoint/close the stopped live database when present;
5. remove live WAL/SHM only after the live connection closes;
6. atomically rename the staged database over `/data/argus.db`;
7. fsync `/data` and report one strict success object.

On any pre-rename error, remove only the owned staged file and leave the live
database selected. On post-rename ambiguity, retain the source snapshot and
throw `UPDATE_ROLLBACK_RESTORE_FAILED` with its confined recovery location.

- [ ] **Step 5: Wire rollback to the snapshot contract**

In `rollbackUpdate`, require `sqliteSnapshot` for SQLite and omit it for
PostgreSQL. Remove the old `copyFile` loop. Verify before stopping, restore,
start with `persisted.rollbackRelease`, run health, then preserve the established
ordering of deployment-state save followed by caller-owned signed-context and
management-state promotion.

- [ ] **Step 6: Mutation-prove the pre-side-effect guard**

Temporarily move `stop argus` before `verifySqliteSnapshot` and run the tampered
snapshot test. Expected: FAIL because a stop call occurred. Restore the correct
ordering and rerun; expected PASS.

- [ ] **Step 7: Run GREEN and commit**

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.test.ts packages/deployment/test/update.test.ts apps/cli/test/integrations.test.ts apps/cli/test/program.test.ts
pnpm --filter @argus/deployment typecheck
pnpm --filter @argus/cli typecheck
pnpm lint:check
git diff --check
git add packages/deployment/src/sqlite-volume.ts packages/deployment/src/update.ts packages/deployment/test/sqlite-volume.test.ts packages/deployment/test/update.test.ts
git commit -m "fix: restore verified SQLite snapshot"
```

Expected: all commands exit 0.

---

### Task 4: Real Named-Volume Regression

**Files:**
- Create: `packages/deployment/test/sqlite-volume.live.test.ts`
- Modify: `.github/workflows/release.yml`
- Modify: `packages/release/test/workflows.test.ts`

**Interfaces:**
- Consumes: `ARGUS_SQLITE_VOLUME_TEST=1` and digest-pinned `ARGUS_APP_IMAGE`.
- Produces: an executable release gate proving snapshot/restore against a real Compose named volume with no host database path.

- [ ] **Step 1: Write the opt-in Docker integration test**

Use `mkdtemp`, a unique Compose project name, and a minimal Compose file whose
`argus` service mounts `argus-data:/app/data`. Seed SQLite only through the
running container:

```ts
await execa("docker", ["compose", "-p", project, "exec", "-T", "argus", "node", "--input-type=module", "-e", seedScript]);
await expect(access(join(root, "data", "argus.db"))).rejects.toMatchObject({ code: "ENOENT" });
```

Call the focused discovery/snapshot functions with the real executor, mutate
the volume database through a one-shot container, restore the snapshot, and
assert the prior sentinel/counts return while the post-snapshot sentinel is
absent. Always run `docker compose down --volumes --remove-orphans` in `finally`
and remove the temporary root.

- [ ] **Step 2: Run the test locally in opt-out mode**

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.live.test.ts
```

Expected: one explicit skip explaining the two required environment variables.

- [ ] **Step 3: Wire the signed-release gate**

After the application image build/push step in `release.yml`, pull
`${APP_IMAGE}@${{ steps.app.outputs.digest }}` and run:

```yaml
- name: Verify SQLite named-volume backup and restore
  env:
    ARGUS_SQLITE_VOLUME_TEST: "1"
    ARGUS_APP_IMAGE: ${{ env.APP_IMAGE }}@${{ steps.app.outputs.digest }}
  run: |
    docker pull "$ARGUS_APP_IMAGE"
    pnpm vitest run packages/deployment/test/sqlite-volume.live.test.ts
```

Add workflow tests requiring the step name, exact digest-pinned environment,
and focused test command.

- [ ] **Step 4: Run workflow and focused tests**

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.live.test.ts packages/release/test/workflows.test.ts
pnpm --filter @argus/deployment typecheck
pnpm --filter @argus/release typecheck
pnpm exec biome check packages/deployment/test/sqlite-volume.live.test.ts packages/release/test/workflows.test.ts
git diff --check
```

Expected: local live test skips explicitly; workflow tests pass.

- [ ] **Step 5: Commit the release gate**

```bash
git add packages/deployment/test/sqlite-volume.live.test.ts .github/workflows/release.yml packages/release/test/workflows.test.ts
git commit -m "test: verify SQLite named-volume rollback"
```

---

### Task 5: Operator and VPS Acceptance Contracts

**Files:**
- Modify: `docs/operations.md`
- Modify: `scripts/e2e/vps-smoke.sh`
- Modify: `packages/release/test/workflows.test.ts`

**Interfaces:**
- Consumes: persisted `backup.sqliteSnapshot` in `/opt/argus/update-state.json` after a non-noop SQLite update.
- Produces: documented behavior and clean-host evidence that the signed updater captured the real volume.

- [ ] **Step 1: Write RED VPS contract assertions**

In `workflows.test.ts`, require the smoke harness to validate:

```sh
jq -e '
  .backup.sqliteSnapshot.quickCheck == "ok" and
  (.backup.sqliteSnapshot.sha256 | test("^[a-f0-9]{64}$")) and
  (.backup.sqliteSnapshot.bytes > 0) and
  .backup.sqliteSnapshot.volume.project == "argus" and
  .backup.sqliteSnapshot.volume.logicalName == "argus-data" and
  .backup.sqliteSnapshot.volume.destination == "/app/data"
' /opt/argus/update-state.json
```

Also require path confinement beneath `/opt/argus/backups`, regular-file/no-
symlink checks, host `sha256sum` equality, and absence of obsolete
`.backup.sqliteFiles` use.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run packages/release/test/workflows.test.ts
```

Expected: FAIL because VPS snapshot assertions are absent.

- [ ] **Step 3: Update the VPS harness**

Immediately after successful non-noop update, parse the relative snapshot path
from `update-state.json`, reject absolute/empty/dot/backslash components, resolve
it beneath `/opt/argus`, require a regular non-symlink file, compare SHA-256 and
byte length, and assert recorded counts are nonnegative integers. Do not print
the snapshot, configuration, or secrets.

- [ ] **Step 4: Correct operator documentation**

Replace the host-copy claim with the exact behavior: Argus briefly stops the
SQLite service, snapshots the managed Docker volume, verifies and retains the
snapshot for signed rollback, and does not treat update snapshots as scheduled
or off-host backups. Keep the manual offline/online backup guidance for disaster
recovery.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm vitest run packages/release/test/workflows.test.ts apps/web/test/docs.test.ts
sh -n scripts/e2e/vps-smoke.sh
pnpm --filter @argus/release typecheck
pnpm lint:check
git diff --check
git add docs/operations.md scripts/e2e/vps-smoke.sh packages/release/test/workflows.test.ts
git commit -m "docs: document verified SQLite snapshots"
```

Expected: all commands exit 0.

---

### Task 6: Whole-Branch Verification and Release Handoff

**Files:**
- Review only: every changed file from Tasks 1–5

**Interfaces:**
- Consumes: the complete branch.
- Produces: merge-ready evidence and a release/VPS rerun checklist; no unrelated soak-test fixes are added.

- [ ] **Step 1: Run fresh Node 24 focused gates**

```bash
pnpm vitest run packages/deployment/test/sqlite-volume.test.ts packages/deployment/test/update.test.ts apps/cli/test/integrations.test.ts apps/cli/test/program.test.ts packages/release/test/workflows.test.ts apps/web/test/docs.test.ts
pnpm typecheck
pnpm lint:check
pnpm build
git diff --check origin/main...HEAD
```

Expected: every command exits 0 with no failed tests.

- [ ] **Step 2: Run the full test suite serially enough to avoid shell-fixture contention**

```bash
pnpm test -- --maxWorkers=1
```

Expected: exit 0. If the workspace wrapper does not forward this option, run
the repository's existing full `pnpm test`, then rerun any installer/PTY files
in bounded single-worker groups and report exact evidence rather than claiming
an unobserved aggregate result.

- [ ] **Step 3: Review the security and failure-order diff**

Confirm from `git diff origin/main...HEAD` that:

- no host SQLite fallback remains;
- helper commands use `--network none`, exact mounts, and digest-pinned images;
- no secret/config environment reaches helpers;
- every persisted path is confined and every source file is regular/non-symlink;
- backup verification precedes stop/restore;
- signed context and management promotion remain after runtime health; and
- PostgreSQL and no-op paths do not invoke SQLite helpers.

- [ ] **Step 4: Request independent review**

Ask the reviewer to trace the actual Compose named-volume topology, snapshot
durability, restore atomicity, symlink/path/TOCTOU boundaries, Docker argument
injection, rollback identity ordering, and test realism. Resolve every Critical
or Important finding with a new RED/GREEN cycle before merging.

- [ ] **Step 5: Prepare merge and release evidence**

Record the branch commits, exact Node version, focused/full gate results, live
release-gate expectation, and the stopped VPS checkpoint path
`/home/prudhvi/argus-checkpoints/movie-soak-20260816T162719Z`. After merge,
publish a signed release, promote it atomically, install/update only that release
on the VPS, verify the new snapshot metadata, and begin a fresh movie/TV soak.
