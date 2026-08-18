# Argus Web Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `apps/web` landing page as an animated "refined terminal" experience (live hero log, living pipeline diagram, self-typing query theater) with dark+light themes, and theme the Fumadocs docs to match.

**Architecture:** Plain CSS design-token system in `app/global.css` (dark default on `:root`, light overrides on `html.light`), theme switched by a `light`/`dark` class on `<html>` shared with Fumadocs' next-themes (`localStorage` key `theme`). Landing sections are React components; all animation is CSS keyframes except query cycling and interactivity (theme toggle, copy button), which are small client components. Docs are themed purely by overriding `--color-fd-*` variables in a stylesheet imported after `fumadocs-ui/style.css`.

**Tech Stack:** Next.js 16 (app router), React 19, plain CSS, fumadocs-ui 16. **No new dependencies.**

## Global Constraints

- No new package.json dependencies.
- Spec: `docs/superpowers/specs/2026-08-18-web-redesign-design.md`. Mockups (visual reference): `.superpowers/brainstorm/43613-1787039394/content/`.
- All animation must be disabled under `prefers-reduced-motion: reduce` (a global kill-switch rule exists; animated components must still look complete when frozen — no empty panels).
- Light mode is a full "paper terminal": demo panels use light `--surface`/`--raised`, never dark-on-light.
- Verification per task: `pnpm --filter @argus/web typecheck` must pass, and the page must be visually verified in the running dev server (`pnpm --filter @argus/web dev`, port 3000) in BOTH themes.
- Commit after every task (repo uses husky; `--no-verify` not allowed here).
- Copy (headline, lede, install note, section copy) is fixed in this plan — do not invent new marketing copy.

**Design tokens (exact values):**

| Token | Dark (`:root`) | Light (`html.light`) |
|---|---|---|
| `--canvas` | `#07090d` | `#fbfaf8` |
| `--surface` | `#0b1017` | `#f1efe9` |
| `--raised` | `#10161f` | `#e8e5db` |
| `--line` | `#223041` | `#ddd9cf` |
| `--line-soft` | `#1a2532` | `#e5e1d7` |
| `--ink` | `#eef2f6` | `#1a2129` |
| `--muted` | `#8b98a5` | `#5c6773` |
| `--faint` | `#5b6a78` | `#8a8574` |
| `--accent` | `#6ee7b7` | `#0d9488` |
| `--accent-ink` | `#05130d` | `#ffffff` |
| `--accent-2` | `#56cfe1` | `#0e7490` |
| `--accent-3` | `#f0c674` | `#a16207` |
| `--glow` | `rgba(110,231,183,.25)` | `rgba(13,148,136,.18)` |

---

### Task 1: Design tokens, base styles, theme toggle

**Files:**
- Modify: `apps/web/app/global.css` (replace token block and base styles; keep existing section styles temporarily — later tasks replace them)
- Create: `apps/web/components/theme-toggle.tsx`
- Modify: `apps/web/app/layout.tsx` (no-flash theme script)
- Modify: `apps/web/app/page.tsx` (mount toggle in nav)

**Interfaces:**
- Produces: CSS custom properties per the Global Constraints table, available on every page; `ThemeToggle` (default-props-free client component rendering a button); `<html>` carries class `light` or `dark` before first paint.
- Consumes: nothing.

- [ ] **Step 1: Replace the token/base layer in `global.css`**

Replace lines 1–24 (`:root` through the `a` rule) of `apps/web/app/global.css` with:

```css
:root {
  color-scheme: dark;
  --canvas: #07090d;
  --surface: #0b1017;
  --raised: #10161f;
  --line: #223041;
  --line-soft: #1a2532;
  --ink: #eef2f6;
  --muted: #8b98a5;
  --faint: #5b6a78;
  --accent: #6ee7b7;
  --accent-ink: #05130d;
  --accent-2: #56cfe1;
  --accent-3: #f0c674;
  --glow: rgba(110, 231, 183, 0.25);
}

html.light {
  color-scheme: light;
  --canvas: #fbfaf8;
  --surface: #f1efe9;
  --raised: #e8e5db;
  --line: #ddd9cf;
  --line-soft: #e5e1d7;
  --ink: #1a2129;
  --muted: #5c6773;
  --faint: #8a8574;
  --accent: #0d9488;
  --accent-ink: #ffffff;
  --accent-2: #0e7490;
  --accent-3: #a16207;
  --glow: rgba(13, 148, 136, 0.18);
}

* { box-sizing: border-box; }

html { background: var(--canvas); }

body {
  min-height: 100vh;
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  line-height: 1.6;
}

a { color: inherit; }

.theme-toggle {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 0.85rem;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}
.theme-toggle:hover { color: var(--ink); border-color: var(--muted); }
```

