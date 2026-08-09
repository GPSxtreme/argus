# Argus Operator Documentation and Verification Design

## Summary

Argus needs an operator-facing documentation system that explains the product
end to end and a verification system that proves the documented behavior at
unit, integration, release, and real-host levels. The public Fumadocs site will
remain the documentation presentation layer because it is already deployed and
fits the required information architecture. MDX files remain the readable
source of truth.

This work has two independently reviewable delivery streams:

1. complete the operator and contributor documentation; and
2. strengthen automated verification and validate published releases on the
   permanent VPS.

The documentation stream lands first so the testing stream can use published
commands, examples, and workflows as explicit contracts.

## Goals

- Let a new operator understand Argus, install it, configure every supported
  capability, operate it safely, and recover from common failures without
  reading source code.
- Document only behavior implemented by the current product. Planned features
  are excluded from normative documentation.
- Give AI agents complete, machine-readable documentation through the same MDX
  source used by people.
- Give contributors a separate path for architecture, development, testing,
  release, and documentation maintenance.
- Detect documentation drift in configuration examples, CLI commands, API
  routes, links, and release-distribution endpoints.
- Run meaningful unit and container-backed integration tests for every pull
  request.
- Keep the signed-release and clean-host matrices as release gates.
- Prove the latest published release on the permanent VPS and leave that release
  running as the real Argus instance.

## Non-goals

- The Windows GPU desktop is not part of this phase.
- Local embedding models, Ollama integration, and new intelligence providers are
  not part of this phase.
- The documentation will not describe private Telegram access, browser-based
  access-control bypasses, or other unsupported source behavior.
- Local, uncommitted application code will not be copied to the VPS. The VPS
  runs published, signed releases only.
- The project will not add a second documentation framework or a speculative
  documentation-generation layer.
- Coverage percentages will not be treated as a substitute for behavioral
  integration and release tests.

## Existing-work preservation

The current `main` worktree contains modified and untracked files owned by the
user. Before implementation, their exact state must be preserved and reviewed.
No reset, checkout, clean, stash drop, or broad rewrite is allowed. Work should
be separated into focused branches or worktrees only after the existing changes
have been classified by purpose and verified.

The current documentation edits, new HTTP API page, landing-page redesign, and
core package changes may be reused when they meet this specification. Their
presence does not make them implicitly approved or tested.

## Documentation architecture

### Presentation and source

Fumadocs remains the site renderer and navigation system. Documentation lives
in `apps/web/content/docs` as MDX and is published as:

- human-readable pages under `/docs`;
- the curated index at `/llms.txt`;
- the complete corpus at `/llms-full.txt`; and
- page-level Markdown representations under the existing machine-readable
  routes.

The site must not maintain a second copy of the same operator instructions in
the repository root. The root README is a concise project entry point and links
to the canonical public documentation for complete procedures.

### Operator information architecture

The operator documentation contains these sections in this order:

1. **Introduction** — what Argus is, its deterministic data-layer boundary,
   supported sources, and optional intelligence.
2. **Quick start** — prerequisites, signed installation, interactive onboarding,
   first health check, first ingestion, and first query.
3. **Core concepts** — watches, targets, records, revisions, jobs, checkpoints,
   artifacts, and runtime roles.
4. **Installation and onboarding** — supported hosts, installer verification,
   interactive and file-driven onboarding, secrets, generated state, managed
   services, and uninstall boundaries.
5. **Configuration reference** — every version-1 YAML field, its type, default,
   constraints, interactions, secret handling, and complete examples.
6. **Sources** — separate complete guides for X through FxEmbed, anonymous
   public Telegram announcements, direct Web URLs, RSS/Atom feeds, and SearXNG
   discovery queries.
7. **Querying and API** — authentication, every public endpoint, parameters,
   response shapes, pagination, errors, on-demand ingestion, summaries, and
   diagnostic endpoints.
8. **Optional intelligence** — OpenRouter setup, scheduled and on-demand
   summaries, citations, artifacts, cost boundaries, and failure isolation from
   deterministic ingestion.
9. **Deployment** — single-VPS SQLite deployment first, followed by PostgreSQL
   multi-role and Railway topology as an advanced option.
10. **Operations** — lifecycle commands, status, bounded logs, doctor, repair,
    configuration changes, updates, rollback, backup, restore, and service
    ownership.
