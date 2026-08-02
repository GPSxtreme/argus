# Argus VPS Onboarding and Project Site Design

**Status:** Approved

**Date:** 2026-08-01

## Summary

Argus V1 must be simple to install and operate on a single VPS. A user should
install one `argus` command, run an interactive onboarding flow, answer the
questions relevant to their chosen sources, and receive a working,
self-tested instance.

The same deterministic CLI must support a portable Agent Skill for Codex,
Claude Code, and other Agent Skills-compatible clients. Agents orchestrate the
CLI; they do not duplicate infrastructure logic in prose or generate
deployment files independently.

The public project surface lives at `argus.gpsxtre.me` in one Next.js
application deployed on Vercel. It contains a minimal landing page, Fumadocs
documentation, the stable installer route, and first-class machine-readable
documentation.

## Goals

- Install and onboard Argus on a fresh supported VPS with one command and one
  guided configuration flow.
- Keep the happy path understandable to a user who does not know Argus's
  internal service architecture.
- Manage SearXNG locally and FxEmbed in the user's Cloudflare account when
  their corresponding sources are enabled.
- Make onboarding resumable, idempotent, diagnosable, and safe to re-run.
- Provide human-readable and JSON CLI output from the same setup engine.
- Provide a portable Agent Skill that uses the CLI without exposing secrets to
  model context.
- Keep the website fast, static where possible, and simple to maintain.
- Treat `llms.txt`, full LLM documentation, and per-page Markdown as supported
  product interfaces.

## Non-goals

- Railway, Kubernetes, multi-node, or managed-cloud onboarding in V1.
- Official support for operating systems beyond Ubuntu and Debian in V1.
- A hosted Argus control plane, account system, billing system, or telemetry
  service.
- A CMS, blog, dashboard, chat widget, or analytics platform for the project
  site.
- Forking or absorbing the FxEmbed or SearXNG codebases.
- Reimplementing CLI deployment behavior inside an Agent Skill.
- Making LLM processing part of the deterministic ingestion path.

## Supported V1 Environment

V1 supports Ubuntu and Debian VPS hosts on Linux x64 and arm64. Docker Compose
is the deployment substrate.

SQLite is the default storage adapter and runs the complete Argus runtime in
one application container. PostgreSQL remains available when the user needs
split roles or expects to scale beyond a single process. The onboarding flow
may recommend PostgreSQL based on the answers, but it does not force it for a
normal single-VPS setup.

## Product Surfaces

### Project surface

`argus.gpsxtre.me` is the stable project domain:

- `/` serves the landing page.
- `/docs` serves Fumadocs documentation.
- `/install.sh` serves the stable installer entry point.
- `/llms.txt` serves a concise documentation index.
- `/llms-full.txt` serves the complete processed documentation.
- `/docs/<path>.md` serves individual pages as Markdown.
- `/skill` explains agent installation and usage.
- `/skill/SKILL.md` serves the portable Agent Skill entry file.
- `/skill/argus-skill.zip` serves the complete portable skill package.

The project surface distributes software and documentation only. User data
does not pass through it.

### Instance surface

Each Argus instance is owned by the user and runs on their VPS. Storage,
SearXNG, ingestion, querying, and optional intelligence remain on that
instance. When X ingestion is enabled, FxEmbed is deployed into the user's
Cloudflare account and accessed directly by that Argus instance.

## Installation

The launch installation path is:

```bash
curl -fsSL https://argus.gpsxtre.me/install.sh | sh
argus onboard
```

The website also documents a download-and-inspect path that does not pipe a
remote script directly into a shell.

The installer:

1. Detects the supported operating system and architecture.
2. Fetches an Ed25519-signed release manifest over HTTPS.
3. Downloads the matching versioned Argus CLI artifact.
4. Verifies its SHA-256 checksum before installation.
5. Installs the `argus` executable in a standard executable path.
6. Prints the installed version and the `argus onboard` next step.

The installer contains the public verification key and rejects a manifest
whose signature does not verify. Release storage remains behind that manifest:
the public release uses GitHub Releases, while private alpha artifacts may use
an authenticated artifact origin without changing the installed CLI or public
URL design.

