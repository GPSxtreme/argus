# Argus Release Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish integrity-verified multi-architecture Argus application and management images plus the stable installer consumed by `argus.gpsxtre.me/install.sh`.

**Architecture:** Build versioned amd64/arm64 OCI images, sign an Ed25519 release manifest that pins image digests and managed assets, and distribute a small host wrapper as the `argus` executable. The wrapper runs the pinned management image with `/opt/argus`, host networking, and the Docker socket mounted.

**Tech Stack:** Docker Buildx, GHCR, Node.js 24 crypto, TypeScript 6, GitHub Actions, POSIX shell, Vitest

## Global Constraints

- The installer supports Ubuntu and Debian on Linux x64 and arm64 only.
- The public command remains `curl -fsSL https://argus.gpsxtre.me/install.sh | sh`.
- Every artifact is versioned and SHA-256 verified.
- The manifest is Ed25519-signed and verified with an embedded public key.
- No `latest` image is used by a deployed instance.
- Installation must expose an inspect-before-run path.
- Private alpha and public release origins use the same manifest contract.

---

## Planned File Structure

```text
packages/release/
  package.json
  tsconfig.json
  src/manifest.ts                 release schema and signature verification
  src/installer.ts                canonical install.sh renderer
  src/wrapper.ts                  canonical /usr/local/bin/argus renderer
  src/index.ts
  test/*.test.ts
scripts/release/
  create-manifest.ts              hashes assets and signs manifest
  verify-manifest.ts              release gate
  export-installer.ts             writes release installer asset
  export-wrapper.ts               writes host command release asset
deploy/docker/
  Dockerfile                      production application image
  Dockerfile.cli                  management CLI image with Docker client
.github/workflows/
  release.yml                     tagged multi-arch release
  installer-smoke.yml             clean-host installer matrix
```

### Task 1: Versioned Release Manifest and Signature Verification

**Files:**
- Create: `packages/release/package.json`
- Create: `packages/release/tsconfig.json`
- Create: `packages/release/src/manifest.ts`
- Create: `packages/release/src/index.ts`
- Test: `packages/release/test/manifest.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ReleaseManifestV1 {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  images: {
    app: { reference: string; digest: `sha256:${string}` };
    cli: { reference: string; digest: `sha256:${string}` };
    searxng: { reference: string; digest: `sha256:${string}` };
    postgres: { reference: string; digest: `sha256:${string}` };
  };
  assets: {
    fxembed: { url: string; sha256: string; compatibilityDate: string };
    wrapper: { url: string; sha256: string };
  };
  minimumStateSchema: 1;
}

export function verifyReleaseManifest(
  manifestBytes: Uint8Array,
  signature: Uint8Array,
  publicKeyPem: string,
): ReleaseManifestV1;
```

- [ ] **Step 1: Write failing valid/tampered/wrong-key tests**

Generate ephemeral Ed25519 keys with `generateKeyPairSync("ed25519")`. Assert a
valid manifest parses, one changed byte fails `RELEASE_SIGNATURE_INVALID`, and
an invalid image digest fails schema validation.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/release/test/manifest.test.ts`

Expected: FAIL on missing package.

- [ ] **Step 3: Implement canonical JSON signing input**

Use the exact UTF-8 bytes served as `manifest.json`; do not parse and
re-stringify before signature verification. Parse only after `verify(null,
bytes, publicKey, signature)` succeeds.

- [ ] **Step 4: Run tests, typecheck, and lint**

Run: `pnpm vitest run packages/release/test/manifest.test.ts && pnpm --filter @argus/release typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit manifest contracts**

```bash
git add packages/release
git commit -m "feat: define signed release manifests"
```

### Task 2: Multi-architecture Application and Management Images

**Files:**
- Modify: `deploy/docker/Dockerfile`
- Create: `deploy/docker/Dockerfile.cli`
- Create: `packages/release/test/images.test.ts`

