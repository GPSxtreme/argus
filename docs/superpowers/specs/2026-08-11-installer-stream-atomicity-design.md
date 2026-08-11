# Installer Stream Atomicity Design

## Context

Argus v0.1.14 is installed with:

```sh
curl -fsSL https://argus.gpsxtre.me/install.sh | sudo sh
```

During real VPS acceptance, the streamed invocation pulled the new CLI image and then POSIX `sh` reported an unterminated quoted string at line 1032 of the 1044-line installer. The installer transaction did not promote either live file: `/usr/local/bin/argus` remained v0.1.11 and `/opt/argus/management.state` remained absent. A subsequent complete download was 49,934 bytes, matched the published SHA-256, passed `sh -n`, and completed the same temporary-wrapper version check. This evidence is consistent with the original transfer ending near EOF.

The live-file transaction is fail-closed, but the streamed program itself is not parse-atomic. A partial transfer can download assets, pull images, and stage temporary files before the shell discovers that the program is incomplete.

## Goal

Keep the one-command install experience while guaranteeing that no installer body operation executes until the shell has received and parsed the complete installer program.

## Non-goals

- Change manifest, signature, image, launcher, or management-state trust rules.
- Change installer transaction ordering or recovery semantics.
- Add retries that could hide a broken or partial transfer.
- Add a second bootstrap protocol or another network request.
- Preserve byte compatibility with earlier installer assets.

## Design

`renderInstaller` will emit the existing installer body inside one POSIX shell function and invoke that function only after its closing brace:

```sh
#!/bin/sh
argus_install_main() {
  set -eu
  # Existing generated installer body, unchanged in behavior.
}
argus_install_main "$@"
```

A POSIX shell parses the complete function definition before executing its body. If the stream ends anywhere before the closing brace, parsing fails before `set -eu`, temporary-directory creation, downloads, Docker operations, or host mutation. Once parsing succeeds, the function runs the existing installer exactly once with the original arguments.

The function is deliberately not a separate bootstrap downloader. Keeping the trust and installation logic in one generated program avoids a second verification path and preserves the current signed-release architecture.

## Error and recovery behavior

- A truncated stream exits non-zero with a shell parse error and creates no installer-observable side effects.
- A complete stream enters the existing installer body and retains all current cleanup traps, atomic pair promotion, rollback, and recovery diagnostics.
- Signals and explicit `exit` calls retain their current whole-process behavior because the function runs in the top-level shell, not a subshell.
- Installer output remains unchanged for a complete successful run.

## Verification

Tests will mutation-prove the parse gate:

1. Render a valid installer and verify the complete script still passes `sh -n` and existing installer suites.
2. Truncate the rendered bytes at representative early, middle, and near-EOF positions, including inside a quoted string near the final transaction block.
3. Execute each truncated script against a fixture with observable command/network/mutation markers.
4. Assert non-zero exit and zero markers, downloads, Docker calls, target writes, or state writes.
5. Add a structural contract that the only top-level executable statement after the function definition is `argus_install_main "$@"`.

Existing installer, installer-smoke, release-manifest, stable-promotion, shell-syntax, typecheck, lint, and build gates remain required.

## Release and acceptance

Because immutable v0.1.14 assets cannot change, the fix ships as v0.1.15. The signed release is promoted atomically to the stable installer, manifest, and signature. VPS acceptance then repeats the exact public command, verifies the durable launcher and management state, updates the running deployment, confirms launcher immutability, and compares SQLite/source-health baselines before and after.
