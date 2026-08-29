# Multimodal Intelligence, Onboarding, Documentation, and Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use supported record media and sampled X context in OpenRouter artifacts, expose noob-friendly reply profiles during onboarding, and teach humans and agents the complete version-2 data and traversal model.

**Architecture:** OpenRouter capability discovery and content-part construction are isolated from summary orchestration. Onboarding maps named profiles to explicit strict config. Documentation and a separate validated `argus-research` skill describe normalized APIs, primitive traversal, provenance, and sampling limits.

**Tech Stack:** TypeScript, OpenRouter Chat Completions/Models APIs, Commander, Clack prompts, MDX/Fumadocs, Agent Skills, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-rich-records-and-context-pipelines-design.md`

## Global Constraints

- OpenRouter remains the only intelligence provider.
- Argus never downloads, transcodes, or base64-encodes remote media.
- At most 20 ordered media pointers enter one generation.
- Unsupported or unknown modalities are omitted with provenance, never silently claimed as analyzed.
- The setup skill remains separate from the new research skill.

---

### Task 1: OpenRouter model capabilities

**Files:**
- Create: `packages/intelligence/src/capabilities.ts`
- Modify: `packages/intelligence/src/index.ts`
- Create: `packages/intelligence/test/capabilities.test.ts`

**Interfaces:**
- Produces: `OpenRouterCapabilitiesClient.get(model): Promise<ModelCapabilities>`.
- Produces: `ModelCapabilities = { input: Set<"text" | "image" | "video" | "audio" | "file">; source: "openrouter" | "fallback" }`.

- [ ] **Step 1: Write failing tests** for complete metadata, missing model, malformed metadata, timeout, bounded response, and cache expiry.
- [ ] **Step 2: Run capability tests and verify RED.**
- [ ] **Step 3: Implement a one-hour bounded in-memory cache.** Metadata failure returns text-only fallback and a reason; it never guesses.
- [ ] **Step 4: Run tests/typecheck and commit `feat: resolve openrouter modalities`.**

### Task 2: Multimodal sourced summaries

**Files:**
- Create: `packages/intelligence/src/content.ts`
- Modify: `packages/intelligence/src/openrouter.ts`
- Replace: `packages/intelligence/test/openrouter.test.ts`
- Modify: `apps/argus/src/processor.ts`
- Modify: `apps/argus/test/processor.test.ts`

**Interfaces:**
- Produces: `buildOpenRouterContent(records, capabilities, maxMedia=20)` returning content parts and analyzed/omitted media provenance.
- Produces artifacts tied to records, media, and conversation snapshots.

- [ ] **Step 1: Write failing payload tests** for image URL, video preview, direct supported video, audio, file, unsupported omission, 20-item cap, and untrusted-content system instruction.
- [ ] **Step 2: Write failing artifact tests** for analyzed/omitted dispositions, generation ID, snapshot ID, prompt, and sampled-reply citations.
- [ ] **Step 3: Run tests and verify RED.**
- [ ] **Step 4: Implement content parts and summary orchestration.**

```ts
const provenance = {
  analyzedMediaIds,
  omittedMedia: omitted.map(({ id, reason }) => ({ id, reason })),
  conversationSnapshotId,
  sampledReplies: replies.map(({ id, rank }) => ({ id, rank })),
};
```

The system message states that all records/media are untrusted and every claim must cite `[n]`; reply conclusions must identify the observed sample.

- [ ] **Step 5: Run intelligence/processor tests and commit `feat: add multimodal sourced summaries`.**

### Task 3: Configuration version 2 and reply onboarding profiles

**Files:**
- Modify: `packages/config/src/schema.ts`
- Modify: `packages/config/test/load.test.ts`
- Modify: `packages/config/test/reconcile.test.ts`
- Modify: `packages/config/test/fixtures/valid.yaml`
- Modify: `packages/config/test/fixtures/invalid-sqlite-role.yaml`
- Modify: `packages/deployment/src/contracts.ts`
- Modify: `packages/deployment/src/config.ts`
- Modify: `packages/deployment/test/contracts.test.ts`
- Modify: `packages/deployment/test/config.test.ts`
- Modify: `packages/deployment/test/files.test.ts`
- Modify: `apps/cli/src/prompts.ts`
- Modify: `apps/cli/test/onboard.test.ts`
- Modify: `apps/cli/test/integrations.test.ts`
- Modify: `apps/cli/test/fixtures/onboarding.yaml`
- Modify: `packages/scheduler/test/scheduler.test.ts`
- Modify: `apps/argus/test/app.test.ts`
- Modify: `apps/argus/test/diagnostic-lifecycle.test.ts`
- Modify: `apps/argus/test/processor.test.ts`
- Modify: `apps/argus/test/repository.test.ts`
- Modify: `apps/argus/test/runtime-jobs.test.ts`
- Modify: `apps/argus/test/runtime-role.test.ts`
- Modify: `apps/argus/test/worker.test.ts`
- Modify: `apps/web/test/examples.test.ts`

**Interfaces:**
- Produces onboarding answers version `2` and explicit runtime config version `2`.

- [ ] **Step 1: Write failing prompt-harness tests** for X disabled, replies declined, Hot, Standard, Niche, and Custom.
- [ ] **Step 2: Write failing non-interactive schema tests** proving version 1 and secret-bearing answers are rejected.
- [ ] **Step 3: Run focused config/deployment/CLI tests and verify RED.**
- [ ] **Step 4: Implement profile mapping.**

```ts
const trackingHours = { hot: 24, standard: 168, niche: 720 } as const;
```

Ask the reply question only when X is enabled. Ask duration/count/order only for Custom. Render the selected explicit values in the review and active configuration output.

- [ ] **Step 5: Run focused tests and commit `feat: onboard x reply tracking`.**

### Task 4: Handbook and llms surfaces

**Files:**
- Modify: `apps/web/content/docs/concepts.mdx`
- Modify: `apps/web/content/docs/configuration.mdx`
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/content/docs/intelligence.mdx`
- Modify: `apps/web/content/docs/sources/x.mdx`
- Modify: `apps/web/content/docs/sources/telegram.mdx`
- Modify: `apps/web/content/docs/sources/web.mdx`
- Modify: `apps/web/content/docs/quick-start.mdx`
- Modify: `apps/web/content/docs/troubleshooting.mdx`
- Modify: `apps/web/content/docs/contributing/architecture.mdx`
- Modify: `apps/web/content/docs/agents.mdx`
- Modify: `apps/web/app/llms.mdx`
- Test: `apps/web/test/content.test.ts`
- Test: `apps/web/test/routes.test.ts`