## CLI Architecture

The CLI has one setup engine with interactive, non-interactive, and
machine-readable interfaces. Commands must return non-zero exit codes for
failures and stable structured error codes in JSON mode.

### Human commands

```text
argus onboard
argus start
argus stop
argus restart
argus status
argus logs [service]
argus doctor
argus update
argus repair [service]
argus config validate [path]
argus config apply [path]
argus config show
argus secrets set <name>
```

### Agent and automation interfaces

```text
argus onboard --from setup.yaml --json
argus status --json
argus doctor --json
argus config schema --json
argus config validate --json
argus config apply --json
```

JSON output is data only; progress rendering belongs on stderr. JSON contracts
are versioned so skills and automation can detect incompatible CLI changes.

## Interactive Onboarding

`argus onboard` runs the following stateful flow:

1. **Preflight**
   - Detect OS and architecture.
   - Check Docker and Compose availability.
   - Check disk, memory, required ports, DNS, and outbound connectivity.
   - Install or repair supported prerequisites only after confirmation.
2. **Deployment**
   - Confirm the single-VPS deployment target.
   - Select SQLite or PostgreSQL, with SQLite recommended by default.
   - Choose API bind address and port.
3. **Sources**
   - Enable any combination of X, Telegram, and Web.
   - Ask only questions needed for enabled sources.
   - Collect X accounts and queries, public Telegram channel usernames, URLs,
     feeds, web queries, schedules, keywords, and retention settings.
4. **Managed dependencies**
   - Configure managed SearXNG when web queries are enabled.
   - Configure managed FxEmbed when X is enabled.
   - Permit advanced users to select an external endpoint instead.
5. **Optional intelligence**
   - Offer OpenRouter summaries as an optional layer.
   - Keep intelligence disabled by default.
6. **Review**
   - Render a plain-language plan with resources, ports, services, paths, and
     external changes.
   - Require confirmation before changing the host or Cloudflare account.
7. **Reconciliation**
   - Write configuration and secrets atomically.
   - Pull pinned images and start the required services.
   - Deploy FxEmbed when required.
   - Apply the Argus configuration.
8. **Verification**
   - Run service health checks.
   - Run enabled-source smoke tests.
   - Print the API URL, secret location, current status, and recovery commands.

Re-running onboarding loads existing state and offers to continue an
incomplete run, edit configuration, repair services, or verify the existing
deployment. It must not create duplicate Cloudflare Workers, containers,
volumes, jobs, or configuration snapshots.

## Configuration and Secrets

V1 stores instance state under `/opt/argus`:

```text
/opt/argus/
├── argus.yaml
├── secrets.env
├── compose.yaml
├── state.json
└── backups/
```

`argus.yaml` contains ordinary versioned settings. `secrets.env` contains
tokens and passwords and is created with owner-only permissions. YAML refers
to secrets with environment references rather than embedding their values.
The Cloudflare account ID is ordinary configuration; its API token is secret.

Secret values include:

- Argus API token
- Cloudflare API token
- OpenRouter API key when enabled
- PostgreSQL password when applicable

Secret entry uses hidden terminal prompts. `argus config show`, diagnostics,
logs, JSON output, and Agent Skill workflows redact secret values. Agents may
request that a user set a secret, but the secret is entered through
`argus secrets set` rather than placed in a conversation or agent-generated
file.

## Managed Infrastructure

Deployment templates are embedded in and versioned with each CLI release.
The CLI reconciles the host against the selected release rather than producing
unversioned Compose files from scratch.

The default SQLite stack contains:

- One Argus application container with the `all` runtime role
- One persistent Argus data volume
- One managed SearXNG service when web queries are enabled
- One private Docker network

PostgreSQL adds a pinned PostgreSQL service and persistent database volume.
Split Argus roles remain an advanced configuration rather than part of the
default V1 wizard.

Only the Argus API port is exposed publicly by default. SearXNG remains on the
private Docker network and has JSON output enabled. All images are pinned to
known versions, include health checks where supported, and use explicit
restart policies.

