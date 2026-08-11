# Installer Stream Atomicity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `curl -fsSL https://argus.gpsxtre.me/install.sh | sudo sh` execute no installer body operations until POSIX `sh` has received and parsed the complete script.

**Architecture:** Keep the existing generated installer and trust/transaction logic, but place the complete body inside one top-level `argus_install_main` function. Invoke that function only after its closing brace, so a truncated stream fails parsing before any body command runs. Ship the immutable change as v0.1.15, promote its stable bundle atomically, and repeat real VPS acceptance.

**Tech Stack:** TypeScript 6, POSIX `sh`/Dash, Vitest 3, pnpm 10, GitHub Actions, Docker/GHCR, Next.js/Vercel.

## Global Constraints

- Do not change manifest, signature, image, launcher, or management-state trust rules.
- Do not change installer transaction ordering or recovery semantics.
- Do not add retries that can hide a broken or partial transfer.
- Do not add a second bootstrap protocol or network request.
- Preserve complete-installer output and behavior; installer bytes may change.
- Use Node.js 24.19.0 for every local gate.
- Keep the v0.1.14 release immutable; ship this change as v0.1.15.

---

### Task 1: Parse-gate the generated installer

**Files:**
- Modify: `packages/release/src/installer.ts`
- Modify: `packages/release/test/installer.test.ts`

**Interfaces:**
- Consumes: `renderInstaller(options: InstallerOptions): string` and the existing installer fixture.
- Produces: the same `renderInstaller` API, now returning a script shaped as `#!/bin/sh`, one `argus_install_main() { ... }` definition, and one final `argus_install_main "$@"` invocation.

- [ ] **Step 1: Update the structural renderer contract**

Change the first renderer assertion so it requires the parse gate rather than top-level `set -eu`:

```ts
expect(installer).toMatch(
  /^#!\/bin\/sh\nargus_install_main\(\) \{\nset -eu\n/,
);
expect(installer).toMatch(/\n\}\nargus_install_main "\$@"\n$/);
expect(installer.match(/^argus_install_main "\$@"$/gmu)).toHaveLength(1);
```

- [ ] **Step 2: Add the failing truncated-stream behavior test**

Use `createFixture()`, replace its fake `uname` with a marker-writing version, and truncate the rendered installer at three known tokens that all occur after the inspect-mode block:

```ts
it("executes no installer body commands until the complete stream parses", async () => {
  const fixture = await createFixture();
  const marker = join(fixture.root, "installer-body-executed");
  await command(
    join(fixture.bin, "uname"),
    `printf touched > "$ARGUS_FIXTURE_PARSE_MARKER"
printf '%s\\n' x86_64`,
  );
  const installer = await readFile(fixture.installer, "utf8");
  const cutTokens = [
    "argus_install_docker() {",
    "argus_capture_snapshot() {",
    'argus_recovery_backups="',
  ];

  for (const [index, token] of cutTokens.entries()) {
    const cut = installer.indexOf(token);
    expect(cut).toBeGreaterThan(0);
    const truncated = join(fixture.root, `truncated-${index}.sh`);
    await writeFile(truncated, installer.slice(0, cut + token.length));

    await expect(
      execute("sh", [truncated], {
        env: {
          ...process.env,
          PATH: `${fixture.bin}:/opt/homebrew/bin:/usr/bin:/bin`,
          ARGUS_INSTALL_INSPECT: "1",
          ARGUS_INSTALL_FIXTURE: "1",
          ARGUS_INSTALL_OS_RELEASE: fixture.osRelease,
          ARGUS_INSTALL_TARGET: fixture.target,
          ARGUS_INSTALL_ROOT: fixture.installRoot,
          ARGUS_INSTALL_FIXTURE_STATE_PATH: fixture.validationState,
          ARGUS_INSTALL_LOCK: join(fixture.root, "installer.lock"),
          ARGUS_INSTALL_DOCKER: "0",
          ARGUS_FIXTURE_PARSE_MARKER: marker,
        },
      }),
    ).rejects.toMatchObject({ code: expect.any(Number) });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
```

- [ ] **Step 3: Run RED under Node 24**

Run:

```sh
eval "$(fnm env --shell zsh)"
fnm use 24.19.0
pnpm vitest run packages/release/test/installer.test.ts -t "executes no installer body commands until the complete stream parses" --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because the current top-level installer reaches inspect mode or writes the marker before the truncated tail is parsed.

- [ ] **Step 4: Implement the minimal parse gate**

Change only the template boundaries in `renderInstaller`. Immediately after the shebang, open the function before the existing `set -eu`:

```ts
return `#!/bin/sh
argus_install_main() {
set -eu
```

