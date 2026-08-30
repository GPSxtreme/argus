# CLI contracts

Use `--json` for machine-readable results. Treat the CLI as the source of
truth: re-read `argus config schema --json` before creating or changing an
answers file; this reference intentionally does not duplicate schema fields.

Success has this envelope shape:

```json
{"contractVersion":1,"ok":true,"data":{}}
```

Failure has `contractVersion: 1`, `ok: false`, and `error.code`,
`error.message`, and optional `error.recovery`. Follow a returned `recovery`
command exactly; do not synthesize an alternative.

| Error code | Route |
| --- | --- |
| `CONFIRMATION_REQUIRED` | Ask user for confirmation, then rerun the same CLI command through its confirmation boundary. |
| `PROMPT_CANCELLED` | Stop and ask whether to resume. |
| `ONBOARDING_FILE_INVALID`, `ONBOARDING_FILE_MODE_UNSAFE`, `ONBOARDING_ANSWERS_INVALID` | Ask user to correct the non-secret answers file, re-read the live schema, then retry. |
| `ONBOARDING_FILE_CONTAINS_SECRET` | Stop; remove the secret field and rely on the CLI hidden prompt. |
| `SECRET_INPUT_REQUIRED`, `API_TOKEN_UNAVAILABLE` | Ask user to run the CLI from an interactive terminal so its hidden prompt can collect the required credential. |
| `DOCKER_NOT_INSTALLED`, `DOCKER_COMPOSE_UNAVAILABLE`, `DOCKER_DAEMON_UNREACHABLE`, `UNSUPPORTED_OS`, `UNSUPPORTED_ARCH`, `INSUFFICIENT_DISK`, `INSUFFICIENT_MEMORY`, `PORT_IN_USE`, `PREFLIGHT_FAILED` | Run `argus doctor --json`, summarize the result, and stop if the reported recovery needs new authority. |
| `LOG_SERVICE_INVALID`, `LOG_TAIL_INVALID`, `REPAIR_SERVICE_INVALID`, `CLI_USAGE_ERROR` | Ask user for a valid command argument, then retry. |
| `FXEMBED_NOT_VPS_MANAGED` | Do not run a host repair. Explain that targeted repair applies only to VPS-hosted FxEmbed. |
| `CLOUDFLARE_CREDENTIALS_REQUIRED`, `CLOUDFLARE_INSPECTION_REQUIRED`, `CLOUDFLARE_PLAN_STALE`, `FXEMBED_ENDPOINT_REQUIRED`, `SEARXNG_ENDPOINT_REQUIRED` | Ask user for the missing non-secret choice or authorization; rerun the CLI inspection rather than editing infrastructure. |
| `ONBOARDING_PLAN_STALE`, `CONFIG_APPLY_PLAN_MISMATCH`, `CONFIG_SERVICE_PLAN_STALE` | Retry the non-mutating inspection, review the new plan, and request confirmation again. |
| `ONBOARDING_APPLICATION_MISMATCH`, `ONBOARDING_VERIFY_FAILED`, `CONFIG_APPLY_VERIFY_FAILED`, `REPAIR_VERIFY_FAILED`, `DIAGNOSTIC_FAILED`, `DIAGNOSTIC_TIMEOUT`, `LOGS_FAILED` | Run `argus doctor --json`; use the returned recovery or logs command exactly. |
| `RELEASE_*`, `CONFIG_SERVICE_*`, `CLOUDFLARE_*`, `SEARXNG_*`, `STORAGE_*`, `ARGUS_HEALTHCHECK_FAILED`, `FXEMBED_HEALTHCHECK_FAILED` | Run `argus doctor --json`; retry only if its error recovery says to retry, otherwise stop for user direction or authority. |
| Any unrecognized code | Stop, report code/message/recovery verbatim, and ask the user before taking another action. |
