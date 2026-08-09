# Argus Operator Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sparse public documentation with a complete operator handbook and a separate contributor guide whose human and LLM-readable outputs stay aligned with the current product.

**Architecture:** Keep Fumadocs and the existing MDX source pipeline. Organize canonical content by operator journey, add narrow contract helpers for current CLI/API/config surfaces, and test content structure and examples rather than introducing a general documentation generator.

**Tech Stack:** Next.js 16, Fumadocs, MDX, TypeScript, Vitest, Zod, Commander, Hono, Linkinator, Lighthouse CI.

## Global Constraints

- Preserve all pre-existing modified and untracked files in `/Users/prudhvisuraaj/Developer/argus`; do not reset, clean, overwrite, or include unrelated changes.
- Execute this plan in an isolated worktree created from commit `c1d686b` or its reviewed successor.
- Fumadocs remains the only documentation framework.
- `apps/web/content/docs` is the canonical human and machine-readable documentation corpus.
- Document current implemented behavior only; do not publish planned features as supported behavior.
- Keep operator and contributor navigation visibly separate.
- Do not add compatibility aliases or duplicate documentation sources.
- Keep all examples secret-free and runnable with Node.js 24 and pnpm 10.
- The GPU desktop is out of scope.

---

### Task 1: Lock the documentation information architecture with failing contracts

**Files:**
- Modify: `apps/web/test/content.test.ts`
- Modify: `apps/web/content/docs/meta.json`
- Create: `apps/web/content/docs/contributing/meta.json`
- Create: `apps/web/content/docs/sources/meta.json` only if absent in the isolated worktree

**Interfaces:**
- Consumes: `source.getPages()` and Fumadocs `meta.json` navigation.
- Produces: the canonical required route list used by later content tasks.

- [ ] **Step 1: Add a failing route and navigation contract**

Replace the hard-coded seven-page requirement in `apps/web/test/content.test.ts` with the complete operator and contributor route contract:

```ts
const requiredRoutes = [
  "/docs",
  "/docs/quick-start",
  "/docs/concepts",
  "/docs/install",
  "/docs/configuration",
  "/docs/sources/x",
  "/docs/sources/telegram",
  "/docs/sources/web",
  "/docs/intelligence",
  "/docs/api",
  "/docs/deployment",
  "/docs/operations",
  "/docs/security",
  "/docs/troubleshooting",
  "/docs/agents",
  "/docs/contributing",
  "/docs/contributing/architecture",
  "/docs/contributing/development",
  "/docs/contributing/testing",
  "/docs/contributing/releases",
  "/docs/contributing/documentation",
] as const;

it("publishes the complete operator and contributor handbook", () => {
  expect(new Set(source.getPages().map((page) => page.url))).toEqual(
    expect.objectContaining({ size: requiredRoutes.length }),
  );
  expect(source.getPages().map((page) => page.url)).toEqual(
    expect.arrayContaining([...requiredRoutes]),
  );
});
```

Add a second test that reads the root and contributor `meta.json` files and asserts the exact top-level separation:

```ts
expect(root.pages).toEqual([
  "index",
  "quick-start",
  "concepts",
  "install",
  "configuration",
  "sources",
  "intelligence",
  "api",
  "deployment",
  "operations",
  "security",
  "troubleshooting",
  "agents",
  "contributing",
]);
expect(contributing.pages).toEqual([
  "index",
  "architecture",
  "development",
  "testing",
  "releases",
  "documentation",
]);
```

- [ ] **Step 2: Run the content test and confirm it fails for missing pages**

Run:

```bash
pnpm vitest run apps/web/test/content.test.ts
```

Expected: FAIL listing the newly required routes that do not exist.

- [ ] **Step 3: Update navigation metadata**

Set `apps/web/content/docs/meta.json` to:

```json
{
  "title": "Argus documentation",
  "pages": [
    "index",
    "quick-start",
    "concepts",
    "install",
    "configuration",
    "sources",
    "intelligence",
    "api",
    "deployment",
    "operations",
    "security",
    "troubleshooting",
    "agents",
    "contributing"
  ]
}
```

Create `apps/web/content/docs/contributing/meta.json` with:

```json
{
  "title": "Contributing",
  "pages": [
    "index",
    "architecture",
    "development",
    "testing",
    "releases",
    "documentation"
  ]
}
```

Keep the source navigation exactly `x`, `telegram`, and `web`.

- [ ] **Step 4: Run the test and confirm only content routes remain missing**

Run:

```bash
pnpm vitest run apps/web/test/content.test.ts
```

Expected: FAIL only because the required MDX pages have not all been created.

