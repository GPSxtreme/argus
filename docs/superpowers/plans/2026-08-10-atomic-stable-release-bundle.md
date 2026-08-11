# Atomic Stable Release Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a pinned stable installer that can only advance together with the verified stable manifest and signature.

**Architecture:** The web route reads a checked-in stable installer artifact instead of rendering from current source. A verified promotion command validates an immutable release directory completely, renders the stable-URL installer from that release's trust root, and writes the three stable bundle members only after validation succeeds.

**Tech Stack:** TypeScript 6, Node.js 24, Next.js 15, POSIX shell, Vitest, Ed25519 release manifests, pnpm/Turborepo.

## Global Constraints

- The stable bundle is exactly `install.sh`, `manifest.json`, and `manifest.sig` under `apps/web/public/releases/stable/`.
- `/install.sh` serves the checked-in stable installer bytes and never renders from current application source.
- Stable `install.sh` embeds `https://argus.gpsxtre.me/releases/stable/manifest.json` and the verified candidate public key.
- The immutable GitHub-release installer is not copied to the stable route because it embeds an immutable GitHub manifest URL.
- Promotion verifies the complete candidate release before changing any stable bundle member.
- A stable promotion changes all three bundle files together; ordinary feature changes cannot alter public installer bytes.
- No legacy runtime fallback or new release channel is added.

---

### Task 1: Pin the currently deployed stable installer

**Files:**
- Create: `apps/web/public/releases/stable/install.sh`
- Modify: `apps/web/app/install.sh/route.ts`
- Modify: `apps/web/test/distribution.test.ts`
- Modify: `apps/web/test/stable-release-assets.test.ts`

**Interfaces:**
- Consumes: current public stable installer bytes whose SHA-256 is `91e3559f37084926fa30676f44e1da392e12da68d81530abeb9686f585e01080`.
- Produces: `GET /install.sh` whose body exactly equals `apps/web/public/releases/stable/install.sh`.

- [ ] **Step 1: Capture and verify the existing public stable installer**

Download `https://argus.gpsxtre.me/install.sh` to a temporary file, require the exact SHA-256 above, require `sh -n`, and require it contains the canonical stable manifest URL and stable public key. Only then place those exact bytes at the stable bundle path.

- [ ] **Step 2: Write failing route tests**

Replace renderer equality with file equality and prove renderer changes cannot change the public response:

```ts
const stableInstaller = await readFile(stableAsset("install.sh"));
const response = await getInstaller();
expect(Buffer.from(await response.arrayBuffer())).toEqual(stableInstaller);
expect(stableInstaller).not.toEqual(Buffer.from(renderInstaller(installerOptions)));
```

The inequality is required on this branch because the new durable installer renderer differs from the still-promoted v0.1.13 bundle.

- [ ] **Step 3: Run RED**

Run: `pnpm vitest run apps/web/test/distribution.test.ts apps/web/test/stable-release-assets.test.ts`

Expected: FAIL because the route still renders the current installer and the pinned file does not exist.

- [ ] **Step 4: Implement file-backed serving**

Resolve the stable installer from either monorepo root or `apps/web` cwd, mirroring the existing distribution path handling. Read the bytes and return them with the existing shell content type and cache header. Do not fall back to `renderInstaller`.

- [ ] **Step 5: Run GREEN and commit**

Run: `pnpm vitest run apps/web/test/distribution.test.ts apps/web/test/stable-release-assets.test.ts && pnpm --filter @argus/web typecheck && pnpm --filter @argus/web build`

Expected: PASS.

Commit: `git commit -m "feat: pin stable installer bundle"`

### Task 2: Add verified stable-bundle promotion

**Files:**
- Create: `scripts/release/verify-release-directory.ts`
- Modify: `scripts/release/verify-manifest.ts`
- Create: `scripts/release/stable-bundle.ts`
- Create: `scripts/release/promote-stable.ts`
- Create: `packages/release/test/promote-stable.test.ts`

**Interfaces:**
- Produces: `interface VerifiedReleaseDirectory { release: VerifiedReleaseManifest; publicKeyPem: string }`.
- Produces: `verifyReleaseDirectory(directory: string, publicKeyPath?: string): Promise<VerifiedReleaseDirectory>`.
- Produces: `promoteStableBundle(releaseDirectory: string, stableDirectory: string, io?: StableBundleIO): Promise<StableBundlePromotion>`.
- Produces CLI: `pnpm tsx scripts/release/promote-stable.ts RELEASE_DIRECTORY STABLE_DIRECTORY`.
- The promotion CLI expects candidate `manifest.json`, `manifest.sig`, `release-public.pem`, `argus`, `install.sh`, FxEmbed, license, and provenance files already produced by the release workflow.

