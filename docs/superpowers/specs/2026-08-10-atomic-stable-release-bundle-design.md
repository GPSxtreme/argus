# Atomic Stable Release Bundle Design

**Date:** 2026-08-10

## Problem

Argus currently renders `/install.sh` from the code deployed on `main`, while
`/releases/stable/manifest.json` and `manifest.sig` are separately pinned
files. A deployment can therefore publish a new installer before the stable
manifest points to a wrapper that installer accepts. Fresh installation would
fail during that release window.

The public bootstrap surface must never expose installer bytes from one release
with signed manifest bytes from another.

## Decision

Treat these files as one stable release bundle:

```text
apps/web/public/releases/stable/install.sh
apps/web/public/releases/stable/manifest.json
apps/web/public/releases/stable/manifest.sig
```

The public `/install.sh` route serves the checked-in stable installer bytes.
It does not render the installer from the current application source at request
or build time.

A stable promotion updates all three files in one commit. Until that commit is
deployed, the previous complete bundle remains available. After deployment,
the new complete bundle is available. Deploying unrelated `main` changes cannot
alter the bootstrap installer.

## Trust and compatibility invariants

- `manifest.json` verifies against `manifest.sig` and the embedded stable
  Ed25519 public key.
- `install.sh` embeds the same public key and the canonical stable manifest URL.
- The installer SHA-256 is pinned by tests alongside the manifest and signature
  hashes.
- The signed manifest's wrapper asset is accepted by the bundled installer.
- The wrapper asset and CLI image remain digest-pinned signed release inputs.
- Promotion fails if any bundle member is missing, malformed, or mismatched.
- No legacy runtime fallback is added. A release bundle is internally exact or
  it is not promoted.

## Serving behavior

`GET /install.sh` reads the checked-in stable installer file and responds with:

- `Content-Type: text/x-shellscript; charset=utf-8`
- `Cache-Control: public, max-age=300, stale-while-revalidate=3600`

The route fails rather than silently rendering a replacement if the pinned file
is unavailable.

The stable manifest and signature retain their existing explicit cache and
content-type headers.

## Promotion flow

1. Build a signed release candidate and its durable wrapper.
2. Verify the candidate manifest, signature, installer, wrapper checksum, and
   image digests using the release toolchain.
3. Copy the exact candidate `install.sh`, `manifest.json`, and `manifest.sig`
   into the stable bundle paths.
4. Run stable-bundle tests and the clean-host installer smoke.
5. Commit all three files together and merge through the normal reviewed path.
6. After deployment, verify public bytes match the committed hashes before
   running the real VPS installer/update acceptance test.

Promotion tooling must refuse a partial update. Ordinary feature PRs do not
modify stable bundle bytes.

## Testing

Automated coverage must prove:

- `/install.sh` response bytes equal the checked-in stable installer bytes;
- the three pinned hashes are exact;
- manifest signature verification succeeds;
- installer trust root and stable manifest URL are exact;
- the signed wrapper asset is compatible with the installer contract;
- changing the release renderer without promoting the bundle does not change
  the public installer route;
- a partial or mismatched bundle fails verification;
- the release promotion diff contains all required changed bundle members;
- clean-host and VPS acceptance consume the same promoted public bundle.

## Operational recovery

If promotion verification or deployment fails, keep or restore the previous
three-file bundle as a unit. Never repair production by changing only the
installer, manifest, or signature. Because every bundle is committed, rollback
is a normal revert of the complete promotion commit.

## Scope

This change only makes the existing stable release channel internally atomic.
It does not add release channels, a package registry, compatibility shims, or a
new deployment service.
