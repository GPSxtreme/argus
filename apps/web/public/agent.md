# Argus — agent onboarding guide

You are reading this because your user wants to set up Argus: a self-hosted
data layer for AI agents. Argus collects public signals from X, public
Telegram announcement channels, and the Web; stores canonical revisioned
records; and exposes deterministic records plus optional OpenRouter summaries
and sourced natural-language queries. Collection itself remains deterministic.
Your job is to act as their install wizard.

## 1. Understand what the user wants

Before touching anything, ask the user:

- What do they want to monitor? (X accounts or searches, public Telegram
  announcement channels, web pages/RSS feeds, or SearXNG-backed web queries)
- Where will Argus run? Testing or just trying it out on their own machine
  is fine. For production, use a VPS or deployment service: Ubuntu
  22.04/24.04 or Debian 12/13, AMD64 or ARM64, sudo shell access, outbound
  HTTPS, and at least 5 GiB free disk. Never install onto a host already
  running Argus.
- Simple or separated deployment? SQLite suits a one-process deployment;
  PostgreSQL suits separated runtime roles.

Explain briefly as you go — the user may not know what Argus is yet. The
one-line pitch: "Argus watches public sources, keeps revisioned records with
proof, and gives your agents deterministic answers with source links."

## 2. Install the Argus skill (recommended)

If your environment supports skills, install the portable setup skill — it
carries the full operating rules for install, onboarding, diagnosis, and
repair:

- Skill page: https://argus.gpsxtre.me/skill
- Direct: https://argus.gpsxtre.me/skill/SKILL.md (read this even if you
  cannot install it as a skill — then follow it instead of this section)

## 3. Install and onboard

Run on the target VPS, with the user's explicit approval before each
external change:

```bash
curl -fsSL https://argus.gpsxtre.me/install.sh | sh
argus onboard
```

The installer verifies the release manifest signature before touching the
system. `argus onboard` is interactive; the CLI is the sole authority for
validation and deployment. Rules that protect the user:

- Never ask for, display, or store secret values in chat or in files you
  write; the CLI prompts for secrets itself, hidden.
- Read the live schema with `argus config schema --json`; never guess
  config fields.
- Get explicit user approval at every CLI confirmation boundary.
- When X is selected, prefer the CLI's same-VPS FxEmbed mode. It runs privately
  beside Argus and requires no Cloudflare account. Use Cloudflare or an external
  endpoint only when the user asks for it.

## 4. Verify

```bash
argus status --json
argus doctor --json
```

Report the exact health results. Then prove the loop works: add one watch
for something the user asked for in step 1, wait for a collection cycle, and
run a query — every answer should come back with records, a revision, and
source links.

## 5. Reference

- Docs index for agents: https://argus.gpsxtre.me/llms.txt
- Full docs inline: https://argus.gpsxtre.me/llms-full.txt
- Any docs page as raw Markdown: append `.md` to its URL, e.g.
  https://argus.gpsxtre.me/docs/quick-start.md
- Troubleshooting: https://argus.gpsxtre.me/docs/troubleshooting.md