### Managed SearXNG

Managed SearXNG:

- Runs from a pinned upstream container image.
- Uses a versioned Argus-owned minimal settings file.
- Enables the JSON response format required by the Web adapter.
- Is not publicly exposed by default.
- Is wired into the generated Argus configuration through its internal
  service URL.
- Has a real query smoke test in `argus doctor`.

Users may choose `external` mode and provide an existing SearXNG endpoint.

### Managed FxEmbed

FxEmbed's supported default remains Cloudflare Workers. Managed mode:

- Uses a pinned compatible upstream FxEmbed revision.
- Requests a least-privilege Cloudflare API token through a hidden prompt.
- Creates or updates a deterministically named Worker in the user's account.
- Uses the generated `workers.dev` URL by default, avoiding a domain
  requirement for users.
- Stores only deployment identifiers and the endpoint in Argus state.
- Reconciles the existing Worker rather than creating duplicates.
- Runs an opt-in live smoke test before reporting X ingestion healthy.

Users may choose `external` mode and supply an existing FxEmbed endpoint.
Running FxEmbed through an unofficial VPS Workers runtime is not a supported
V1 path.

## State, Recovery, and Updates

`state.json` records non-secret deployment state, including the installed
Argus version, Compose project identity, selected managed services, image
versions, configuration hash, and FxEmbed deployment identity.

Each mutating operation follows a plan/apply/verify sequence:

1. Inspect actual state.
2. Calculate required changes.
3. Display the plan for confirmation.
4. Apply changes in dependency order.
5. Verify health.
6. Record the resulting state atomically.

Failures preserve logs and completed safe steps. The CLI prints the failing
component, underlying reason, recovery command, and log command. A second run
continues from observed state.

`argus update`:

1. Fetches a signed release manifest.
2. Checks configuration and migration compatibility.
3. Backs up configuration, state, and SQLite when used.
4. Pulls pinned replacement images.
5. Applies migrations.
6. Restarts and verifies services.
7. Restores the previous release when verification fails and rollback is
   compatible.

## Portable Agent Skill

The repository contains an Agent Skills open-standard package with a
`SKILL.md` entry point and small references for setup choices and CLI JSON
contracts.

The skill:

- Triggers for installing, onboarding, configuring, diagnosing, updating, or
  repairing Argus.
- Checks for the `argus` executable and uses the official installer when the
  user authorizes installation.
- Gathers deployment requirements conversationally.
- Produces an onboarding answers file using the CLI-provided schema.
- Calls CLI validation before applying changes.
- Leaves secret capture to hidden CLI prompts.
- Uses JSON commands for status and diagnostics.
- Reports exact changes and health results.
- Never edits Compose templates, deployment state, or managed-service
  configuration directly.

The same skill package is published from the repository. Its entry file is
available at `/skill/SKILL.md`, and the complete directory is available as
`/skill/argus-skill.zip`. Platform-specific installation instructions may
point Codex, Claude Code, or other clients at the same package, but its core
content remains portable.

## Website and Documentation

The project site is one Next.js App Router application deployed on Vercel:

- A custom minimal landing page at `/`
- Fumadocs under `/docs`
- Version-controlled MDX as the only documentation source
- A static or cached installer route at `/install.sh`
- Machine-readable documentation and Agent Skill routes

There is no CMS, database, authentication, analytics platform, blog, or
project dashboard in V1.

### Landing page

The landing page contains:

1. A hero positioning Argus as the self-hosted data layer for AI agents
2. The installation and onboarding commands above the fold
3. The X, Telegram, and Web data-source trinity
4. The collect, normalize, store, and query flow
5. Passive schedules and active triggers
6. The optional intelligence layer
7. The single-VPS deployment model and managed dependencies
8. Agent Skill and machine-readable documentation links
9. Documentation, source, license, and version links

The page avoids videos, heavy animation, chat widgets, trackers, cookies, and
third-party runtime dependencies. It is static-rendered wherever possible,
ships minimal client JavaScript, optimizes local assets and fonts, and targets
Lighthouse category scores above 95.

