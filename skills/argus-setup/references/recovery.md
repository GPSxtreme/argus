# Recovery routing

For an unhealthy status or failed command:

1. Run `argus doctor --json`.
2. Summarize every unhealthy check as component, code, and message.
3. If a check includes `recovery`, use that returned command exactly. If it
   includes `logsCommand`, use it exactly; otherwise use `argus logs <component> --json`.
4. If recovery needs a targeted managed repair, inspect `argus repair <component>
   --dry-run --json`, explain the plan, and request approval before the CLI
   mutates host state or an explicitly selected Cloudflare deployment.
5. Run the approved repair through the CLI, then rerun `argus doctor --json`.
6. Report any remaining failure with its component, code, message, and returned
   recovery. Do not improvise a direct infrastructure command.

Stop when the CLI requests new authority. Stop when the returned recovery is
missing, unclear, or is outside the user's approved scope. Never edit Compose,
deployment state, managed settings, backups, or secret files directly.
