# Argus Project Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the fast `argus.gpsxtre.me` landing page, Fumadocs documentation, verified installer route, LLM documentation interfaces, and Agent Skill downloads as one Vercel-deployed Next.js application.

**Architecture:** Add `apps/web` using Next.js App Router. Keep the landing route custom and nearly static; mount Fumadocs only under `/docs`. Generate every human and machine-readable documentation representation from version-controlled MDX, and consume installer/skill assets from workspace release packages.

**Tech Stack:** Next.js 16.2.12, React 19.2.8, Fumadocs Core/UI 16.14.0, Fumadocs MDX 15.2.1, TypeScript 6, Vercel, Vitest, Lighthouse CI

## Global Constraints

- Deploy from Vercel at `argus.gpsxtre.me`.
- One Next.js app owns landing, docs, installer, LLM, and skill routes.
- No CMS, database, authentication, analytics, tracking, cookies, chat, blog, or dashboard.
- Landing-page installation commands are visible above the fold.
- Landing page targets Lighthouse category scores above 95.
- MDX is the single documentation source.
- `/llms.txt`, `/llms-full.txt`, and `/docs/<path>.md` are stable product interfaces.
- `/install.sh` must use the canonical verified installer renderer.
- Skill routes must serve the same package validated in the Agent Skill plan.

---

## Planned File Structure

```text
apps/web/
  package.json
  tsconfig.json
  next.config.ts
  source.config.ts
  postcss.config.mjs
  app/
    layout.tsx
    global.css
    page.tsx
    docs/layout.tsx
    docs/[[...slug]]/page.tsx
    llms.txt/route.ts
    llms-full.txt/route.ts
    llms.mdx/docs/[[...slug]]/route.ts
    install.sh/route.ts
    skill/page.tsx
    skill/SKILL.md/route.ts
    skill/argus-skill.zip/route.ts
  proxy.ts
  components/
    copy-command.tsx
    data-trinity.tsx
    pipeline.tsx
  content/docs/
    index.mdx
    getting-started.mdx
    configuration.mdx
    sources/x.mdx
    sources/telegram.mdx
    sources/web.mdx
    operations.mdx
    agents.mdx
    meta.json
  lib/
    source.ts
    get-llm-text.ts
    site.ts
  test/routes.test.ts
  test/content.test.ts
vercel.json
```

### Task 1: Next.js and Fumadocs Application Shell

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/source.config.ts`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/global.css`
- Create: `apps/web/lib/site.ts`
- Modify: `turbo.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: workspace package `@argus/web`, site metadata, Fumadocs MDX
  collection `docs`, and Next build output.

- [ ] **Step 1: Add a failing workspace build**

Create the package with scripts:

```json
{
  "name": "@argus/web",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "typecheck": "tsc --noEmit"
  }
}
```

Run: `pnpm --filter @argus/web build`

Expected: FAIL because the Next app files and dependencies are missing.

- [ ] **Step 2: Install pinned web dependencies**

Run:

```bash
pnpm --filter @argus/web add next@16.2.12 react@19.2.8 react-dom@19.2.8 fumadocs-core@16.14.0 fumadocs-ui@16.14.0 fumadocs-mdx@15.2.1
pnpm --filter @argus/web add @argus/release@workspace:*
pnpm --filter @argus/web add -D @types/react @types/react-dom postcss tailwindcss
```

- [ ] **Step 3: Implement App Router and MDX configuration**

Define:

```ts
// source.config.ts
import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: { postprocess: { includeProcessedMarkdown: true } },
});

export default defineConfig();
```

Set canonical metadata to `https://argus.gpsxtre.me`, use local/system fonts,
and import Fumadocs CSS only from the documentation layout when supported.
Add `.next/**` to Turbo build outputs.

- [ ] **Step 4: Run build, typecheck, and lint**

Run: `pnpm --filter @argus/web build && pnpm --filter @argus/web typecheck && pnpm lint`

Expected: PASS with no network call at page-render time.

- [ ] **Step 5: Commit the web shell**

```bash
git add apps/web turbo.json pnpm-lock.yaml
git commit -m "feat: scaffold Argus project site"
```

### Task 2: Single-source Documentation

**Files:**
- Create: `apps/web/lib/source.ts`
- Create: `apps/web/app/docs/layout.tsx`
- Create: `apps/web/app/docs/[[...slug]]/page.tsx`
- Create: all files under `apps/web/content/docs/`
- Test: `apps/web/test/content.test.ts`

**Interfaces:**
- Produces: `source` loader with base URL `/docs` and statically generated
  documentation routes.

