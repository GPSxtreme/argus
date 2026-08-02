# Argus Agent Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one portable Agent Skills package that installs, onboards, diagnoses, repairs, and updates Argus exclusively through stable CLI contracts.

**Architecture:** Keep `SKILL.md` focused on routing and safety, with small reference files for choices and JSON contracts. The skill reads live schemas from `argus config schema --json`, uses non-secret answers files, and hands all secrets and mutations back to the CLI.

**Tech Stack:** Agent Skills open standard, Markdown/YAML, Argus CLI JSON contract v1, TypeScript/Vitest packaging checks

## Global Constraints

- Use the skill-creator and superpowers:writing-skills skills while authoring.
- The package must work in Codex and Claude Code without platform-specific core instructions.
- The skill must never request secret values in chat or write them into answers files.
- The skill must never edit Compose, `state.json`, managed service settings, or backups directly.
- External changes require the CLI's plan/confirmation boundary.
- The CLI is the only authority for validation, deployment, repair, and health.

---

## Planned File Structure

```text
skills/argus-setup/
  SKILL.md                         triggers and workflow
  LICENSE.txt                      project license
  references/setup-choices.md      supported questions/defaults
  references/cli-contracts.md      JSON v1 commands and result handling
  references/recovery.md           safe diagnostic routing
packages/release/
  src/skill.ts                     deterministic archive renderer
  test/skill.test.ts               package and secret-safety checks
scripts/skills/
  validate.ts                      deterministic format/link/safety validator
  smoke-scenarios.ts               CLI-backed skill scenarios
```

### Task 1: Skill Package Skeleton and Trigger Contract

**Files:**
- Create: `skills/argus-setup/SKILL.md`
- Create: `skills/argus-setup/LICENSE.txt`
- Create: `scripts/skills/validate.ts`
- Test: `packages/release/test/skill.test.ts`

**Interfaces:**
- Consumes: Agent Skills open standard.
- Produces: skill name `argus-setup` and description that triggers on install,
  setup, onboard, configure, deploy, diagnose, repair, update, and status.

- [ ] **Step 1: Invoke the required authoring skills**

Read `skill-creator` and `superpowers:writing-skills` completely before
creating the package. Record any required validation command in the task notes.

- [ ] **Step 2: Write failing package tests**

```ts
const skill = await loadSkill("skills/argus-setup");
expect(skill.frontmatter.name).toBe("argus-setup");
expect(skill.frontmatter.description).toMatch(/onboard|diagnose|repair/u);
expect(skill.body).toContain("argus config schema --json");
expect(skill.body).not.toMatch(/CLOUDFLARE_API_TOKEN=|OPENROUTER_API_KEY=/u);
```

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run packages/release/test/skill.test.ts`

Expected: FAIL because the skill is absent.

- [ ] **Step 4: Write the minimal portable `SKILL.md`**

Required workflow:

1. detect `argus`;
2. ask authorization before installation;
3. inspect `argus status --json`;
4. read `argus config schema --json`;
5. gather non-secret requirements;
6. validate an answers file;
7. tell the user which hidden secret prompts will appear;
8. call `argus onboard --from <file> --json`;
9. call `argus doctor --json`;
10. report exact health and recovery commands.

- [ ] **Step 5: Implement validation, validate, and commit the skeleton**

`scripts/skills/validate.ts` must parse YAML frontmatter, require `name` and
`description`, resolve all local links, reject symlinks/out-of-root paths, and
scan for the forbidden secret/action patterns used by the tests.

Run: `pnpm tsx scripts/skills/validate.ts skills/argus-setup`

Then:

```bash
git add skills/argus-setup scripts/skills/validate.ts packages/release/test/skill.test.ts
git commit -m "feat: add portable Argus setup skill"
```

### Task 2: Setup Choices and Live CLI Contract References

**Files:**
- Create: `skills/argus-setup/references/setup-choices.md`
- Create: `skills/argus-setup/references/cli-contracts.md`
- Modify: `skills/argus-setup/SKILL.md`
- Test: `packages/release/test/skill.test.ts`

**Interfaces:**
- Consumes: `OnboardingAnswersV1`, JSON envelope contract v1.
- Produces: unambiguous agent decision tree and result handling.

- [ ] **Step 1: Add failing link and contract tests**

Assert every local Markdown link resolves, every referenced command exists in
CLI help output, and examples use:

```json
{"contractVersion":1,"ok":true,"data":{}}
```

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/release/test/skill.test.ts`

Expected: FAIL on missing references.

- [ ] **Step 3: Write exact decision guidance**

`setup-choices.md` must encode these defaults:

- VPS Docker only;
- SQLite unless the user requests split services or PostgreSQL;
- managed SearXNG when any web query is configured;
- managed FxEmbed when X is enabled and no endpoint exists;
- public Telegram only;
- intelligence disabled unless explicitly requested.

