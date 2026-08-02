---
name: argus-setup
description: Use when installing, setting up, onboarding, configuring, deploying, diagnosing, repairing, updating, or checking the status of an Argus VPS deployment.
---

# Argus setup

Use the Argus CLI as the sole authority for validation, deployment, repair, and
health. Do not edit deployment files, state, managed-service settings, or
backups directly.

## Route the request

| Request | Start with |
| --- | --- |
| New install or configuration | `argus status --json`, then `argus config schema --json` |
| Existing instance | `argus status --json` |
| Unhealthy instance | `argus doctor --json` |
| Logs for a reported component | `argus logs <component> --json` |
| Repair or update | Inspect the CLI plan and obtain confirmation before mutation |

## Install and onboard

1. Detect `argus` with `argus --help`. If it is unavailable, explain the
   required installation and ask for authorization before installing it.
2. Inspect `argus status --json`, even for a fresh host, then read the live
   `argus config schema --json`. Never copy schema fields from this skill.
3. Gather only non-secret requirements. Use
   [setup choices](references/setup-choices.md) for defaults.
4. Create a non-secret answers file that matches the live schema and validate
   it with `argus config validate <file> --json`.
5. Tell the user which hidden secret prompts the CLI will show. Do not ask for,
   display, or place secret values in chat or the answers file.
6. Call `argus onboard --from <file> --json`. Inspect the plan/result and get
   explicit approval at the CLI confirmation boundary for external changes.
7. Run `argus doctor --json`; report its exact health result and the returned
   recovery or log command for every unhealthy check.

## Status, diagnosis, and repair

Read [CLI contracts](references/cli-contracts.md) before interpreting a JSON
result. For unhealthy checks, follow the recovery routing reference.

Stop and ask the user when the CLI requests new authority, when a plan changes
host or Cloudflare state, or when a returned recovery command is unclear. Do
not invent an infrastructure command.