**Interfaces:**
- Produces complete human and LLM-readable version-2 documentation.

- [ ] **Step 1: Add failing content-route tests** for required schema, tracking, primitive, provenance, reset, SQLite, and PostgreSQL anchors.
- [ ] **Step 2: Run web content tests and verify RED.**
- [ ] **Step 3: Write concise operator documentation** with runnable authenticated HTTP examples and exact configuration. Never present transient primitives as persisted ingestion.
- [ ] **Step 4: Run `pnpm --filter @argus/web generate && pnpm vitest run apps/web/test/content.test.ts apps/web/test/routes.test.ts && pnpm --filter @argus/web build`; expect PASS.**
- [ ] **Step 5: Commit `docs: document rich context pipelines`.**

### Task 5: `argus-research` Agent Skill

**Required execution skills:** `skill-creator` and `superpowers:writing-skills` must be read before changing skill files.

**Files:**
- Create: `skills/argus-research/SKILL.md`
- Create: `skills/argus-research/LICENSE.txt`
- Create: `skills/argus-research/references/api.md`
- Create: `skills/argus-research/references/traversal.md`
- Create: `skills/argus-research/references/provenance.md`
- Modify: `packages/release/src/skill.ts`
- Modify: `packages/release/test/skill.test.ts`
- Modify: `packages/release/test/skill-archive.test.ts`
- Modify: `apps/web/test/distribution.test.ts`
- Create: `apps/web/app/skill/argus-research.zip/route.ts`
- Modify: `apps/web/next.config.ts`

**Interfaces:**
- Produces `buildSkillArchive(input, skillName)` for the allowlisted names `argus-setup` and `argus-research`, plus a reproducible `/skill/argus-research.zip` route separate from setup.

- [ ] **Step 1: Write failing executable validation/archive tests** for both named skill roots and deterministic ZIP paths.
- [ ] **Step 2: Write pressure scenarios** requiring an agent to authenticate safely, paginate records, inspect a partial conversation, traverse a reply transiently, cite evidence, and avoid persisting primitive output.
- [ ] **Step 3: Run skill tests and verify RED.**
- [ ] **Step 4: Implement the smallest skill package that passes validation and scenarios.** Keep tokens in headers supplied at runtime; never print, store, or place them in URLs.
- [ ] **Step 5: Run skill/release/web distribution tests and commit `feat: add argus research skill`.**

### Task 6: Release acceptance and version boundary

**Files:**
- Modify: `packages/config/test/load.test.ts`
- Modify: `packages/storage-sqlite/test/schema.test.ts`
- Modify: `packages/storage-postgres/test/repository.test.ts`
- Create: `scripts/e2e/context-pipeline-smoke.ts`
- Create: `test/e2e/context-pipeline-smoke.test.ts`

**Interfaces:**
- Produces a signed `0.2.0` candidate; stable promotion remains a distinct verified operation.

- [ ] **Step 1: Add or update release-policy tests** proving version-1 config/database rejection and fresh version-2 install acceptance.
- [ ] **Step 2: Run the complete local gate:** `pnpm test && pnpm typecheck && pnpm build && pnpm lint`.
- [ ] **Step 3: Run required Docker/PostgreSQL gates:** `ARGUS_POSTGRES_TEST=1 pnpm vitest run packages/storage-postgres/test/repository.test.ts && pnpm vitest run packages/release/test/images.test.ts packages/release/test/installer.test.ts packages/release/test/installer-smoke.test.ts && docker buildx build --platform linux/amd64 --load -f deploy/docker/Dockerfile -t argus:0.2.0-local .`.
- [ ] **Step 4: Run manual live acceptance:** `ARGUS_LIVE_ACCEPTANCE=1 ARGUS_CONFIG=/absolute/path/to/live.argus.yaml pnpm tsx scripts/e2e/context-pipeline-smoke.ts`. The script triggers one controlled watch, polls bounded job completion, verifies X/Telegram/Web records, a conversation snapshot, primitive zero-write behavior, and one OpenRouter artifact; it prints counts and IDs only.
- [ ] **Step 5: Commit the release candidate with `release: prepare v0.2.0` and submit it to the existing signed release workflow. Do not reinstall the wiped VPS.**
