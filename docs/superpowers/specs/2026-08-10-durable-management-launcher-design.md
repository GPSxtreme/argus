# Durable Argus Management Launcher Design

**Status:** Approved direction; written specification awaiting user review

**Date:** 2026-08-10

## Summary

Argus currently installs a root-owned `/usr/local/bin/argus` wrapper that pins
one management CLI image and version. `argus update` can update the runtime and
signed release context, but it cannot replace that host wrapper. Consequently,
runtime updates do not deliver management CLI fixes and an operator must run
the privileged installer again.

The durable launcher separates the stable host entry point from the versioned
management CLI. The root-owned launcher remains unchanged after one final
privileged installation. It reads a small, non-secret management state file
under `/opt/argus`, validates it without executing it, and launches the exact
digest-pinned CLI image recorded there. A verified update changes this state
atomically only after the runtime passes health verification.

After the bootstrap release, the normal lifecycle is one command:

```sh
argus update
```

No later update requires `curl`, `sudo`, or replacement of the global launcher.

## Goals

- Make `argus update` deliver both runtime and management CLI releases.
- Require at most one final privileged installer run for existing instances.
- Keep the host launcher small, offline, deterministic, and version-independent.
- Continue running only digest-pinned management images from verified signed
  release manifests.
- Make update failure and rollback recoverable without leaving an ambiguous
  active CLI version.
- Keep deployment state, service image inventory, release context, and launcher
  state consistent.

## Non-goals

- The launcher will not fetch manifests, verify signatures, or contact the
  network itself.
- The management container will not mount or overwrite `/usr/local/bin/argus`.
- Argus will not retain the legacy version-pinned wrapper as a compatibility
  path after bootstrap.
- This work will not introduce a daemon, package repository, background
  auto-updater, or unattended update policy.
- This work will not change runtime health policy or source-ingestion behavior.

## Approaches Considered

### Selected: immutable launcher plus atomic management state

The launcher reads a strict state file containing the active Argus version and
management CLI image reference. The updater atomically changes the file after
successful verification.

This preserves the existing Docker-based CLI boundary, avoids privileged
self-modification, and makes later CLI fixes available on the next command.

### Rejected: management container replaces the host wrapper

This would require mounting `/usr/local/bin` or the wrapper itself writable
inside the management container. It expands the container's host mutation
authority, complicates atomic replacement and rollback, and still encounters
root ownership on every update.

### Rejected: run the signed installer for every release

This preserves the current implementation but violates the one-command update
requirement and repeatedly asks the operator for privileged execution.

## Host Components

### Immutable launcher

`/usr/local/bin/argus` is a release-independent POSIX shell program. It retains
the existing architecture checks, Docker socket checks, constrained container
settings, fixed mounts, host networking, argument preservation, TTY behavior,
and inspection mode.

Instead of embedding `argus_version` and `argus_cli_image`, it reads them from:

```text
/opt/argus/management.state
```

The launcher never sources or evaluates this file. It reads exact line
positions and accepts only this three-line grammar:

```text
schema=1
version=<normalized SemVer>
cli_image=<canonical registry reference>@sha256:<64 lowercase hex characters>
```

Missing, duplicate, reordered, extra, malformed, symlinked, or oversized state
fails closed before Docker runs. The error tells the operator to rerun the
signed installer. The file contains no credentials and is readable but not
writable by ordinary host users.

The validated version becomes `ARGUS_VERSION`; the validated image reference
is passed to `docker run`. `argus --version` therefore reports the active
management release without changing the launcher binary.

### Management state writer

The release integration owns management state serialization. It writes a
temporary file in `/opt/argus`, applies the intended mode, syncs the file,
renames it over `management.state`, and syncs the directory. No other component
writes this file.

The writer accepts only a previously verified release object and derives both
fields from the same signed manifest:

- `version` from `manifest.version`;
- `cli_image` from `manifest.images.cli.reference`.

## Installation and Bootstrap

The bootstrap release's signed installer performs the existing signature,
asset, platform, Docker, and wrapper checks. It additionally prepares a valid
management state from the verified manifest before installing the durable
launcher.

For an existing instance with the legacy wrapper:

1. The operator runs the stable installer once with the privilege required to
   replace `/usr/local/bin/argus`.
2. The installer atomically writes `management.state` for the bootstrap
   release.
3. The installer verifies the new launcher against that state before replacing
   the legacy wrapper.