- [ ] **Step 5: Commit the contract and navigation**

```bash
git add apps/web/test/content.test.ts apps/web/content/docs/meta.json apps/web/content/docs/contributing/meta.json apps/web/content/docs/sources/meta.json
git commit -m "test: define complete documentation structure"
```

### Task 2: Write the operator foundation and installation journey

**Files:**
- Modify: `apps/web/content/docs/index.mdx`
- Rename: `apps/web/content/docs/getting-started.mdx` to `apps/web/content/docs/quick-start.mdx`
- Create: `apps/web/content/docs/concepts.mdx`
- Create: `apps/web/content/docs/install.mdx`
- Modify: `apps/web/test/content.test.ts`

**Interfaces:**
- Consumes: signed installer route, CLI commands, version-1 configuration concepts.
- Produces: the canonical first-run flow linked by all later operator pages.

- [ ] **Step 1: Add failing content-quality assertions**

Add a test that requires outcome, prerequisites, verification, and next-step language on procedural foundation pages:

```ts
for (const slug of ["quick-start", "install"]) {
  const content = await readFile(path.join(docsRoot, `${slug}.mdx`), "utf8");
  expect(content).toMatch(/^---[\s\S]+title:[\s\S]+description:[\s\S]+---/u);
  expect(content).toContain("## Prerequisites");
  expect(content).toContain("## Verify");
  expect(content).toContain("## Next step");
}
```

Add assertions that the quick start includes these exact commands:

```ts
for (const command of [
  "curl -fsSL https://argus.gpsxtre.me/install.sh | sh",
  "argus onboard",
  "argus status --json",
  "argus doctor --json",
]) {
  expect(quickStart).toContain(command);
}
```

- [ ] **Step 2: Run the focused test and verify failure**

```bash
pnpm vitest run apps/web/test/content.test.ts
```

Expected: FAIL because the renamed and new pages do not exist.

- [ ] **Step 3: Rewrite the introduction**

Write `index.mdx` with these exact sections and responsibilities:

```mdx
---
title: Argus documentation
description: Operate a self-hosted, revisioned data layer for X, public Telegram announcements, and the Web.
---

Argus continuously collects public signals, stores canonical records and their revisions, and exposes deterministic queries with source links. Optional summaries are derived artifacts; ingestion and storage do not depend on an LLM.

## Choose your path

- New operator: [run the quick start](/docs/quick-start).
- Existing operator: [open operations](/docs/operations) or [troubleshooting](/docs/troubleshooting).
- Agent: use the [machine-readable interfaces](/docs/agents).
- Contributor: start with the [contributor guide](/docs/contributing).

## Supported in v1

Describe the implemented X, Telegram, Web, storage, scheduling, query, OpenRouter, VPS, and multi-role boundaries in a concise capability table.

## Product boundary

State explicitly that Argus does not access private Telegram conversations, bypass site controls, or require an LLM for deterministic ingestion and querying.
```

- [ ] **Step 4: Write the complete quick start**

Move the old getting-started content into `quick-start.mdx` and expand it with:

- prerequisites for Ubuntu 22.04/24.04 and Debian 12/13 with Docker-present and Docker-install paths;
- signed installer inspection and one-command installation;
- interactive onboarding choices for SQLite, sources, SearXNG, FxEmbed, and intelligence;
- first `status` and `doctor` checks;
- a controlled Web watch example;
- authenticated `/v1/records` query using a shell variable rather than a literal token; and
- links to concepts, configuration, and operations.

Use `https://argus.gpsxtre.me/` as the controlled Web URL. Do not include `ARGUS_GITHUB_TOKEN` because the repository is public.

- [ ] **Step 5: Write core concepts**

Create `concepts.mdx` with sections for:

```mdx
## Watches and targets
## Jobs, retries, leases, and checkpoints
## Records and revisions
## Classification metadata
## Artifacts and summaries
## Runtime roles
## Deterministic core and optional intelligence
```

For each concept, define its identity, lifecycle, persistence, and relationship to the next layer. Include one end-to-end flow from cron watch to sourced API result.

- [ ] **Step 6: Write installation and onboarding reference**

Create `install.mdx` covering:

- supported OS/architecture combinations proven by the installer matrix;
- installer signature verification and inspect-first procedure;
- Docker-present and Docker-absent behavior;
- every onboarding answer group and when it appears;
- interactive `argus onboard` and strict `argus onboard --from answers.yaml --dry-run --json`;
- secret prompts and `/opt/argus/secrets.env` ownership;
- generated files under `/opt/argus` and `/usr/local/bin/argus`;
- idempotent reinstall and safe failure behavior; and
- post-install verification and next steps.