### Human and LLM documentation

Fumadocs derives all representations from the same MDX content:

- `/llms.txt` is the concise canonical index for agents.
- `/llms-full.txt` concatenates processed documentation for full-context
  ingestion.
- `/docs/<path>.md` exposes clean Markdown for individual pages.
- Markdown content negotiation serves Markdown when a compatible agent asks
  for it.
- Documentation pages offer Copy Markdown and agent-oriented actions.

These routes are public, stable, cacheable, and verified in CI. They are not
manually duplicated files.

## Security

- Verify release checksums before installing or updating.
- Keep the signed release manifest separate from mutable release artifacts.
- Use least-privilege Cloudflare credentials and document the exact required
  permissions.
- Never expose SearXNG publicly by default.
- Create secret files with owner-only permissions.
- Redact secrets from output, logs, backups, diagnostics, and state.
- Preview external and host mutations before applying them.
- Validate downloaded templates and managed dependency versions against the
  release manifest.
- Back up persistent data before migrations.
- Do not send instance telemetry to the project site in V1.

## Testing Strategy

### CLI and configuration

- Unit-test prompt branching and defaults.
- Snapshot generated configuration for every source and storage combination.
- Contract-test JSON output and structured error codes.
- Verify secret redaction across commands and failures.
- Verify interrupted onboarding resumes without duplicate resources.

### Deployment

- Run clean installation tests on supported Ubuntu and Debian images.
- Build and test Linux x64 and arm64 release artifacts.
- Exercise SQLite and PostgreSQL stacks.
- Run real managed SearXNG discovery and Web ingestion.
- Run opt-in live FxEmbed deployment and X ingestion in a dedicated Cloudflare
  test account.
- Verify updates, migrations, failed health checks, repair, and rollback.
- Verify only intended ports are publicly bound.

### Agent Skill

- Validate the Agent Skills package format.
- Test setup and diagnostic prompts in Codex and Claude Code.
- Confirm the skill uses CLI schemas and JSON interfaces instead of writing
  internal deployment files.
- Confirm secret values never enter generated skill artifacts or captured
  transcripts.

### Website and docs

- Build the Next.js application in CI.
- Check links and MDX compilation.
- Verify `/install.sh`, `/llms.txt`, `/llms-full.txt`, per-page Markdown, and
  both Agent Skill distribution routes.
- Test the installer against release fixtures and invalid checksums.
- Enforce landing-page performance and bundle budgets.
- Run accessibility checks for the landing and documentation layouts.

## Delivery Order

1. Extract a deterministic onboarding and deployment core behind CLI
   interfaces.
2. Add the interactive wizard, secrets handling, state reconciliation, and
   lifecycle commands.
3. Add managed SearXNG and its live health test.
4. Add managed FxEmbed deployment and Cloudflare reconciliation.
5. Package signed Linux x64 and arm64 CLI releases and the installer.
6. Publish the portable Agent Skill against stable JSON CLI contracts.
7. Build the minimal Next.js/Fumadocs site and LLM documentation routes.
8. Deploy the site to Vercel and connect `argus.gpsxtre.me`.
9. Run a clean-VPS release rehearsal before advertising the installer.

## Acceptance Criteria

The design is complete when:

1. A user on a supported fresh VPS can install the CLI and complete onboarding
   without manually editing Docker Compose.
2. The user can enable any subset of X, Telegram, and Web through the wizard.
3. Managed SearXNG starts locally and passes a real search test.
4. Managed FxEmbed deploys idempotently to the user's Cloudflare account when
   X is enabled.
5. `argus doctor` explains unhealthy services and provides recovery commands.
6. Re-running onboarding does not duplicate managed resources.
7. A compatible coding agent can set up Argus through the portable skill and
   stable CLI JSON interfaces without receiving secret values.
8. `argus.gpsxtre.me` provides the landing page, installer, human docs,
   `llms.txt`, full LLM docs, per-page Markdown, and Agent Skill.
9. The landing page meets the stated no-bloat and performance constraints.
10. No user ingestion data or instance telemetry flows through the project
    site.