Also update legacy color literals still in the file: `.primary` becomes `border-color: var(--accent); background: var(--accent); color: var(--accent-ink);`.

- [ ] **Step 2: Create `apps/web/components/theme-toggle.tsx`**

```tsx
"use client";

const STORAGE_KEY = "theme";

export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const next = root.classList.contains("light") ? "dark" : "light";
    root.classList.remove("light", "dark");
    root.classList.add(next);
    localStorage.setItem(STORAGE_KEY, next);
  };
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Toggle color theme">
      ◐
    </button>
  );
}
```

- [ ] **Step 3: Add the no-flash script to `apps/web/app/layout.tsx`**

Inside `<html lang="en">`, before `<body>`, add a `suppressHydrationWarning` attribute on `<html>` and:

```tsx
<head>
  {/* Applies stored/system theme before paint; shares the `theme` key with fumadocs next-themes. */}
  <script
    dangerouslySetInnerHTML={{
      __html: `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}document.documentElement.classList.add(t);}catch(e){document.documentElement.classList.add("dark");}})();`,
    }}
  />
</head>
```

- [ ] **Step 4: Mount the toggle in the landing nav (`app/page.tsx`)**

Add `import { ThemeToggle } from "../components/theme-toggle";` and inside `<div className="nav-links">` after the Agent Skill link: `<ThemeToggle />`.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @argus/web typecheck` → PASS. In the browser at `http://localhost:3000`: page renders as before (dark), toggle switches the whole page to the paper palette and persists across reload; no flash of wrong theme on reload.

- [ ] **Step 6: Commit**

```bash
git add apps/web && git commit -m "feat(web): design tokens, light theme, no-flash toggle"
```

---

### Task 2: Split hero with animated live log

**Files:**
- Create: `apps/web/components/live-log.tsx`
- Modify: `apps/web/app/page.tsx` (hero section becomes a split grid; install box moves below the split, styled in Task 3)
- Modify: `apps/web/app/global.css` (replace `.hero` styles; add `.term`, `.hero-split`, log animation)

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: `LiveLog` server component (no props); shared CSS classes `.term`, `.term-bar`, `.term-body`, `.t-accent`, `.t-verb`, `.t-str`, `.t-faint` reused by Tasks 3–5.

- [ ] **Step 1: Create `apps/web/components/live-log.tsx`**

```tsx
const lines = [
  ["watch", "x/@base .........", "rev 412"],
  ["watch", "tg/announcements .", "rev 89"],
  ["fetch", "web/rss ..........", "+3 new"],
  ["query", '"listings since 9am"', ""],
] as const;

export function LiveLog() {
  return (
    <div className="term live-log" aria-hidden="true">
      <div className="term-bar">
        <span className="term-dot" /><span className="term-dot" /><span className="term-dot" />
        <span>argus — live</span>
      </div>
      <div className="term-body">
        {lines.map(([verb, subject, result], i) => (
          <div className="log-line" style={{ animationDelay: `${i * 0.5}s` }} key={subject}>
            <span className="t-verb">{verb}</span> {subject} <span className="t-accent">{result}</span>
          </div>
        ))}
        <div className="log-line" style={{ animationDelay: "2s" }}>
          <span className="t-faint">→ 3 records · 3 sources · 12ms</span>
          <span className="cursor">▌</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite the hero in `app/page.tsx`**

```tsx
<section className="hero hero-split">
  <div>
    <p className="eyebrow">Self-hosted intelligence for agents</p>
    <h1>Know what changed. Keep the proof.</h1>
    <p className="lede">
      Argus collects public signals, normalizes them into revisioned records, and gives your agents deterministic answers with source links.
    </p>
    <div className="hero-actions">
      <a className="button primary" href="/docs/quick-start">Get Started</a>
      <a className="button" href="/docs">Read the Docs</a>
    </div>
  </div>
  <LiveLog />
