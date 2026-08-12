# Stable Bundle No-op Artifact Policy Design

## Problem

Stable promotion always materializes `install.sh`, `manifest.json`, and `manifest.sig` atomically. Git records only byte changes. Because the stable installer is rendered from a fixed stable manifest URL and fixed trust root, promoting v0.1.16 correctly leaves `install.sh` byte-identical while changing the signed manifest and signature.

The current CI diff policy requires all three paths to differ whenever any stable path changes. It therefore rejects a valid deterministic promotion and can only be satisfied by corrupting or pointlessly perturbing the installer.

## Goals

- Accept deterministic stable promotions when the installer is a byte-level no-op.
- Preserve atomic signed identity: `manifest.json` and `manifest.sig` must always change together.
- Continue requiring `install.sh` whenever its canonical rendered bytes genuinely change.
- Reject partial, installer-only, or extra stable-directory mutations.
- Keep final-state signature, trust-root, canonical installer, build, and route verification unchanged.

## Non-goals

- No change to release artifacts, stable promotion transaction, installer rendering, trust roots, routes, or runtime behavior.
- No version nonce, whitespace mutation, timestamp, or other mechanism whose only purpose is forcing a Git diff.
- No compatibility fallback or manual stable-file editing.

## Considered Approaches

### 1. Semantic changed-set policy — selected

Permit exactly two stable changed-file sets:

- `manifest.json` and `manifest.sig`;
- `install.sh`, `manifest.json`, and `manifest.sig`.

This models the actual invariant: signed identity always advances as a pair, while the deterministic installer changes only when its stable URL/trust renderer changes.

### 2. Force every installer to differ

Adding a release version, timestamp, nonce, or formatting change would destroy useful reproducibility and create artifact churn without changing behavior.

### 3. Compute base and candidate installer bytes inside the diff policy

This can derive whether `install.sh` should differ, but duplicates renderer/final-state verification in a path-set guard and adds unnecessary repository-history plumbing. Existing stable-asset and promotion tests already verify the canonical bytes.

## Policy Contract

Given the Git diff selected by `scripts/ci/assert-stable-bundle-change.mjs`:

1. If no file under `apps/web/public/releases/stable/` changed, pass.
2. If any changed stable path is not `install.sh`, `manifest.json`, or `manifest.sig`, fail.
3. Require both `manifest.json` and `manifest.sig` whenever any stable path changes.
4. Permit `install.sh` only alongside that required pair.
5. Therefore accept exactly the two-file pair or the three-file set; reject every other stable changed set.

The policy examines changed paths only. It does not claim the resulting bytes are valid. The existing promotion verifier and `apps/web/test/stable-release-assets.test.ts` remain responsible for verifying:

- the manifest signature against the checked-in stable Ed25519 trust root;
- the promoted release identity and signed asset hashes;
- the stable installer bytes rendered from the fixed stable manifest URL and trust key;
- the public route/build artifact containing the stable installer.

## Testing

Extend the existing real temporary-Git-history policy suite with exact cases:

- no stable change passes;
- `manifest.json + manifest.sig` passes;
- all three stable files pass;
- only manifest, only signature, only installer, manifest+installer, and signature+installer each fail;
- any extra file under the stable directory fails, including when combined with an otherwise valid pair/set;
- unrelated repository paths may change alongside either valid stable set.

Run the policy suite RED before implementation, then GREEN. Mutation-prove it by temporarily restoring the exact-three requirement and observing the two-file case fail. Run Node 24.19.0 typecheck, lint, full tests, build, and diff checks before merge.

## Release Recovery

Ship this policy correction in its own reviewed PR to `main`. It does not require a new release tag because it changes CI acceptance only. After merge, resume the frozen v0.1.16 promotion from a fresh main-based promotion branch, regenerate the bundle, and let Git record the two changed signed files. The promotion PR must still pass all stable final-state verification before merge.

## Acceptance

- A real v0.1.16 promotion with unchanged canonical `install.sh` and changed `manifest.json + manifest.sig` passes CI.
- A partial or extra stable mutation still fails closed.
- Public stable bytes remain generated and verified; no artifact is manually altered to satisfy the policy.
