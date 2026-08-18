# Argus Web Redesign — Design Spec

Date: 2026-08-18
Scope: `apps/web` — landing page, docs theme, skill page styling.
Direction chosen via visual brainstorm (mockups in `.superpowers/brainstorm/43613-1787039394/content/`).

## Goals

- Keep the "refined terminal" identity (monospace, dark-first) but execute it at a much higher level.
- The page sells by **showing**: three animated moments demonstrate Argus working instead of describing it.
- One coherent brand across landing, docs, and skill page.
- Dark and light modes everywhere. Light mode uses a "paper terminal" palette — no dark panels on light pages.
- No new runtime dependencies. Plain CSS in `app/global.css`; animations are CSS-driven, with minimal JS only where CSS can't do it (query cycling, theme toggle).

## Non-goals

- No structural changes to Fumadocs (theming only, via `--color-fd-*` variable overrides).
- No new frameworks, component libraries, or Tailwind conversion of the landing page.
- No copy rewrite beyond what the new sections require.

## Design tokens

Single `:root` block defines dark (default); `[data-theme="light"]` and `prefers-color-scheme: light` override. Approximate values, tuned during build:

| Token | Dark | Light |
|---|---|---|
| `--canvas` | `#07090d` | `#fbfaf8` |
| `--surface` | `#0b1017` | `#f1efe9` |
| `--raised` | `#10161f` | `#e8e5db` |
| `--line` | `#223041` | `#ddd9cf` |
| `--ink` | `#eef2f6` | `#1a2129` |
| `--muted` | `#8b98a5` | `#5c6773` |
| `--accent` | `#6ee7b7` | `#0d9488` |
| `--accent-2` (cyan, log verbs) | `#56cfe1` | `#0e7490` |
| `--accent-3` (amber, strings) | `#f0c674` | `#a16207` |

Light-mode accents must meet AA contrast on `--canvas`/`--surface`. Terminal panels use `--surface`/`--raised` in both modes (paper terminal in light).

Theme toggle: small button in nav + a tiny inline `<head>` script that applies the stored preference before paint (no flash). Docs use Fumadocs' own toggle; both read/write the same `localStorage` key so preference is shared across surfaces.

## Landing page structure

1. **Nav** — wordmark `ARGUS` with blinking block cursor; links Docs, Agent Skill; theme toggle.
2. **Hero (split + live log)** — copy left (eyebrow, headline "Know what changed. Keep the proof.", short lede, Get Started / Read the Docs buttons); right side is an animated terminal panel ("argus — live") cycling through `watch`/`fetch` lines with revision counters and a `query` line returning `N records · N sources · Nms`.
3. **Install** — terminal-window styled box: title bar, `$`-prefixed curl command with copy button, `argus onboard` line, signature-verification note.
4. **Living pipeline diagram (C1)** — replaces the old Sources cards *and* Pipeline stepper. Full-width diagram: source nodes (X, Telegram, Web, each with a one-line detail) → animated packet wires → ARGUS core node (normalize · revision · store · dedupe, ticking `rev` counter) → return wire → "Your agent" node. Packets flow left→right on collect, right→left on answers.
5. **Query theater (C2)** — "Ask. Get receipts." Two panels: `you → argus` where queries type themselves (typewriter), and `argus → you` where a JSON answer with `records`, `revision`, `sources[]` streams in. Cycles through 3–4 example queries.
6. **Agent-skill callout** — restyled with new tokens, unchanged content.
7. **Footer** — tidied, unchanged content plus release tag link.

All animation honors `prefers-reduced-motion: reduce` (existing kill-switch stays; animated panels degrade to a completed static frame, not an empty one).

## Implementation notes

- `components/pipeline.tsx` and `components/data-trinity.tsx` are replaced by `components/flow-diagram.tsx`; new `components/live-log.tsx` and `components/query-theater.tsx`. All can be server components with CSS keyframe animation except query cycling, which uses a small client component.
- Hero log and diagram animations: pure CSS (staggered `animation-delay`, `steps()` typing, keyframed packet positions).
- Query theater cycling: one small `"use client"` component with a `setInterval`/CSS-class loop; canned data lives in the component.
- Grid collapses to single column on mobile; wires become vertical or hidden; diagram nodes stack.

## Docs theme

- Override Fumadocs CSS variables (`--color-fd-primary`, `--color-fd-background`, `--color-fd-border`, etc.) for both light and dark to match the token palette.
- Headings and nav in the same mono stack as the landing.
- Code block / syntax accent aligned with `--accent`/`--accent-2`.
- Import order arranged so overrides win over `fumadocs-ui/style.css`.

## Skill page

Reuse the landing tokens and button/terminal styles; no structural change.

## Error handling / edge cases

- JS disabled: theme falls back to `prefers-color-scheme`; query theater shows its first frame statically.
- `prefers-reduced-motion`: all loops disabled, static completed frames shown.
- Long install command wraps (`overflow-wrap: anywhere` retained).

## Testing

- Existing checks must pass: `pnpm --filter @argus/web typecheck`, build, `check:links`, Lighthouse CI config untouched.
- Visual verification in browser at desktop + mobile widths, dark + light, reduced-motion on/off.