- [ ] **Step 7: Run foundation documentation tests**

```bash
pnpm --filter @argus/web generate
pnpm vitest run apps/web/test/content.test.ts apps/web/test/routes.test.ts
```

Expected: foundation assertions pass; full route contract may still fail for later pages.

- [ ] **Step 8: Commit the operator foundation**

```bash
git add apps/web/content/docs apps/web/test/content.test.ts
git commit -m "docs: add operator foundation and install guide"
```

### Task 3: Publish a complete configuration, sources, intelligence, and API reference

**Files:**
- Modify: `apps/web/content/docs/configuration.mdx`
- Modify: `apps/web/content/docs/sources/x.mdx`
- Modify: `apps/web/content/docs/sources/telegram.mdx`
- Modify: `apps/web/content/docs/sources/web.mdx`
- Create: `apps/web/content/docs/intelligence.mdx`
- Create or replace: `apps/web/content/docs/api.mdx`
- Create: `apps/web/test/examples.test.ts`

**Interfaces:**
- Consumes: `argusConfigSchema`, `argus.example.yaml`, `createProgram`, and `createApp` route behavior.
- Produces: validated YAML examples and current CLI/API reference content.

- [ ] **Step 1: Add a failing configuration-example validator**

Create `apps/web/test/examples.test.ts`. Extract fenced YAML blocks marked `yaml config` from `configuration.mdx`, replace only `${OPENROUTER_API_KEY}` and `${ARGUS_API_TOKEN}` with fixture values, parse with `yaml`, and call `validateConfig`:

```ts
const configBlocks = [...content.matchAll(/```yaml config\n([\s\S]*?)```/gu)];
expect(configBlocks.length).toBeGreaterThanOrEqual(3);
for (const [, block] of configBlocks) {
  expect(() => validateConfig(parse(block as string))).not.toThrow();
}
```

Add a command contract array containing every documented root command:

```ts
const documentedCommands = [
  "onboard", "start", "stop", "restart", "status", "logs", "doctor",
  "repair", "update", "config", "secrets",
] as const;
```

Construct the Commander program with test dependencies and assert each command exists in `program.commands`.

- [ ] **Step 2: Run the example test and verify it fails**

```bash
pnpm vitest run apps/web/test/examples.test.ts
```

Expected: FAIL because the complete marked configuration examples are not present.

- [ ] **Step 3: Rewrite the configuration reference**

Document every field from `packages/config/src/schema.ts` in schema order. For each field include type, default, validation, interaction, and one concise example. Include three complete validated blocks:

1. single-VPS SQLite with a controlled Web URL;
2. all three sources with SearXNG and FxEmbed endpoints; and
3. PostgreSQL multi-role plus scheduled OpenRouter summaries.

Explain five-field cron syntax, source-enable/watch-input consistency, SQLite's `runtime.role: all` requirement, PostgreSQL URL requirements, non-loopback API token requirements, keyword metadata, and secret interpolation.

- [ ] **Step 4: Rewrite all source guides**

Each source page must include:

```mdx
## What it collects
## Prerequisites
## Configure the source
## Configure watches
## Validate and apply
## Verify ingestion
## Limits and safety
## Troubleshooting
```

X must explain the operator-owned FxEmbed `/api` endpoint and accounts versus queries. Telegram must explain anonymous public announcement scraping, canonical `t.me/<channel>/<numeric-id>` URLs, and exclusions. Web must separately document direct URLs, RSS/Atom feeds, SearXNG discovery, SSRF/public-network enforcement, size/time bounds, and `browserFallback: false` as the only supported v1 value.

- [ ] **Step 5: Write optional intelligence documentation**

Create `intelligence.mdx` covering `provider: openrouter`, key handling, model selection, scheduled summary processors, `watchIds`, `prompt`, on-demand summaries, artifact storage, citations, failure isolation, and cost/rate-limit expectations. State that embeddings and local GPU inference are not implemented product features.

- [ ] **Step 6: Complete the API reference**

Use the existing untracked API draft only after checking it against `apps/argus/src/app.ts`. Document:

- `GET /health`;
- `GET /v1/records` with repeated filters, ISO bounds, strict cursor behavior, limits, and optional fields;
- `GET /v1/artifacts`;
- `POST /v1/watches/:watchId/ingest`;
- `POST /v1/summaries`;
- the three diagnostic smoke-watch routes; and
- the three management configuration routes used by the host wrapper.