4. The durable launcher becomes the permanent host entry point.

If state preparation or launcher verification fails, the legacy wrapper is
preserved. The installer does not delete a user-local recovery wrapper.

Fresh installations receive the durable launcher and management state from the
start.

## Update Transaction

`argus update` continues to inspect one exact signed plan before mutation. For
a non-noop update it performs these ordered phases:

1. Persist the inspected plan and verified rollback release.
2. Back up managed deployment state and SQLite files where applicable.
3. Pull the target images and run migrations.
4. Reconcile the runtime to the target image digests.
5. Verify required services.
6. Persist deployment state with the target version and update both
   `compose.images` and every corresponding `services.*.image` entry.
7. Promote the exact signed release context.
8. Atomically promote `management.state` to the target CLI version and digest.
9. Persist a final verified transaction phase and return success.

The running update command continues in its original container. The newly
promoted management CLI is used by the next `argus` invocation.

A noop update still verifies service health and rewrites missing or stale
management state from the current verified release. This makes an interrupted
final promotion safely retryable.

If runtime verification fails, neither the signed release context nor
management state advances. If management-state promotion fails after the
runtime succeeds, the command fails visibly while the previous CLI remains
active and capable of retrying the noop repair path.

## Rollback

Rollback uses the persisted verified rollback release and reverses the same
boundaries:

1. Restore backed-up state and data where applicable.
2. Reconcile the runtime to the rollback image digests.
3. Verify required services.
4. Restore internally consistent deployment and service image state.
5. Promote the rollback signed release context.
6. Atomically promote management state to the rollback CLI version and digest.

Management state never points at the rollback CLI until the rollback runtime is
verified.

## Security Model

- The Ed25519-signed manifest remains the authority for versions, assets, and
  image digests.
- The launcher trusts only the locally promoted strict state file; it does not
  parse the larger release context or trust environment overrides.
- The state file is data, never shell input, and every value is validated again
  at the host boundary.
- The launcher keeps the existing read-only container, dropped capabilities,
  no-new-privileges, bounded tmpfs, fixed mounts, and digest-pinned image.
- No secrets are added to management state, logs, JSON output, or errors.
- A user with Docker socket write access already has host-equivalent authority;
  this design does not grant the management container any additional host
  filesystem mount.

## Error and Recovery Contracts

The launcher emits concise host errors for missing or invalid management state
and does not run Docker. The CLI uses stable structured errors for management
promotion failures and recommends retrying the inspected update before
rollback.

Recovery boundaries are explicit:

- invalid or missing launcher state: rerun the signed installer;
- runtime update failure: diagnose services, then retry or use verified
  rollback;
- final management promotion failure: retry `argus update`, which follows the
  noop repair path;
- corrupted signed context: restore the verified release context or rerun the
  signed installer.

## Verification

### Unit and contract tests

- Accept the exact management-state grammar.
- Reject injection, whitespace ambiguity, duplicate/extra/reordered lines,
  symlinks, oversized files, invalid SemVer, and noncanonical image references.
- Preserve hostile arguments, TTY behavior, signals, exit codes, and wrapper
  inspection output.
- Prove update success promotes management state last.
- Prove runtime failure leaves management state unchanged.
- Prove a failed final promotion is repaired by a noop retry.
- Prove rollback restores runtime, release context, deployment image inventory,
  and management state together.

### Installer and integration tests

- Fresh installation produces a working durable launcher.
- One bootstrap installation replaces a recognized legacy wrapper safely.
- Reinstallation is idempotent and does not rewrite an identical launcher.
- Tampered management state fails before Docker execution.
- A real update changes `argus --version` on the next invocation without
  replacing `/usr/local/bin/argus`.

### Release and VPS acceptance

- Extend signed installer matrices to exercise the durable launcher on each
  supported architecture and distribution.
- On the permanent VPS, capture the global launcher checksum, apply an update,
  confirm the checksum is unchanged, confirm `argus --version` advances, and
  verify X, Telegram, URL, RSS, and Web-query jobs after the update.
- Keep a verified SQLite backup before the bootstrap acceptance run.

## Delivery Boundary

This design ships as one focused launcher/update change. The bootstrap release
must not be promoted stable until installer matrices, update and rollback
integration tests, clean-host smoke tests, and permanent-VPS acceptance all
pass. After that promotion, the operator performs the final privileged
installer run once; all later supported updates use `argus update` alone.