</section>
```

(Keep the install box `<section className="install-box">` immediately after the hero for now; Task 3 restyles it.) Import: `import { LiveLog } from "../components/live-log";`

- [ ] **Step 3: Replace hero CSS and add terminal styles in `global.css`**

Replace the `.hero` rule with, and append:

```css
.hero { padding: 6rem 0 4rem; }
.hero-split { display: grid; grid-template-columns: 1.15fr 1fr; gap: 3rem; align-items: center; }
.landing h1, .skill-page h1 { font-size: clamp(2.4rem, 5.5vw, 4.2rem); letter-spacing: -.06em; line-height: 1.02; }

.term { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); overflow: hidden; font-size: .85rem; }
.term-bar { display: flex; align-items: center; gap: .35rem; padding: .5rem .75rem; background: var(--raised); border-bottom: 1px solid var(--line-soft); color: var(--faint); font-size: .72rem; }
.term-bar span:last-child { margin-left: .4rem; }
.term-dot { width: .5rem; height: .5rem; border-radius: 999px; background: var(--line); }
.term-body { padding: .8rem 1rem; color: var(--muted); line-height: 1.9; }
.t-verb { color: var(--accent-2); }
.t-accent { color: var(--accent); }
.t-str { color: var(--accent-3); }
.t-faint { color: var(--faint); }

.live-log { box-shadow: 0 0 40px var(--glow); }
.log-line { opacity: 0; animation: log-reveal .3s steps(2) forwards; }
.cursor { color: var(--accent); animation: blink 1.2s steps(1) infinite; }
@keyframes log-reveal { to { opacity: 1; } }
@keyframes blink { 50% { opacity: 0; } }
```

Note: the existing global reduced-motion rule sets `animation: none`, which would leave `.log-line` at `opacity: 0`. Add alongside it:

```css
@media (prefers-reduced-motion: reduce) { .log-line { opacity: 1; } }
```

Add wordmark cursor: `.wordmark::after { content: "▌"; margin-left: .1em; animation: blink 1.2s steps(1) infinite; }`

- [ ] **Step 4: Verify**

Typecheck passes. Browser: split hero, log lines reveal staggered, cursor blinks, glow visible in dark, paper terminal in light, single column not yet required (Task 6 handles responsive). With reduced motion emulated (devtools), all log lines visible.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): split hero with animated live log"
```

---

### Task 3: Install box as terminal window with copy button

**Files:**
- Create: `apps/web/components/copy-button.tsx`
- Modify: `apps/web/app/page.tsx` (install section markup)
- Modify: `apps/web/app/global.css` (`.install-box` styles)

**Interfaces:**
- Consumes: `.term*` classes from Task 2.
- Produces: `CopyButton` client component, props `{ text: string }`.

- [ ] **Step 1: Create `apps/web/components/copy-button.tsx`**

```tsx
"use client";

import { useState } from "react";

export function CopyButton({ text }: Readonly<{ text: string }>) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="copy-button" onClick={copy}>
      {copied ? "copied" : "⧉ copy"}
    </button>
  );
}
```

- [ ] **Step 2: Replace the install section in `app/page.tsx`**

```tsx
<section className="install-box term" aria-label="Install Argus">
  <div className="term-bar">
    <span className="term-dot" /><span className="term-dot" /><span className="term-dot" />
    <span>install</span>
  </div>
  <div className="term-body">
    <div className="install-line">
      <code><span className="t-accent">$</span> {installCommand}</code>
      <CopyButton text={installCommand} />
    </div>
    <code><span className="t-accent">$</span> argus onboard</code>
    <p className="install-note">
      The installer downloads the signed release from the public repository and verifies the manifest signature before touching your system.
    </p>
  </div>
</section>
```

Import `CopyButton`. Remove the old `.install-box` grid styling; add:

```css
.install-box { max-width: 760px; margin-top: .5rem; }
.install-line { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
.install-box code { overflow-wrap: anywhere; color: var(--ink); }
.copy-button { border: 0; background: none; color: var(--faint); font: inherit; font-size: .78rem; cursor: pointer; white-space: nowrap; }
.copy-button:hover { color: var(--accent); }
.install-note { margin: .5rem 0 0; color: var(--faint); font-size: .8rem; }
```

- [ ] **Step 3: Verify**