For every endpoint include authentication, request shape, successful status, response shape, deterministic errors, and one curl example. Never expose management routes as a replacement for the supported CLI.

- [ ] **Step 7: Run reference and example tests**

```bash
pnpm --filter @argus/web generate
pnpm vitest run apps/web/test/content.test.ts apps/web/test/examples.test.ts apps/web/test/routes.test.ts
```

Expected: PASS for configuration, source, intelligence, and API contracts.

- [ ] **Step 8: Commit reference documentation**

```bash
git add apps/web/content/docs apps/web/test/examples.test.ts
git commit -m "docs: complete configuration source and API references"
```

### Task 4: Complete deployment, operations, security, and troubleshooting

**Files:**
- Create: `apps/web/content/docs/deployment.mdx`
- Modify: `apps/web/content/docs/operations.mdx`
- Create: `apps/web/content/docs/security.mdx`
- Create: `apps/web/content/docs/troubleshooting.mdx`
- Modify: `apps/web/test/content.test.ts`

**Interfaces:**
- Consumes: deployment CLI contracts, Docker Compose renderer, doctor error/recovery contracts, update/rollback behavior.
- Produces: the canonical production operations and recovery handbook.

- [ ] **Step 1: Add failing operational coverage assertions**

Require the operations corpus to mention every lifecycle command and mutation-safety flag:

```ts
for (const command of [
  "argus start", "argus stop", "argus restart", "argus status --json",
  "argus logs", "argus doctor --json", "argus repair",
  "argus update --dry-run --json", "argus update --rollback --dry-run --json",
  "argus config apply --dry-run --json", "argus secrets set",
]) {
  expect(operationsCorpus).toContain(command);
}
```

Require `security.mdx` to contain `Ed25519`, `SSRF`, `secrets.env`, `Bearer`, and `least privilege`.

- [ ] **Step 2: Run the test and verify failure**

```bash
pnpm vitest run apps/web/test/content.test.ts
```

Expected: FAIL for missing operational and security coverage.

- [ ] **Step 3: Write deployment documentation**

Lead with single-VPS SQLite. Document host requirements, generated Compose topology, managed SearXNG, external FxEmbed, persistent volumes/state, API port exposure, and backup boundary. Follow with PostgreSQL multi-role and Railway as advanced topologies, including when SQLite is invalid and how roles coordinate.

- [ ] **Step 4: Rewrite operations documentation**

Document inspect/apply/verify behavior for lifecycle, config, secrets, repair, update, and rollback. Include bounded logs, status state meanings, doctor check categories, backup and restore procedures already implemented in `docs/operations.md`, and exact safe command sequences. Explain `--dry-run`, `--yes`, and `--json` consistently.

- [ ] **Step 5: Write security documentation**

Cover signed manifests and pinned images, release trust root, secret storage and redaction, API bearer authentication, bind-host behavior, Docker credentials, public-source limits, SSRF/DNS rebinding protections, diagnostic isolation, least privilege, backup sensitivity, and reporting a vulnerability. State actual guarantees only.

- [ ] **Step 6: Write symptom-oriented troubleshooting**

Organize by observable symptom: installer failure, Docker unavailable, unhealthy service, configuration rejected, source yields no records, SearXNG unavailable, FxEmbed/X failure, Telegram/Web parse failure, API 401/400, summary failure, update failure, and rollback unavailable. Each entry must use this order:

```mdx
### Symptom text

**Inspect:** non-mutating command.

**Meaning:** bounded explanation tied to a stable error code when available.

**Recover:** dry-run command first, then the explicit mutation command.
```

- [ ] **Step 7: Run operational documentation tests**

```bash
pnpm --filter @argus/web generate
pnpm vitest run apps/web/test/content.test.ts apps/web/test/routes.test.ts
```

Expected: PASS for the complete operator route contract.

- [ ] **Step 8: Commit operational documentation**

```bash
git add apps/web/content/docs apps/web/test/content.test.ts
git commit -m "docs: add deployment operations and recovery handbook"
```

### Task 5: Add contributor documentation and correct the project entry points

**Files:**
- Create: `apps/web/content/docs/contributing/index.mdx`
- Create: `apps/web/content/docs/contributing/architecture.mdx`
- Create: `apps/web/content/docs/contributing/development.mdx`
- Create: `apps/web/content/docs/contributing/testing.mdx`
- Create: `apps/web/content/docs/contributing/releases.mdx`
- Create: `apps/web/content/docs/contributing/documentation.mdx`
- Modify: `apps/web/content/docs/agents.mdx`
- Modify: `README.md`
- Modify: `apps/web/test/content.test.ts`