11. **Security** — trust model, signed releases, API tokens, secret files,
    network exposure, SSRF protections, public-source boundaries, and least
    privilege.
12. **Troubleshooting** — symptom-oriented diagnosis with safe inspection first,
    stable error codes, recovery commands, and escalation evidence.
13. **Agent usage** — machine-readable routes, skill installation, deterministic
    JSON commands, approvals, and secret-handling rules.

Each procedural page begins with its intended outcome and prerequisites, then
uses copyable commands, expected results, and failure/recovery notes. Examples
use the actual `argus` CLI and current configuration schema.

### Contributor information architecture

Contributor documentation is visibly separate from operator documentation and
contains:

- repository and package architecture;
- canonical data flow and component boundaries;
- local Node.js 24 and pnpm 10 setup;
- development commands and environment isolation;
- unit, integration, live, release, and VPS test tiers;
- how to add or change configuration, sources, storage, API routes, and CLI
  commands without leaving docs behind;
- release signing, image publication, stable-manifest promotion, and Vercel
  deployment; and
- documentation authoring and verification rules.

Historical design specifications remain available to contributors but are not
presented as current operator instructions.

### Reference generation boundary

Human explanations remain authored MDX. Existing libraries and product outputs
may generate or validate narrow reference artifacts where that removes drift:

- the configuration JSON Schema emitted by `argus config schema`;
- CLI help and stable JSON contracts;
- route inventory derived from the Hono application or an explicit shared route
  contract; and
- the signed stable release manifest.

The project will not build a general documentation generator. Generated data is
embedded or checked only when it is clearer and simpler than duplicating a
machine-readable contract manually.

## Documentation verification

Documentation becomes part of the product contract. The web test suite must
verify:

- every navigation entry resolves;
- every internal link resolves in a production build;
- required operator and contributor sections exist;
- MDX has valid front matter and one unambiguous rendered page title;
- documented CLI commands exist in the current CLI command tree;
- configuration examples validate against the current schema with placeholder
  secrets supplied only in the test environment;
- documented API methods and paths match the application route contract;
- public distribution routes serve the exact promoted release assets;
- `/llms.txt`, `/llms-full.txt`, and page-level machine-readable routes include
  the same canonical documentation; and
- examples never instruct public-repository users to provide obsolete private
  GitHub credentials.

Commands that would mutate a host are verified structurally in normal CI and
executed only in isolated integration, clean-host, or VPS acceptance tests.

## Verification architecture

### Tier 1: static and unit tests

Every pull request runs Biome, TypeScript, builds, and deterministic unit tests.
Unit tests cover pure parsing, validation, normalization, planning, security
boundaries, error contracts, and adapters with bounded fakes. Unit tests must be
fast, network-independent, and order-independent.

Vitest V8 coverage is collected for the application and package source trees.
The initial threshold is set from an observed clean baseline and may never
decrease silently. Critical deterministic packages—configuration, contracts,
engine, query, scheduler, and storage—must additionally maintain at least 85%
line coverage and 75% branch coverage. Release-shell behavior continues to be
judged primarily by behavioral fixtures rather than misleading line coverage.

### Tier 2: container-backed integration tests

Every pull request runs integration tests against disposable services:

- PostgreSQL repository behavior, concurrency, transactions, pagination,
  revisions, diagnostics, and parity with SQLite;
- managed SearXNG health and JSON search over the private Compose network;
- API authentication, ingestion enqueueing, deterministic querying, and
  artifact retrieval with real storage;
- runtime-role coordination across API, scheduler, worker, and processor where
  PostgreSQL is required; and
- documentation examples that depend on a running Argus API.

The suite uses pinned images already owned by the release/deployment contract.
Each test creates isolated state, has bounded deadlines, and always removes its
containers and volumes. External X, Telegram, Web, OpenRouter, and Cloudflare
services remain represented by deterministic local fixtures in PR CI.

### Tier 3: opt-in live integration tests

Credentialed tests for FxEmbed/Cloudflare, OpenRouter, and public-source
availability remain manual or scheduled. They use dedicated test credentials,
bounded requests, safe public targets, and sanitized artifacts. Their absence
does not weaken deterministic PR checks, and their failure does not reveal
secrets.

### Tier 4: signed-release verification

A release must continue to pass:

- lint, typecheck, unit/integration tests, and production builds;
- multi-architecture image publication;
- Ed25519 manifest and asset verification;
- clean-host installer idempotency;
- Docker-present and Docker-absent paths; and
- the supported Ubuntu/Debian and AMD64/ARM64 matrix.

Only a published signed release that passes these checks may be promoted by the
site's stable manifest.

### Tier 5: permanent-VPS acceptance

The SSH alias `vps` identifies the permanent Ubuntu 22.04 x86_64 Argus host.
The VPS runs published releases only. The first acceptance run installs the
latest stable release and leaves it running; later runs verify updates without
destroying stored records.

The VPS acceptance checklist verifies:

1. release signature and installer inspection;
2. installation and repeated installation idempotency;
3. onboarding and generated state ownership;
4. `status`, `doctor`, and bounded logs;
5. controlled Web ingestion and retrieval through the authenticated API;
6. record persistence across service restart;
7. managed SearXNG when configured;
8. only intended host ports are published;
9. backup creation and non-destructive restore verification;
10. signed update planning and application; and
11. rollback planning, with destructive rollback executed only after explicit
    approval and only when a prior verified version exists.

The existing `/opt/argus` instance is treated as persistent production data
after onboarding. Tests use a clearly named controlled watch and remove only
their own diagnostic resources. They never wipe the Argus database or unrelated
Docker resources.

The local SSH key authenticates access, but `sudo` requires the user to enter a
password. No password is sent through chat or stored by the project. Any initial
privileged bootstrap that cannot be completed through an existing authorized
session is handed to the user as one explicit command.

## CI organization

Pull-request checks are separated by purpose so failures are understandable:

- **quality** — Biome and TypeScript;
- **unit** — deterministic Vitest suite plus coverage thresholds;
- **integration** — PostgreSQL, SearXNG, and real-storage/API orchestration;
- **web/docs** — production build, content contracts, internal links,
  accessibility, and Lighthouse; and
- **release contracts** — installer, wrapper, manifest, workflow, and image
  fixtures without publishing.

Release and VPS workflows remain separate because they consume immutable
published artifacts and have different mutation boundaries. The permanent VPS
is not accessed from untrusted pull-request workflows.

## Error handling and evidence

All test tiers use bounded timeouts and produce a concise primary failure.
Integration and release failures may upload sanitized logs, configuration
shapes, health responses, and container status. They must never upload tokens,
secret files, Docker authentication, private keys, or unredacted environment
variables.

VPS acceptance records the release tag, manifest digest, test timestamps,
command exit status, health result, and names of controlled test resources. It
does not copy production records off the VPS.

## Delivery order

1. Preserve and classify the existing dirty worktree.
2. Complete the operator documentation information architecture and content.
3. Add contributor documentation and reduce the root README to a correct entry
   point.
4. Add documentation contract tests and machine-readable parity checks.
5. Measure coverage, add the coverage provider, and enforce non-regression plus
   critical-package thresholds.
6. Make PostgreSQL and SearXNG integration tests first-class CI jobs.
7. Add real-storage/API orchestration coverage and close behavioral gaps found
   by the new suite.
8. Run all local and CI gates.
9. Validate the latest signed release on the permanent VPS and leave it healthy.
10. Publish documentation through the existing Git-connected Vercel project.

Each step lands as a focused pull request. Documentation and testing changes do
not wait for unrelated local feature work.

## Acceptance criteria

- A new operator can install, onboard, ingest a controlled source, query it,
  diagnose the instance, update it, and understand recovery from the public
  documentation alone.
- Every supported configuration field, CLI command, API endpoint, source mode,
  storage topology, and operational lifecycle has canonical documentation.
- Human and machine-readable documentation originate from the same MDX corpus.
- Documentation links, commands, configuration examples, API routes, and
  promoted release assets are checked automatically.
- Pull requests run quality, unit, coverage, PostgreSQL/SearXNG integration, and
  web/docs gates with no credentialed external dependency.
- Signed releases retain the full clean-host matrix and cannot be promoted when
  it fails.
- The latest stable signed release passes the permanent-VPS acceptance checklist
  and remains healthy on `vps`.
- The GPU desktop is untouched.
- Existing user changes are preserved and unrelated work is neither rewritten
  nor committed accidentally.