**Interfaces:**
- Consumes: `apps/cli`, application runtime, deployment assets.
- Produces: `ghcr.io/gpsxtreme/argus:<version>` and
  `ghcr.io/gpsxtreme/argus-cli:<version>` for linux/amd64 and linux/arm64.

- [ ] **Step 1: Write failing image metadata tests**

Use `docker image inspect` behind `ARGUS_IMAGE_TEST=1`. Assert the app image
runs as a non-root user, exposes 8788, and has a health check. Assert the CLI
image contains Node 24, `docker`, `docker compose`, and runs
`node apps/cli/dist/main.js --help`.

- [ ] **Step 2: Build both local images**

Run:
`docker build -f deploy/docker/Dockerfile -t argus-app:test .`

Run:
`docker build -f deploy/docker/Dockerfile.cli -t argus-cli:test .`

Expected: the metadata test initially fails on user, health, or CLI tools.

- [ ] **Step 3: Implement reproducible production stages**

Use `pnpm deploy`/workspace build output in a builder stage, copy only runtime
files into the final stages, pin the Node 24 base by digest in the release
manifest, create user `argus` in the app image, and add:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

The CLI image may run as root because it manages root-owned `/opt/argus` and
the Docker socket; document that boundary.

- [ ] **Step 4: Run image and application tests**

Run: `ARGUS_IMAGE_TEST=1 pnpm vitest run packages/release/test/images.test.ts`

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit image packaging**

```bash
git add deploy/docker packages/release/test
git commit -m "build: package Argus runtime images"
```

### Task 3: Canonical Host Wrapper

**Files:**
- Create: `packages/release/src/wrapper.ts`
- Create: `scripts/release/export-wrapper.ts`
- Test: `packages/release/test/wrapper.test.ts`

**Interfaces:**
- Produces: `renderArgusWrapper({ version, cliImageDigest }): string`.

- [ ] **Step 1: Write a failing wrapper snapshot test**

Assert the generated script:

```sh
exec docker run --rm -i \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/argus:/opt/argus \
  -v /etc/os-release:/host/etc/os-release:ro \
  "ghcr.io/gpsxtreme/argus-cli@sha256:..." "$@"
```

adds `-t` only when stdout is a TTY, forwards exit codes, and never uses
`latest`.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/release/test/wrapper.test.ts`

Expected: FAIL because renderer is absent.

- [ ] **Step 3: Implement the POSIX wrapper renderer**

Use an explicit fixed mount list. Do not mount the caller's home directory,
SSH directory, repository, or environment wholesale. Pass only
`ARGUS_INSTALL_ROOT=/opt/argus` and documented flags.

- [ ] **Step 4: Run snapshot and shell syntax checks**

Run: `pnpm vitest run packages/release/test/wrapper.test.ts`

Run:
`pnpm tsx scripts/release/export-wrapper.ts --fixture > dist/argus && sh -n dist/argus`

Expected: PASS.

- [ ] **Step 5: Commit the wrapper**

```bash
git add packages/release
git commit -m "feat: generate the Argus host command"
```

### Task 4: Stable Installer

**Files:**
- Create: `packages/release/src/installer.ts`
- Create: `scripts/release/export-installer.ts`
- Test: `packages/release/test/installer.test.ts`

**Interfaces:**
- Consumes: signed manifest URL, embedded Ed25519 public key.
- Produces:

```ts
export interface InstallerOptions {
  manifestUrl: string;
  publicKeyPem: string;
}

export function renderInstaller(options: InstallerOptions): string;
```

The export script writes the returned bytes as `install.sh`.

- [ ] **Step 1: Write failing shell-fixture tests**

Run the script against a local fixture server. Test unsupported OS, unsupported
architecture, bad manifest signature, bad wrapper checksum, missing Docker,
declined Docker install, successful Docker install approval through
`/dev/tty`, and idempotent reinstall.

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run packages/release/test/installer.test.ts`

Expected: FAIL because installer renderer is missing.

- [ ] **Step 3: Implement the installer**

The script must:

1. set `set -eu`;
2. detect `/etc/os-release` and `uname -m`;
3. write the embedded Ed25519 public key to a temporary file;
4. verify the signature with
   `openssl pkeyutl -verify -pubin -inkey <key> -rawin -in <manifest> -sigfile <signature>`
   before trusting artifact URLs;
5. verify the wrapper SHA-256 with `sha256sum`;
6. install Docker only after reading explicit approval from `/dev/tty`;
7. write `/usr/local/bin/argus` atomically with mode `0755`;
8. run `argus --version`;
9. print `argus onboard`.

Support `ARGUS_VERSION`, `ARGUS_MANIFEST_URL`, and
`ARGUS_INSTALL_DOCKER=0|1` for deterministic automation.

- [ ] **Step 4: Run fixture and ShellCheck validation**

Run: `pnpm vitest run packages/release/test/installer.test.ts`

Run: `shellcheck dist/install.sh`

Expected: PASS.

- [ ] **Step 5: Commit installer**

```bash
git add packages/release scripts/release package.json pnpm-lock.yaml
git commit -m "feat: add verified Argus installer"
```

### Task 5: Release Manifest Builder and Tagged Release Workflow

**Files:**
- Create: `scripts/release/create-manifest.ts`
- Create: `scripts/release/verify-manifest.ts`
- Create: `.github/workflows/release.yml`
- Test: `packages/release/test/create-manifest.test.ts`

**Interfaces:**
- Consumes: built image digests, FxEmbed bundle, wrapper, signing key secret.
- Produces: `manifest.json`, `manifest.sig`, `install.sh`, and GitHub Release.

- [ ] **Step 1: Write failing deterministic-manifest tests**

Given fixed inputs and `SOURCE_DATE_EPOCH`, assert byte-for-byte manifest
output and a valid signature. Assert duplicate tags and mutable image tags are
rejected.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/release/test/create-manifest.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the release workflow**

On tags matching `v*`:

1. run lint, typecheck, tests, and build;
2. build/push app and CLI images with Buildx for amd64/arm64;
3. resolve registry digests;
4. build and hash the pinned FxEmbed bundle;
5. generate wrapper and installer;
6. sign manifest with repository secret `ARGUS_RELEASE_ED25519_KEY`;
7. verify the signature with the public key;
8. create a GitHub Release and attach all non-image assets.

- [ ] **Step 4: Run local fixture release and workflow syntax validation**

Run: `pnpm tsx scripts/release/create-manifest.ts --fixture`

Run: `pnpm tsx scripts/release/verify-manifest.ts dist/release/manifest.json dist/release/manifest.sig`

Expected: PASS.

- [ ] **Step 5: Commit release automation**

```bash
git add scripts/release .github/workflows/release.yml packages/release
git commit -m "ci: publish signed Argus releases"
```

### Task 6: Clean-host Installer Matrix

**Files:**
- Create: `.github/workflows/installer-smoke.yml`
- Create: `scripts/e2e/installer-smoke.sh`
- Modify: `README.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: release candidate manifest and images.
- Produces: amd64/arm64 installation evidence.

- [ ] **Step 1: Add a failing smoke script**

The script installs twice, checks the wrapper checksum, runs `argus --version`,
performs non-interactive onboarding with a controlled Web source, and asserts
`argus doctor --json` returns `ok: true`.

- [ ] **Step 2: Run against a local candidate**

Run:
`ARGUS_MANIFEST_URL=http://fixture/release/manifest.json scripts/e2e/installer-smoke.sh`

Expected: FAIL until the candidate images are published locally.

- [ ] **Step 3: Wire the CI matrix**

Use Ubuntu amd64 and native/emulated arm64 runners. Test Docker-present and
Docker-absent paths separately. Upload installer, wrapper, Compose, and doctor
logs on failure without uploading `secrets.env`.

- [ ] **Step 4: Run full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS; installer workflow YAML parses and smoke script passes against
fixture artifacts.

- [ ] **Step 5: Commit installer verification**

```bash
git add .github/workflows/installer-smoke.yml scripts/e2e README.md docs/operations.md
git commit -m "test: verify Argus release installation"
```