**Interfaces:**
- Consumes: repository package boundaries, scripts, workflows, Agent Skill, and public site routes.
- Produces: distinct contributor and agent paths without duplicating operator procedures.

- [ ] **Step 1: Add failing README and contributor assertions**

Add tests requiring the README to link `/docs/quick-start`, `/docs/contributing`, and the current release page, and forbidding obsolete private-repository installation text:

```ts
expect(readme).not.toContain("The token is needed only while the release repository is private");
expect(readme).not.toContain('ARGUS_GITHUB_TOKEN="<GitHub token with read access>"');
expect(readme).toContain("https://argus.gpsxtre.me/docs/quick-start");
expect(readme).toContain("https://argus.gpsxtre.me/docs/contributing");
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run apps/web/test/content.test.ts
```

Expected: FAIL on the stale README and missing contributor pages.

- [ ] **Step 3: Write contributor pages**

Use the package boundaries shown by the repository, not the historical plans, as the current architecture. Document exact Node/pnpm versions and commands. Explain each test tier and its environment variables. Describe release tags, signing, images, installer smoke, stable-site promotion, Git-connected Vercel deployment, and documentation verification.

- [ ] **Step 4: Rewrite the agent page**

Document `/llms.txt`, `/llms-full.txt`, `/docs/<path>.md`, `/skill/SKILL.md`, and `/skill/argus-skill.zip`. Give Codex/Claude-compatible installation and explain the CLI JSON, approval, redaction, and recovery boundaries. Do not duplicate the skill's detailed routing rules.

- [ ] **Step 5: Reduce and correct the README**

Keep the product statement, capabilities, one public installation command, development bootstrap, documentation links, test commands, license link if a root license exists, and current architecture spec link. Remove private-repository token instructions and long procedures now owned by Fumadocs.

- [ ] **Step 6: Run contributor and README tests**

```bash
pnpm --filter @argus/web generate
pnpm vitest run apps/web/test/content.test.ts apps/web/test/routes.test.ts apps/web/test/distribution.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit contributor documentation**

```bash
git add README.md apps/web/content/docs apps/web/test/content.test.ts
git commit -m "docs: add contributor and agent guides"
```

### Task 6: Verify the complete documentation product

**Files:**
- Modify: `apps/web/test/routes.test.ts`
- Modify: `apps/web/test/content.test.ts`
- Modify: `apps/web/test/distribution.test.ts` only if current cache assertions conflict with the reviewed local cache-header change
- Modify: `.github/workflows/web.yml` only if a new focused documentation test command is introduced

**Interfaces:**
- Consumes: the complete MDX corpus and existing Fumadocs distribution routes.
- Produces: a review-ready documentation branch with human/LLM parity and production verification.

- [ ] **Step 1: Add failing machine-readable parity assertions**

For every page, assert the full corpus and page Markdown contain its title and processed body marker. Assert `/llms.txt` lists every canonical URL exactly once. Add a test that no page contains duplicate explicit `# <front-matter title>` content, because Fumadocs already renders the page title.

- [ ] **Step 2: Run the route tests and verify any parity failure**

```bash
pnpm vitest run apps/web/test/routes.test.ts apps/web/test/content.test.ts
```

Expected: FAIL if any page is omitted, duplicated, or rendered inconsistently.

- [ ] **Step 3: Fix only content or route-source defects exposed by the tests**

Keep `source.getPages()` as the single page inventory. Do not add a manually maintained second page list outside the navigation contract tests.

- [ ] **Step 4: Run all documentation and site gates**

```bash
pnpm lint
pnpm --filter @argus/web generate
pnpm vitest run apps/web/test
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web build
pnpm --filter @argus/web check:links
pnpm --filter @argus/web exec lhci autorun --config=lighthouserc.json
```

Expected: all commands pass; Lighthouse retains the repository's configured thresholds.

- [ ] **Step 5: Inspect rendered documentation locally**

Run the production server and inspect `/docs`, one source page, the API reference, troubleshooting, contributor architecture, `/llms.txt`, and `/llms-full.txt` at desktop and mobile widths. Confirm navigation grouping, code wrapping, tables, headings, and internal links are usable.

- [ ] **Step 6: Commit final parity fixes**

```bash
git add apps/web/test apps/web/content/docs .github/workflows/web.yml
git commit -m "test: enforce documentation parity"
```

- [ ] **Step 7: Push a focused branch and open a pull request**

Use a branch named `docs/operator-handbook`. The PR description should state plainly that it completes operator/contributor documentation and makes examples and LLM routes contractual. Do not include unrelated local application changes.
