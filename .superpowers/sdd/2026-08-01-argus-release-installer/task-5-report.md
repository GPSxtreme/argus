# Task 5 report — signed releases and production composition

## Implemented

- Added a deterministic V1 manifest builder driven by `SOURCE_DATE_EPOCH`.
  It emits the existing canonical byte contract, accepts only all four named
  digest-pinned image references exactly once, hashes the FxEmbed and wrapper
  bytes, signs the exact manifest bytes with an Ed25519 private key, and
  derives the corresponding public key.
- Added release creation and verification CLIs. Production creation requires
  explicit image digests, source epoch, pinned artifacts, release URL, and
  signing key; fixture mode creates locally verifiable manifest, signature,
  installer, wrapper, and FxEmbed assets.
- Added a tag-triggered GitHub Actions release workflow that validates SemVer
  tags, runs lint/typecheck/test/build, publishes linux/amd64 and linux/arm64
  application and management image indexes, resolves all four deployed image
  digests, builds a pinned upstream FxEmbed worker, renders the digest-pinned
  wrapper and signed installer, verifies all generated assets, and attaches
  non-image artifacts to the GitHub Release.
- Added `ProductionOnboardingIntegration`. It bounded-downloads the exact
  manifest/signature bytes, verifies the signature and canonical bytes before
  using signed fields, bounded-downloads and SHA-256 verifies FxEmbed, derives
  the concrete deployment from signed image identities, inspects and binds an
  exact plan, and refuses a stale application.
- Production apply atomically persists the exact signed manifest, signature,
  and FxEmbed bytes without secrets; safely renders/writes configuration and
  secrets; reconciles managed FxEmbed/SearXNG and the desired Compose
  deployment; and preserves the existing deployment state contract.
  Subsequent verification reloads and cryptographically reverifies the
  persisted context before trusting release or desired deployment identity.
- Added `InstalledConfigIntegration` and authenticated in-service
  plan/apply/verify endpoints. The plan ID binds the config path, prior content
  hash, and exact desired content hash. Apply recomputes and compares the
  complete plan before repository mutation. The management client reaches
  application storage only through the authenticated service boundary.
- Wired both concrete integrations from the CLI bootstrap using the embedded
  release public key/manifest URL and installed API token/port. The release
  package is included in the management image build while the reviewed
  `iproute2`/`ss`, host mounts, `ARGUS_HOST_ARCH`, and `ARGUS_VERSION`
  contracts remain unchanged.
- Added read-only Cloudflare worker inspection so managed FxEmbed planning has
  the actual worker bundle hash, workers.dev state, and endpoint before apply.

## FxEmbed provenance

- Upstream: `https://github.com/FxEmbed/FxEmbed.git`
- Immutable revision:
  `f088a632e56e5cb8084f87d55f74a24d1fcda6f6`
- License: MIT, upstream `LICENSE.md`
- License SHA-256:
  `30ee0a78e6df8c8210bbee02a477c57f2cf8c7db13a756ea577678aee7014d37`
- `package-lock.json` SHA-256:
  `88ae1a737ca41e9a7d69593fd9e82ad35dee90d4fabc51ae3c5b33d5868535bc`
- Compatibility date: `2026-04-11`
- Verified local immutable-source build under Node 24 produced
  `dist/worker.js` (1,342,355 bytes), SHA-256
  `aee0406fc38830fce35e4d493bc93a44d0a3aa15f7305fe2a36e8185b588c868`.
- The workflow independently verifies the checked-out revision, license hash,
  and lockfile hash before running the documented worker build commands.
  Machine-readable provenance is published with every release.

## TDD evidence

### RED

Command:

`fnm exec --using=24.16.0 /opt/homebrew/bin/pnpm vitest run packages/release/test/create-manifest.test.ts`

Expected failure: the new manifest builder export did not exist.

The production integration tests were likewise authored against absent
concrete onboarding/config composition. During self-review, a new regression
test for inspecting a missing Cloudflare worker failed with
`CLOUDFLARE_REQUEST_FAILED`, proving the inspector queried per-worker
subdomain state before establishing that the worker existed.

### GREEN

- Manifest builder focused suite: 3/3 passed, covering byte-for-byte
  determinism, detached Ed25519 verification, duplicate names, and mutable
  image references.
- Final full `pnpm test`: 40 files passed, 2 opt-in files skipped; 397 tests
  passed, 8 opt-in tests skipped, 0 failures.
- Final `pnpm typecheck`: 15/15 packages successful.
- Final `pnpm build`: 15/15 packages successful.
- Final `pnpm lint`: 162 files checked, no warnings or errors.
- `create-manifest.ts --fixture` and `verify-manifest.ts` passed; the generated
  FxEmbed fixture passed `node --check`, and generated wrapper/installer passed
  `sh -n`.
- Release workflow YAML parsing and `git diff --check` passed.

## Focused coverage

- Exact canonical manifest bytes and signature validity.
- Duplicate/mutable release image rejection.
- Concrete integration composition from embedded release identity.
- Exact-plan onboarding application and persisted signed-context
  reverification.
- Signature and FxEmbed hash failure before install-root mutation.
- Authenticated installed-config plan/apply/verify and stale-plan rejection.
- In-service SQLite integration without direct management-client storage
  access; the existing management-container boundary test continues to assert
  that application database paths are never opened.
- Managed FxEmbed inspection with an absent worker, including the rule that
  per-worker subdomain state is not queried until the worker exists.

## Files changed