At the existing end of the template, keep the final success output and append the closing brace and invocation before the terminating backtick:

```ts
printf '%s\\n' "argus onboard"
}
argus_install_main "$@"
`;
```

Do not indent or rewrite the body, add a subshell, or add another downloader. The closing brace must follow the final success output, and the invocation must be the final executable line.

- [ ] **Step 5: Run GREEN and mutation-check the test**

Run the focused test from Step 3; expect PASS. Then temporarily remove the closing function wrapper or move the invocation before the closing brace and rerun; expect the new regression to FAIL. Restore the correct implementation and rerun; expect PASS.

- [ ] **Step 6: Run installer and release gates**

Run:

```sh
pnpm vitest run packages/release/test/installer.test.ts packages/release/test/installer-smoke.test.ts packages/release/test/create-manifest.test.ts packages/release/test/promote-stable.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
pnpm --filter @argus/release typecheck
pnpm lint:check
pnpm build
git diff --check
```

Expected: all commands exit 0. The existing complete-installer tests must keep their previous output and transaction assertions.

- [ ] **Step 7: Commit the implementation**

```sh
git add packages/release/src/installer.ts packages/release/test/installer.test.ts
git commit -m "fix: parse installer before execution"
```

---

### Task 2: Publish and accept v0.1.15

**Files:**
- Modify through verified promotion: `apps/web/public/releases/stable/install.sh`
- Modify through verified promotion: `apps/web/public/releases/stable/manifest.json`
- Modify through verified promotion: `apps/web/public/releases/stable/manifest.sig`
- Modify: `apps/web/test/stable-release-assets.test.ts`

**Interfaces:**
- Consumes: reviewed Task 1 commit, signed release workflow, `promoteStableBundle`, and the existing public stable trust root.
- Produces: immutable GitHub release `v0.1.15`, stable public v0.1.15 bytes, durable VPS launcher/state, and recorded before/after acceptance evidence.

- [ ] **Step 1: Merge the reviewed implementation**

Push the feature branch, open a lean PR, and require lint, full CI, web build, Vercel, and independent code review to pass. Merge only the reviewed commit history into `main`.

- [ ] **Step 2: Create the immutable release**

After main push CI is green, create lightweight tag `v0.1.15` at the exact main merge commit and push it. Wait for the signed release workflow to publish all eight assets and `stable-promotion-input`. Verify release manifest/signature, wrapper, installer, FxEmbed, license, provenance, and public key are present.

- [ ] **Step 3: Promote the verified stable bundle**

Download `stable-promotion-input` and run:

```sh
pnpm tsx scripts/release/promote-stable.ts dist/release apps/web/public/releases/stable
```

Update the stable identity test with the verified v0.1.15 manifest SHA, signature bytes, and stable installer SHA. Run the exact-three policy, focused promotion tests, `sh -n`, web/release typechecks, lint, and production web build. Commit all three stable members together with the identity-test update.

- [ ] **Step 4: Merge the stable promotion**

Open a separate promotion PR, require all GitHub and Vercel checks to pass, and merge. Verify the public stable manifest reports `0.1.15`; verify public installer and signature SHA-256 values equal the promoted repository bytes.

- [ ] **Step 5: Repeat the real one-command VPS install**

Capture the current wrapper hash/version, management-state presence, service health, SQLite record/job/revision counts, and source checkpoints. Have the user run exactly:

```sh
curl -fsSL https://argus.gpsxtre.me/install.sh | sudo sh
```

Verify `/usr/local/bin/argus` is the immutable durable wrapper, `/opt/argus/management.state` is exactly three canonical lines at mode 0644, and `argus --version` reports 0.1.15.

- [ ] **Step 6: Complete update and data-source acceptance**

Record the launcher SHA, run `argus update`, and verify the launcher SHA is unchanged while runtime/deployment/management identity becomes v0.1.15. Run `argus --json status` and `argus doctor`; confirm X, Telegram, and Web checkpoints advance; compare SQLite counts and inspect recent movie/TV-news records. Run a second installer invocation and a no-op update to verify idempotency without data loss.

- [ ] **Step 7: Record final evidence**

Report release/PR URLs, exact public hashes, VPS wrapper/state/runtime versions, before/after database counts, source health, idempotency results, and any remaining non-blocking operational concern. Do not include secrets, tokens, private configuration, or raw private data.