- [ ] **Step 1: Write failing content coverage tests**

```ts
const required = [
  "/docs/getting-started",
  "/docs/configuration",
  "/docs/sources/x",
  "/docs/sources/telegram",
  "/docs/sources/web",
  "/docs/operations",
  "/docs/agents",
];
expect(source.getPages().map((page) => page.url)).toEqual(expect.arrayContaining(required));
```

Also fail links pointing to missing local docs and require every page to have
title and description frontmatter.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run apps/web/test/content.test.ts`

Expected: FAIL because content and source loader are absent.

- [ ] **Step 3: Implement docs pages and initial content**

Use `loader({ baseUrl: "/docs", source: docs.toFumadocsSource() })`.
Document the actual CLI commands and V1 boundaries from the approved spec.
Getting Started must begin with:

```bash
curl -fsSL https://argus.gpsxtre.me/install.sh | sh
argus onboard
```

It must also show a download, checksum inspection, and explicit `sh
install.sh` path for users who do not pipe remote scripts into a shell.

X docs must state Cloudflare/FxEmbed requirements; Telegram docs must state
public announcement channels only; Web docs must distinguish direct URLs,
feeds, and managed SearXNG queries.

- [ ] **Step 4: Run content tests and production build**

Run: `pnpm vitest run apps/web/test/content.test.ts && pnpm --filter @argus/web build`

Expected: PASS and all docs are statically generated.

- [ ] **Step 5: Commit documentation**

```bash
git add apps/web/content apps/web/lib/source.ts apps/web/app/docs apps/web/test/content.test.ts
git commit -m "docs: publish Argus documentation"
```

### Task 3: LLM Documentation Interfaces

**Files:**
- Create: `apps/web/lib/get-llm-text.ts`
- Create: `apps/web/app/llms.txt/route.ts`
- Create: `apps/web/app/llms-full.txt/route.ts`
- Create: `apps/web/app/llms.mdx/docs/[[...slug]]/route.ts`
- Create: `apps/web/proxy.ts`
- Modify: `apps/web/next.config.ts`
- Test: `apps/web/test/routes.test.ts`

**Interfaces:**
- Produces: `getLLMText(page)`, `/llms.txt`, `/llms-full.txt`,
  `/docs/<path>.md`, and `Accept: text/markdown` negotiation.

- [ ] **Step 1: Write failing route-handler tests**

Assert:

- `llms.txt` includes title, description, and canonical URL for every page;
- `llms-full.txt` includes all headings exactly once;
- page Markdown has `Content-Type: text/markdown; charset=utf-8`;
- unknown Markdown pages return 404;
- no rendered HTML/navigation appears in Markdown.

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run apps/web/test/routes.test.ts`

Expected: FAIL on missing handlers.

- [ ] **Step 3: Implement Fumadocs-generated LLM routes**

Use `llms(source).index()` for the index and
`page.data.getText("processed")` for page/full content. Set `revalidate =
false`, canonical page URLs, explicit text content types, and a rewrite from
`/docs/:path*.md` to the Markdown handler. Add `Vary: Accept` for content
negotiation.

- [ ] **Step 4: Run route tests and inspect built routes**

Run: `pnpm vitest run apps/web/test/routes.test.ts && pnpm --filter @argus/web build`

Expected: PASS; Next build lists all three LLM route families.

- [ ] **Step 5: Commit LLM interfaces**

```bash
git add apps/web
git commit -m "feat: expose Argus docs for agents"
```

### Task 4: Installer and Agent Skill Distribution Routes

**Files:**
- Create: `apps/web/app/install.sh/route.ts`
- Create: `apps/web/app/skill/page.tsx`
- Create: `apps/web/app/skill/SKILL.md/route.ts`
- Create: `apps/web/app/skill/argus-skill.zip/route.ts`
- Modify: `apps/web/package.json`
- Test: `apps/web/test/distribution.test.ts`

**Interfaces:**
- Consumes: `renderInstaller()` and `buildSkillArchive()` from
  `@argus/release`.
- Produces: stable public distribution endpoints.

- [ ] **Step 1: Write failing response tests**

Assert `/install.sh` is `text/x-shellscript`, contains the production manifest
URL, and matches the release package renderer byte-for-byte. Assert
`/skill/SKILL.md` matches the repository entry file and ZIP entries pass the
skill archive contract.

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run apps/web/test/distribution.test.ts`

Expected: FAIL because routes are missing.

- [ ] **Step 3: Implement immutable/cached route handlers**

Set:

```text
install.sh              public, max-age=300, stale-while-revalidate=3600
skill/SKILL.md          public, max-age=300
skill/argus-skill.zip   attachment; filename="argus-skill.zip"
```

Do not duplicate installer or skill content in `apps/web`.
The ZIP handler serves `(await buildSkillArchive(skillRoot)).bytes`.

- [ ] **Step 4: Run distribution tests and curl a production build**

Run: `pnpm vitest run apps/web/test/distribution.test.ts`

Run the production server and:
`curl -fsSI http://localhost:3000/install.sh`