Typecheck passes. Browser: install box reads as a terminal window in both themes; copy button copies the curl command and flips to "copied" briefly.

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): terminal-style install box with copy button"
```

---

### Task 4: Living pipeline diagram (replaces Sources cards + Pipeline stepper)

**Files:**
- Create: `apps/web/components/flow-diagram.tsx`
- Delete: `apps/web/components/data-trinity.tsx`, `apps/web/components/pipeline.tsx`
- Modify: `apps/web/app/page.tsx` (swap `<DataTrinity />` and `<Pipeline />` for `<FlowDiagram />`)
- Modify: `apps/web/app/global.css` (remove `.source-grid`, `.source-card`, `.source-mark`, `.pipeline*` rules; add flow styles)

**Interfaces:**
- Consumes: tokens, `.eyebrow`.
- Produces: `FlowDiagram` server component (no props); section markup `section.flow-section` containing `div.flow`.

- [ ] **Step 1: Create `apps/web/components/flow-diagram.tsx`**

```tsx
const sources = [
  ["X", "Accounts and search through your own FxEmbed Worker"],
  ["Telegram", "Public announcement channels only"],
  ["Web", "URLs, feeds, and managed SearXNG queries"],
] as const;

export function FlowDiagram() {
  return (
    <section className="flow-section" aria-labelledby="flow-title">
      <p className="eyebrow">How it works</p>
      <h2 id="flow-title">Signals in. Receipts out.</h2>
      <div className="flow">
        <div className="flow-sources">
          {sources.map(([name, detail], i) => (
            <div className="flow-node" key={name}>
              <span className="flow-node-name"><span className="flow-live" style={{ animationDelay: `${i * 0.8}s` }}>◉</span> {name}</span>
              <span className="flow-node-detail">{detail}</span>
            </div>
          ))}
        </div>
        <div className="flow-wires" aria-hidden="true">
          <span className="wire" /><span className="wire wire-2" /><span className="wire wire-3" />
        </div>
        <div className="flow-node flow-core">
          <span className="flow-node-name">ARGUS</span>
          <span className="flow-node-detail">normalize · revision<br />store · dedupe</span>
          <span className="flow-rev">rev 412</span>
        </div>
        <div className="flow-wires" aria-hidden="true">
          <span className="wire wire-back" />
        </div>
        <div className="flow-node">
          <span className="flow-node-name">Your agent</span>
          <span className="flow-node-detail">query &quot;since 9am&quot;</span>
          <span className="flow-answer">3 records · sourced</span>
        </div>
      </div>
      <p className="flow-caption">Revisioned records and deterministic queries keep every result traceable to its source.</p>
    </section>
  );
}
```

- [ ] **Step 2: Update `app/page.tsx`**

Remove `DataTrinity`/`Pipeline` imports and elements; add `import { FlowDiagram } from "../components/flow-diagram";` and render `<FlowDiagram />` where `<DataTrinity />` was. Delete the two old component files.

- [ ] **Step 3: Replace section CSS in `global.css`**

Remove `.data-trinity`, `.pipeline` selectors from the shared border-top rule (keep it for `.flow-section`, `.query-section`, `.agent-callout`), remove `.source-grid`, `.source-card`, `.source-mark`, and all `.pipeline*` rules. Add:

```css
.flow-section, .query-section, .agent-callout { border-top: 1px solid var(--line); padding: 5rem 0; }
.flow { display: grid; grid-template-columns: 15rem 1fr 12rem 1fr 13rem; align-items: center; margin-top: 2rem; }
.flow-sources { display: grid; gap: .75rem; }
.flow-node { display: grid; gap: .25rem; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: .8rem 1rem; font-size: .85rem; position: relative; z-index: 2; }
.flow-node-name { font-weight: 700; }
.flow-node-detail { color: var(--faint); font-size: .74rem; line-height: 1.45; }
.flow-live { color: var(--accent); animation: pulse 2.4s ease infinite; }
.flow-core { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 6%, var(--surface)), var(--surface)); text-align: center; box-shadow: 0 0 32px var(--glow); }
.flow-core .flow-node-name { color: var(--accent); letter-spacing: .12em; }
.flow-rev { color: var(--accent); font-size: .78rem; animation: pulse 2.4s ease infinite; }
.flow-answer { color: var(--accent-2); font-size: .78rem; animation: pulse 2.4s ease infinite; }
.flow-wires { display: grid; gap: 1.8rem; z-index: 1; }
.wire { position: relative; height: 2px; background: var(--line-soft); margin: 0 -1px; }
.wire::after { content: ""; position: absolute; top: -1px; left: 0; width: 1.4rem; height: 4px; border-radius: 4px; background: linear-gradient(90deg, transparent, var(--accent)); opacity: 0; animation: packet 2.4s linear infinite; }
.wire-2::after { animation-delay: .8s; }
.wire-3::after { animation-delay: 1.6s; }
.wire-back::after { background: linear-gradient(90deg, var(--accent-2), transparent); animation-name: packet-back; animation-duration: 3s; animation-delay: 1.2s; }
.flow-caption { color: var(--muted); margin-top: 2rem; }
@keyframes pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
@keyframes packet { 0% { left: -8%; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { left: 100%; opacity: 0; } }
@keyframes packet-back { 0% { left: 100%; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { left: -8%; opacity: 0; } }
```

Reduced-motion note: pulses/packets stop under the global kill-switch; nodes and wires remain fully drawn, so the frozen state is complete. Ensure `.wire::after` gets `opacity: 1` under reduced motion? No — packets should simply not render when frozen: add `@media (prefers-reduced-motion: reduce) { .wire::after { display: none; } }`.

- [ ] **Step 4: Verify**

Typecheck passes. Browser: packets travel source→core, one packet travels core→agent, rev/answer pulse; both themes; reduced motion shows static diagram without packets.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): living pipeline diagram replaces sources/pipeline sections"
```

---

### Task 5: Query theater

**Files:**
- Create: `apps/web/components/query-theater.tsx`
- Modify: `apps/web/app/page.tsx` (add `<QueryTheater />` between `<FlowDiagram />` and the agent callout)
- Modify: `apps/web/app/global.css`

**Interfaces:**
- Consumes: `.term*` classes (Task 2), `.query-section` border rule (Task 4).
- Produces: `QueryTheater` client component (no props).

- [ ] **Step 1: Create `apps/web/components/query-theater.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";

const demos = [
  {
    query: 'argus query "what did @base announce this week"',
    records: 3, revision: 412, sources: ['"x.com/base/…"', '"t.me/…"'],
  },
  {
    query: 'argus query "new listings since 9am"',
    records: 5, revision: 413, sources: ['"t.me/…"', '"rss/…"'],
  },
  {
    query: 'argus query "changes to pricing page"',
    records: 1, revision: 414, sources: ['"web/…"'],
  },
] as const;

const CYCLE_MS = 6000;

export function QueryTheater() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % demos.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);
  const demo = demos[index];
  return (
    <section className="query-section" aria-labelledby="query-title">
      <p className="eyebrow">Query</p>
      <h2 id="query-title">Ask. Get receipts.</h2>
      <div className="query-theater" key={index}>
        <div className="term">
          <div className="term-bar"><span>you → argus</span></div>
          <div className="term-body">
            <div><span className="t-accent">$</span> <span className="typeline">{demo.query}</span></div>
            <div className="t-faint qt-late">→ searching x · telegram · web</div>
          </div>
        </div>
        <div className="term">
          <div className="term-bar"><span>argus → you · 12ms</span></div>
          <div className="term-body qt-late">
            <div>{"{"}</div>
            <div>&nbsp;&nbsp;<span className="t-verb">&quot;records&quot;</span>: {demo.records}, <span className="t-verb">&quot;revision&quot;</span>: {demo.revision},</div>
            <div>&nbsp;&nbsp;<span className="t-verb">&quot;sources&quot;</span>: [<span className="t-str">{demo.sources.join(", ")}</span>]</div>
            <div>{"}"}</div>
          </div>
        </div>
      </div>
      <p className="flow-caption">Deterministic answers with source links on every record. No LLM in the loop.</p>
    </section>
  );
}
```

- [ ] **Step 2: Wire into `app/page.tsx` and add CSS**

Render `<QueryTheater />` after `<FlowDiagram />`. Append CSS:

```css
.query-theater { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 2rem; }
.query-theater .term-body { min-height: 7.5rem; }
.typeline { display: inline-block; white-space: nowrap; overflow: hidden; vertical-align: bottom; max-width: 100%; border-right: .5em solid var(--accent); animation: typing 2.2s steps(40) forwards; }
.qt-late { opacity: 0; animation: log-reveal .4s steps(2) 2.4s forwards; }
@keyframes typing { from { width: 0; } to { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .qt-late { opacity: 1; } .typeline { border-right: 0; } }
```

- [ ] **Step 3: Verify**

Typecheck passes. Browser: query types itself, then the searching line and the JSON answer appear; every 6s a new demo retypes (the `key={index}` remount restarts the CSS animations). Reduced motion: full static frame, no cycling. Both themes.

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): self-typing query theater section"
```

---

### Task 6: Responsive pass, skill page, footer polish

**Files:**
- Modify: `apps/web/app/global.css` (mobile rules)
- Modify: `apps/web/app/skill/page.tsx` (no structural change needed; verify styles)

**Interfaces:** consumes everything above; produces final responsive behavior.

- [ ] **Step 1: Replace the old mobile media query in `global.css`**

The existing `@media (max-width: 700px)` block references deleted classes. Replace with:

```css
@media (max-width: 860px) {
  .landing { width: min(100% - 2rem, 1120px); }
  .hero { padding: 3.5rem 0 3rem; }
  .hero-split, .query-theater { grid-template-columns: 1fr; gap: 1.5rem; }
  .flow { grid-template-columns: 1fr; gap: 1rem; }
  .flow-wires { display: none; }
  .flow-core { text-align: left; }
  .nav-links, .footer-links { gap: .75rem; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
}
```

- [ ] **Step 2: Verify**

Typecheck passes. Browser at 375px width: single column, no horizontal scroll, diagram stacks (wires hidden), install command wraps. Skill page renders correctly with new tokens in both themes at both widths.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): responsive pass for redesigned landing"
```

---

### Task 7: Docs theme

**Files:**
- Create: `apps/web/app/docs/docs-theme.css`
- Modify: `apps/web/app/docs/layout.tsx` (import the override css after `fumadocs-ui/style.css`)

**Interfaces:** consumes tokens (global.css is imported by the root layout, so variables exist); produces themed docs.

- [ ] **Step 1: Create `apps/web/app/docs/docs-theme.css`**

```css
/* Argus brand overrides for fumadocs; imported after fumadocs-ui/style.css so these win. */
:root {
  --color-fd-background: var(--canvas);
  --color-fd-foreground: var(--ink);
  --color-fd-card: var(--surface);
  --color-fd-card-foreground: var(--ink);
  --color-fd-popover: var(--raised);
  --color-fd-popover-foreground: var(--ink);
  --color-fd-muted: var(--surface);
  --color-fd-muted-foreground: var(--muted);
  --color-fd-border: var(--line);
  --color-fd-primary: var(--accent);
  --color-fd-primary-foreground: var(--accent-ink);
  --color-fd-secondary: var(--raised);
  --color-fd-secondary-foreground: var(--ink);
  --color-fd-accent: var(--raised);
  --color-fd-accent-foreground: var(--ink);
  --color-fd-ring: var(--accent);
}

#nd-docs-layout, #nd-nav, body {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
```

Note: because the `--color-fd-*` values point at our tokens, and our tokens flip via `html.light`/`html.dark` (the same class next-themes sets), one override block covers both modes. If fumadocs sets `.dark { --color-fd-* }` with higher specificity, duplicate the block under `.dark` — verify in the browser and add only if needed.

- [ ] **Step 2: Import it in `apps/web/app/docs/layout.tsx`**

After `import "fumadocs-ui/style.css";` add `import "./docs-theme.css";`

- [ ] **Step 3: Verify**

Typecheck passes. Browser `/docs` and `/docs/quick-start`: brand canvas/surface colors, mint links/accents, mono type; fumadocs theme toggle switches docs AND the stored preference carries to the landing (and vice versa). Check code blocks remain readable in both modes.

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): theme fumadocs to argus brand"
```

---

### Task 8: Full verification

**Files:** none new.

- [ ] **Step 1: Run the full check suite**

```bash
pnpm --filter @argus/web typecheck && pnpm --filter @argus/web build
```

Expected: both PASS.

- [ ] **Step 2: Link check**

```bash
pnpm --filter @argus/web check:links
```

Expected: no broken internal links.

- [ ] **Step 3: Browser sweep**

Dark + light × desktop (1280) + mobile (375) on `/`, `/docs`, `/docs/quick-start`, `/skill`; reduced-motion on `/` shows complete static frames. Check browser console for errors.

- [ ] **Step 4: Commit any fixes**

```bash
git add apps/web && git commit -m "fix(web): redesign verification fixes"
```