- [ ] **Step 1: Write failing verification/promotion tests**

Build a signed fixture release with the release builder. Cover:

```ts
expect(await promote(fixtureRelease, stableDirectory)).toEqual({
  version: "1.2.3",
  manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  installerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
});
```

Assert the promoted manifest/signature bytes exactly equal the candidate, the promoted installer embeds the stable URL and candidate public key, and all three outputs change from prior sentinel bytes. For bad signature, wrapper hash mismatch, missing asset, or mismatched public key, assert the command fails and every prior stable bundle byte remains unchanged.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run packages/release/test/promote-stable.test.ts`

Expected: FAIL because the verifier module and promotion CLI do not exist.

- [ ] **Step 3: Extract complete release-directory verification**

Move the reusable verification body from `verify-manifest.ts` into `verify-release-directory.ts`. It must verify the manifest signature and every signed asset checksum before returning the verified identity. Keep `verify-manifest.ts` as a thin CLI with its existing arguments/output.

- [ ] **Step 4: Implement promotion after verification**

`stable-bundle.ts` must:

```ts
const verified = await verifyReleaseDirectory(releaseDirectory);
const stableInstaller = Buffer.from(renderInstaller({
  manifestUrl: "https://argus.gpsxtre.me/releases/stable/manifest.json",
  publicKeyPem: verified.publicKeyPem,
}));
```

Read all candidate inputs and render the stable installer before any output mutation. Create a sibling staging directory containing exactly the three files with modes `0755`, `0644`, `0644`; sync every file and the staging directory. Promote with a recoverable directory swap: rename the existing stable directory to a sibling backup, rename staging to the stable path, sync the parent, then remove the backup and sync the parent again. On any failure, restore the prior directory and retain a recovery backup if durable restoration cannot be proven. `promote-stable.ts` is only a thin argument-parsing CLI over this function.

- [ ] **Step 5: Run GREEN and commit**

Run: `pnpm vitest run packages/release/test/promote-stable.test.ts packages/release/test/manifest.test.ts packages/release/test/create-manifest.test.ts && pnpm --filter @argus/release typecheck && git diff --check`

Expected: PASS.

Commit: `git commit -m "feat: verify stable bundle promotion"`

### Task 3: Document and enforce the promotion workflow

**Files:**
- Modify: `docs/operations.md`
- Modify: `apps/web/test/stable-release-assets.test.ts`
- Modify: `packages/release/test/workflows.test.ts`
- Modify: `.github/workflows/release.yml` only if a stable-promotion artifact/output is required by the verified command.

**Interfaces:**
- Consumes: the promotion CLI from Task 2.
- Produces: operator command and CI/static contracts that require the three-file stable bundle.

- [ ] **Step 1: Add failing workflow and bundle-integrity assertions**

Require stable tests to pin all three hashes, verify signature, verify installer trust root/URL, and prove the installer accepts the signed durable wrapper contract. Require release workflow output to include every input needed by `promote-stable.ts`.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run apps/web/test/stable-release-assets.test.ts packages/release/test/workflows.test.ts`

Expected: FAIL until all bundle/promotion contracts are represented.

- [ ] **Step 3: Document exact promotion and rollback**

Document:

```sh
pnpm tsx scripts/release/promote-stable.ts dist/release apps/web/public/releases/stable
git diff -- apps/web/public/releases/stable
```

The operator must see exactly three changed bundle files for a new release, run release verification plus clean-host smoke, then commit them together. Rollback reverts the complete promotion commit, never one member.

- [ ] **Step 4: Run complete verification and commit**

Run:

```sh
pnpm test
pnpm typecheck
pnpm lint:check
pnpm build
git diff --check
```

Expected: all PASS, including the formerly failing stable installer hash test.

Commit: `git commit -m "docs: define atomic stable promotion"`

- [ ] **Step 5: Request independent review**

Review trust binding, failure atomicity, Vercel file serving, and exact three-file promotion. Resolve findings before returning to the durable-launcher plan's final release task.