Expected: PASS with correct content type and cache headers.

- [ ] **Step 5: Commit distribution routes**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat: publish Argus installer and skill"
```

### Task 5: Minimal Landing Page

**Files:**
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/components/copy-command.tsx`
- Create: `apps/web/components/data-trinity.tsx`
- Create: `apps/web/components/pipeline.tsx`
- Modify: `apps/web/app/global.css`
- Test: `apps/web/test/landing.test.ts`

**Interfaces:**
- Produces: static landing page at `/`.

- [ ] **Step 1: Write failing semantic-content tests**

Assert one `h1`, visible install command, Get Started and Docs links, X /
Telegram / Web labels, collect-normalize-store-query steps, Agent Skill link,
footer links for docs/source/license/version, and no `script` tags for
analytics/chat/video vendors.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run apps/web/test/landing.test.ts`

Expected: FAIL because landing components are absent.

- [ ] **Step 3: Implement the page with server components by default**

Use only one client component for copy-to-clipboard. Keep decorative visuals
in CSS/SVG, respect reduced motion, and avoid external font/image requests.
Place these commands above the fold:

```bash
curl -fsSL https://argus.gpsxtre.me/install.sh | sh
argus onboard
```

Do not add pricing, testimonials, newsletter, blog, dashboard, animated
background libraries, or product screenshots in V1.

- [ ] **Step 4: Run landing tests, build, and lint**

Run: `pnpm vitest run apps/web/test/landing.test.ts && pnpm --filter @argus/web build && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit the landing page**

```bash
git add apps/web
git commit -m "feat: add the Argus landing page"
```

### Task 6: Performance, Accessibility, CI, and Vercel Deployment

**Files:**
- Create: `vercel.json`
- Create: `.github/workflows/web.yml`
- Create: `apps/web/lighthouserc.json`
- Modify: `README.md`
- Modify: `apps/web/package.json`

**Interfaces:**
- Produces: Vercel deployment config and enforced release budgets.

- [ ] **Step 1: Add initially failing CI budgets**

Set Lighthouse minimums:

```json
{
  "categories:performance": ["error", { "minScore": 0.95 }],
  "categories:accessibility": ["error", { "minScore": 0.95 }],
  "categories:best-practices": ["error", { "minScore": 0.95 }],
  "categories:seo": ["error", { "minScore": 0.95 }]
}
```

Add a landing-page first-load JavaScript budget of 90 KiB compressed and zero
third-party request origins.

- [ ] **Step 2: Run Lighthouse against the production build**

Run:
`pnpm --filter @argus/web build && pnpm --filter @argus/web start`

Run:
`pnpm exec lhci autorun --config=apps/web/lighthouserc.json`

Expected: FAIL until page/budget configuration is complete.

- [ ] **Step 3: Wire Vercel and CI**

Set the Vercel build command to `pnpm --filter @argus/web build`, output
through Next.js defaults, Node 24, and canonical domain
`argus.gpsxtre.me`. CI must run content tests, route tests, build, link check,
Lighthouse, and verify no secret or runtime instance file is included.

- [ ] **Step 4: Run full web and repository verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Run: `pnpm exec lhci autorun --config=apps/web/lighthouserc.json`

Expected: PASS with every Lighthouse category at or above 0.95.

- [ ] **Step 5: Commit and deploy**

```bash
git add apps/web .github/workflows/web.yml vercel.json README.md package.json pnpm-lock.yaml
git commit -m "ci: verify and deploy the Argus site"
```

After explicit user confirmation for the external DNS mutation, connect
`argus.gpsxtre.me` in Vercel, add the Cloudflare DNS record Vercel requests,
wait for TLS, then verify:

```bash
curl -fsS https://argus.gpsxtre.me/ >/dev/null
curl -fsS https://argus.gpsxtre.me/install.sh | sh -n
curl -fsS https://argus.gpsxtre.me/llms.txt | grep -F "Argus"
curl -fsS https://argus.gpsxtre.me/llms-full.txt | grep -F "argus onboard"
curl -fsS https://argus.gpsxtre.me/skill/SKILL.md | grep -F "argus-setup"
```
