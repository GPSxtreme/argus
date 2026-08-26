# Argus CLI Human UX Design

## Goal

Make Argus approachable for someone who has never operated a self-hosted service while preserving deterministic direct commands and stable JSON output for scripts and agents.

The default human experience must guide the user, summarize what matters, and keep internal deployment state out of ordinary output. Advanced users must still be able to invoke every operation directly. Machine-facing `--json` contracts for existing direct commands remain unchanged; bare `argus --json` becomes an additive help-success behavior.

## Problems confirmed in v0.1.22

- Bare `argus`, `argus config`, and `argus secrets` return a generic usage error instead of guiding the user.
- `argus status` can print an empty service state.
- `argus logs` exposes Docker Compose prefixes, raw Pino JSON, process metadata, UUIDs, and multiline dependency traces without a readable default view.
- Human dry-run output serializes entire internal plans, signed manifests, rollback context, image digests, and prior management state.
- `argus config show` renders runtime configuration as dense JSON even though Argus configuration is authored as YAML.
- Human errors lead with internal error codes and generic recovery text.
- Existing automated coverage emphasizes correctness and JSON stability but does not exercise the CLI as a person sees it in a terminal.

## Interaction model

### Bare invocation

When stdin and stdout are interactive terminals, `argus` opens a Clack-powered home menu:

1. Set up Argus
2. Check status
3. View logs
4. Manage configuration
5. Run diagnostics
6. Update Argus
7. Start, stop, or restart services
8. Manage secrets
9. Exit

The selected item performs the operation. The menu does not merely print a command for the user to copy. After the selected operation finishes, the process exits cleanly; Argus does not become a long-running shell.

The menu delegates to the same command handlers used by direct invocations. It must not reimplement deployment, validation, confirmation, or redaction logic.

When either stream is non-interactive, bare `argus` prints root help and exits with status 0. Bare `argus --json` returns the existing versioned success envelope containing help text. It never opens a prompt in scripts, pipes, or agent executions.

### Command namespaces

Bare `argus config` and `argus secrets` print their contextual help and exit with status 0. Their direct subcommands continue to work unchanged.

The configuration menu offers view, validate, apply, and schema actions. The service menu offers status, start, stop, and restart. The logs menu asks for a service and bounded tail count. Mutating selections retain the existing inspect, confirm, apply, and verify flow.

### Direct commands

Every action available in the menu remains available as a direct command. The menu is a beginner entry point, not a separate product surface.

## Human output contract

### Status and diagnostics

Status starts with one clear summary and then lists enabled managed services with normalized states. Missing or empty health values fall back to the container state and ultimately to `unknown`; blank output is forbidden.

Example:

```text
Argus is running

  argus     healthy
  searxng   running
```

Diagnostics retain component-level recovery details but use readable labels and spacing. Machine-oriented fields remain available through `--json`.

### Logs

Human `argus logs` uses a compact renderer by default:

```text
11:05:20  argus     INFO   job complete  source=web inserted=7 revised=0 duplicates=19
11:05:22  searxng   WARN   request rate limited by upstream search engine
```

For Argus JSON log records, the renderer keeps timestamp, service, level, message, source, target, attempt, retry time, and ingestion counters when present. It omits routine process metadata such as PID, hostname, logger name, container prefix, and opaque job IDs.

For non-JSON service output, the renderer removes the Compose prefix and preserves the message with a service label. Multiline traces remain readable and attributable without pretending they are structured Argus events.

`argus logs --raw` returns the exact bounded Docker Compose output. `--tail` and service selection retain their current limits. JSON mode continues to expose the exact raw log string so agents do not lose information.

### Configuration

Human `argus config show` renders redacted YAML. JSON mode retains the existing structured object. Validation success remains concise.

### Plans and updates

Human dry-runs summarize only user-relevant changes:

```text
Argus is already up to date (0.1.22).
```

or:

```text
Update Argus

  Current   0.1.22
  Target    0.1.23

  • Update argus
  • Keep searxng running
```

Internal manifests, rollback snapshots, hashes, and management state remain available in JSON mode only. Lifecycle, repair, onboarding, config apply, and update plans share one concise human renderer driven by their existing plan data.

### Errors

Human errors prioritize explanation and recovery:

```text
Error: Log tail must be a positive integer no greater than 10000.
Try: argus logs --tail 200
Code: LOG_TAIL_INVALID
```

The code remains visible for support but no longer dominates the message. JSON error envelopes, exit codes, redaction, and confirmation semantics remain stable.

## Architecture

Human rendering and command execution remain separate concerns:

- Direct Commander actions call shared operation handlers.
- The interactive menu selects an operation and delegates to those same handlers.
- Pure renderers convert status, diagnostic, plan, and log values into human text.
- JSON output bypasses human renderers and keeps the existing stable data.
- The deployment adapter continues to return bounded raw logs; formatting belongs to the CLI boundary.

The current command file may be split only where needed to establish these boundaries. The implementation must not create a second deployment API or duplicate mutation logic.

## Safety and compatibility

- No prompt may open unless the process is attached to an interactive terminal.
- Menu mutations use the same explicit confirmation defaults as direct commands.
- Secrets remain redacted in help, output, errors, plans, and logs.
- Raw logs are bounded and opt-in.
- Existing direct-command `--json` success/error envelopes and exit codes remain unchanged. Bare no-argument JSON invocation changes from a usage failure to a help success.
- Human output is intentionally allowed to change; it is not a compatibility surface.

## Testing

Testing covers behavior at three levels:

1. Pure renderer tests use literal Argus JSON logs, Compose-prefixed logs, blank service health, no-op plans, changed plans, and redacted configuration fixtures.
2. CLI harness tests prove the menu delegates to existing operations and preserves confirmation behavior.
3. Process-level tests prove terminal-visible output, non-TTY behavior, bare namespace help, `--raw`, concise dry-runs, human errors, and unchanged JSON envelopes.

Before release, a real PTY acceptance pass must exercise every home-menu item and every public direct command. The signed candidate then goes through the existing clean-host installer matrix. After stable promotion, the VPS is updated and the terminal acceptance pass is repeated against the installed wrapper.

## Acceptance criteria

- Bare interactive `argus` opens an actionable menu.
- Bare non-interactive `argus` and bare namespaces provide help without errors.
- Every menu option invokes the same safe operation as its direct command.
- Human status never contains blank service states.
- Default logs are compact and readable; `--raw` is exact and bounded.
- Human configuration is redacted YAML.
- Human plans omit internal release and rollback structures.
- Human errors lead with explanation and recovery.
- JSON contracts and mutation confirmation guarantees remain green.
- The full automated suite and an installed-VPS terminal UX checklist pass before release.
