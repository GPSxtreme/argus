# Installer Smoke CLI Image Validation Design

## Problem

The post-release Installer smoke matrix fails every supported host after a successful signed installation with `management state has an invalid CLI image`.

The smoke harness reads the canonical three-line management state and applies a POSIX `case` glob containing 65 repeated hexadecimal character classes after `@sha256:`. OCI SHA-256 digests contain exactly 64 hexadecimal characters. The harness therefore rejects every valid state.

The expected CLI image has already been validated earlier in the same script using the authoritative 64-character rule, and the parsed state value is compared exactly with that expected image immediately after the broken glob.

## Goals

- Restore clean-host installer/onboarding coverage across the full smoke matrix.
- Preserve fail-closed exact equality between the installed management state and signed expected CLI image.
- Reject invalid expected CLI image references before installation.
- Remove duplicated OCI grammar instead of repairing and retaining two validators.

## Non-goals

- No production installer, wrapper, management-state, release, image, or trust change.
- No change to the matrix, supported distributions, architectures, Docker-present/absent coverage, or onboarding flow.
- No retry, allowlist, or ignored-failure mechanism.

## Design

Remove the management-state `case` block that independently attempts to validate the CLI image grammar. Retain both authoritative checks:

1. Before installation, `ARGUS_EXPECTED_CLI_IMAGE` must match the normalized digest-pinned OCI regular expression ending in exactly `[a-f0-9]{64}`.
2. After installation, the complete parsed state line must equal `cli_image=$ARGUS_EXPECTED_CLI_IMAGE` byte-for-byte.

These checks are sufficient together. The first proves the expected value is structurally valid; the second proves the installed state contains exactly that signed expected value. Re-parsing the same value with a manually expanded shell glob adds no security property and caused the current false negative.

## Testing

Add an executable regression to `packages/release/test/installer-smoke.test.ts` using the real smoke verifier boundary:

- a canonical state containing a valid digest-pinned CLI reference with 64 lowercase hexadecimal characters passes management-state verification;
- otherwise identical references with 63 or 65 characters fail before onboarding acceptance;
- a structurally valid but different 64-character digest fails exact equality.

Run the test RED against the existing 65-character glob. After removing the glob, run it GREEN and mutation-prove it by changing the valid fixture digest away from the expected value and confirming rejection.

Run Node 24.19.0 focused installer-smoke/release tests, typechecks, lint, build, and diff checks. Push a separate reviewed PR. After merge, rerun the failed v0.1.16 Installer smoke workflow and require every matrix job to pass before treating v0.1.16 release acceptance as complete.

## Acceptance

- Valid canonical v0.1.16 management state passes the smoke verifier.
- Invalid or mismatched state still fails closed.
- All Installer smoke matrix jobs complete signed install and onboarding successfully.
- No production artifact bytes or public release identity change.