- `.github/workflows/release.yml`
- `scripts/release/create-manifest.ts`
- `scripts/release/verify-manifest.ts`
- `scripts/release/fxembed-provenance.json`
- `packages/release/src/builder.ts`
- `packages/release/src/index.ts`
- `packages/release/test/create-manifest.test.ts`
- `apps/cli/src/integrations.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/program.ts`
- `apps/cli/test/integrations.test.ts`
- `apps/cli/test/onboard.test.ts`
- `apps/cli/package.json`
- `apps/argus/src/management-config.ts`
- `apps/argus/src/app.ts`
- `apps/argus/src/index.ts`
- `apps/argus/test/app.test.ts`
- `packages/deployment/src/fxembed.ts`
- `packages/deployment/src/config.ts`
- `packages/deployment/package.json`
- `packages/deployment/test/fxembed.test.ts`
- `packages/deployment/test/config.test.ts`
- `apps/cli/test/process.test.ts`
- `deploy/docker/Dockerfile.cli`
- `pnpm-lock.yaml`
- `turbo.json`

## Self-review

- Confirmed manifest fields are not used until exact-byte Ed25519 and canonical
  verification succeeds, and FxEmbed bytes are not trusted until their signed
  SHA-256 matches.
- Confirmed release context contains only public signed artifacts, uses
  same-directory atomic replacement plus file/directory sync, and verification
  reloads those persisted bytes rather than reconstructing trust from mutable
  config or deployment state.
- Confirmed onboarding apply re-inspects the current deployment and compares
  the complete release/plan object before any mutation.
- Confirmed management API authentication remains mandatory even if a normal
  API token is not configured, and the client does not import or instantiate
  SQLite/Postgres repositories.
- Confirmed all deployed image references written into the manifest are
  multi-architecture index digests, not mutable tags.
- Corrected a self-review fixture defect where the fixture worker ended in a
  literal backslash-n rather than a newline, then added `node --check` to the
  final local release verification.

## Independent review

A read-only reviewer covered security, workflow correctness, FxEmbed
provenance/reproducibility, both integration boundaries, edge cases, tests, and
production readiness. Its initial verdict was not ready to merge:

- **Critical:** the pre-existing minimal instance renderer dropped watches,
  processors, Postgres/OpenRouter secrets, and a usable authenticated Postgres
  URL.
- **Important:** an explicit config path bypassed the in-service boundary and
  opened application storage from the management container.
- **Important:** onboarding downloads had byte bounds but no hard timeouts.
- **Important:** a same-tag workflow rerun could resolve new upstream digests
  and replace release assets.

All four findings were confirmed and fixed before commit:

- Rendering now faithfully maps watches/inputs/classification/retention,
  Telegram, OpenRouter intelligence/model/summary processors, and all required
  secret references. Postgres uses the `argus` user plus a separate
  URL-encoded password environment value while Compose receives the raw
  password. The deployment config hash binds a hash of the secret environment
  without exposing secrets.
- Both default and explicit-path config apply use
  `InstalledConfigIntegration`; all direct repository planning/apply/verify
  branches and imports were removed from the management client.
- Manifest, signature, and FxEmbed requests use clamped hard
  `AbortController` deadlines in addition to streaming byte bounds.
- The workflow reserves a draft GitHub Release before the first registry
  mutation. Existing same-tag reservations make reruns fail closed; the final
  asset step publishes that reserved draft.

Fix-round RED evidence included the incomplete Postgres renderer assertion, a
hanging-fetch test timeout, the existing explicit-path direct-storage behavior,
and the missing release-reservation ordering assertion.

Fix-round GREEN:

- Focused config/integration/process/release-workflow tests: 20/20 passed.
- Fresh full tests: 397 passed, 8 opt-in skipped.
- Typecheck and build: 15/15 packages each.
- Lint: 162 files clean.

## Concerns

- The GitHub-hosted release, GHCR multi-architecture push, and credentialed
  Cloudflare live path were not executed locally because they require external
  release credentials and mutations. The workflow and generated local release
  artifacts were validated, and the repository's opt-in Docker/Cloudflare/
  Postgres live suites remain intentionally skipped.
- GitHub Actions are referenced by their maintained major release tags, in
  line with the repository's existing workflows; they are not pinned to action
  commit SHAs.
- On the one allowed attempt for a tag, the release workflow resolves the
  current SearXNG upstream index selected by `latest`, then records and deploys
  only the immutable resolved digest. The early GitHub Release reservation
  prevents a rerun from selecting a different digest for the same tag. The
  published manifest and all runtime deployment plans contain no mutable
  SearXNG tag.

## Formal review fix round 1

The management CLI no longer exposes the application `run` command or imports
the application runtime. Its production dependency graph and Docker image no
longer copy application/storage workspaces or package `better-sqlite3`; the
separate application image retains the runtime and native storage adapter.

Compose now receives the exact digest-pinned `ARGUS_IMAGE` from the verified
manifest, including alternate registries, and every Compose execution has a
clamped deadline even for executors that ignore their timeout option. Generated
`secrets.env` values are single-quoted and escaped so Compose metacharacters
survive faithfully.

Both management HTTP integrations race the complete fetch-and-body-read
operation against a hard deadline. Release versions containing SemVer build
metadata are rejected before OCI publication.

The runner is fixed to Ubuntu 24.04; Node 24.16.0, npm 11.13.0, and pnpm
10.33.0 are checked exactly. Every release action is pinned to a full commit SHA
with a version comment. FxEmbed provenance records its exact Node version and
expected output SHA-256, which the workflow verifies after rebuilding.

Review-round RED: 4 files failed, 6 tests failed, 51 passed, and 2 opt-in image
tests skipped. Review-round GREEN: 60 focused tests passed with 2 opt-in image
tests skipped; 8 Compose/HTTP regression tests passed; typecheck passed 15/15
packages; lint checked 162 files clean.