`cli-contracts.md` must map each error code to either retry, ask user, run
doctor, or stop. It must tell agents to re-read the live schema rather than
copying schema fields from the reference.

- [ ] **Step 4: Validate package and Markdown links**

Run: `pnpm vitest run packages/release/test/skill.test.ts`

Run: `pnpm tsx scripts/skills/validate.ts skills/argus-setup`

Expected: PASS.

- [ ] **Step 5: Commit references**

```bash
git add skills/argus-setup packages/release/test/skill.test.ts
git commit -m "docs: define Argus skill setup contracts"
```

### Task 3: Diagnosis and Recovery Safety

**Files:**
- Create: `skills/argus-setup/references/recovery.md`
- Modify: `skills/argus-setup/SKILL.md`
- Test: `packages/release/test/skill.test.ts`

**Interfaces:**
- Consumes: `DiagnosticReport`, CLI structured errors.
- Produces: safe recovery routing without direct infrastructure edits.

- [ ] **Step 1: Write failing forbidden-action tests**

Reject skill text containing direct commands matching:

```text
docker compose down -v
docker volume rm
rm -rf /opt/argus
wrangler delete
cat /opt/argus/secrets.env
```

Assert it contains `argus repair`, `argus logs`, and the rule to stop when CLI
requests new authority.

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run packages/release/test/skill.test.ts`

Expected: FAIL until recovery guidance exists.

- [ ] **Step 3: Write recovery routing**

For unhealthy state:

1. run `argus doctor --json`;
2. summarize component/code/message;
3. use the returned `recovery` command exactly;
4. request user approval if it mutates host or Cloudflare state;
5. rerun doctor;
6. report remaining failures without improvising destructive commands.

- [ ] **Step 4: Validate the complete package**

Run: `pnpm tsx scripts/skills/validate.ts skills/argus-setup`

Run: `pnpm vitest run packages/release/test/skill.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit recovery behavior**

```bash
git add skills/argus-setup packages/release/test/skill.test.ts
git commit -m "docs: add safe Argus skill recovery"
```

### Task 4: Deterministic Skill Archive and Distribution Contract

**Files:**
- Create: `packages/release/src/skill.ts`
- Modify: `packages/release/src/index.ts`
- Modify: `packages/release/package.json`
- Test: `packages/release/test/skill-archive.test.ts`

**Interfaces:**
- Produces:

```ts
export function buildSkillArchive(
  root: string,
): Promise<{ bytes: Uint8Array; sha256: string }>;
```

The bytes are served from `/skill/argus-skill.zip`.

- [ ] **Step 1: Write failing reproducibility test**

Build the archive twice with different filesystem mtimes and assert identical
bytes, sorted paths, fixed timestamps, no `.DS_Store`, and root folder
`argus-setup/`.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/release/test/skill-archive.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement deterministic ZIP generation**

Add `fflate` to `@argus/release`. Include only `SKILL.md`, `LICENSE.txt`, and
`references/**/*.md`. Reject
symlinks and files outside the skill root. Set archive timestamps from
`SOURCE_DATE_EPOCH` and permissions to `0644`.

- [ ] **Step 4: Run archive and package validation**

Run: `pnpm vitest run packages/release/test/skill-archive.test.ts packages/release/test/skill.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit skill packaging**

```bash
git add packages/release
git commit -m "build: package the Argus Agent Skill"
```

### Task 5: Codex and Claude Code Smoke Scenarios

**Files:**
- Create: `scripts/skills/smoke-scenarios.ts`
- Create: `skills/argus-setup/test/scenarios.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: installed skill and fake Argus CLI.
- Produces: cross-agent behavioral evidence.

- [ ] **Step 1: Define exact scenarios**

Include:

1. fresh SQLite/Web install;
2. X setup requiring hidden Cloudflare secret entry;
3. existing healthy instance;
4. broken SearXNG repair;
5. invalid config;
6. update requiring confirmation.

Each scenario records allowed CLI calls, forbidden secret strings, and expected
final health.

- [ ] **Step 2: Run scenarios before wiring clients**

Run: `pnpm tsx scripts/skills/smoke-scenarios.ts --client=fake`

Expected: FAIL because scenario runner is incomplete.

- [ ] **Step 3: Implement fake and opt-in real-client adapters**

The default CI adapter validates decision traces deterministically. Add
opt-in `--client=codex` and `--client=claude` adapters that run only when those
CLIs and test credentials are explicitly available; never put credentials in
scenario transcripts.

- [ ] **Step 4: Validate all deterministic scenarios**

Run: `pnpm tsx scripts/skills/smoke-scenarios.ts --client=fake`

Run: `pnpm lint && pnpm typecheck && pnpm test`

Expected: PASS.

- [ ] **Step 5: Commit cross-agent verification**

```bash
git add scripts/skills skills/argus-setup README.md
git commit -m "test: verify Argus skill workflows"
```
