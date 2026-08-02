# Argus Agent Skill report

## Delivered

- Portable `argus-setup` Agent Skill with non-secret setup, status, diagnosis,
  recovery, and update routing through the Argus CLI only.
- Live-schema setup choices, JSON v1 error routing, and safe recovery
  references.
- A skill validator that checks frontmatter, local links, symlinks, root
  containment, and forbidden deployable instruction patterns.
- Reproducible ZIP generation with sorted entries, fixed timestamp, Unix 0644
  permissions, source-date support, and SHA-256 output.
- Six deterministic fake smoke scenarios plus opt-in Codex and Claude adapters.

## Test-first evidence

Each planned stage began with the required failing check:

1. Skill contract: missing `SKILL.md` caused the focused test to fail.
2. References: missing setup choices and contracts caused the focused test to fail.
3. Recovery: missing recovery reference caused the focused test to fail.
4. Archive: missing `fflate`, then missing `buildSkillArchive`, caused the archive test to fail.
5. Smoke runner: missing runner module caused the fake smoke command to fail.

## Verification

- `pnpm tsx scripts/skills/validate.ts skills/argus-setup` — passed.
- skill-creator `quick_validate.py` — passed in an isolated temporary Python environment.
- `pnpm tsx scripts/skills/smoke-scenarios.ts --client=fake` — passed six contracts.
- `pnpm lint && pnpm typecheck && pnpm test` — passed.

## Opt-in client status

Codex and Claude smoke adapters were invoked but safely skipped because explicit
disposable test credentials were unavailable. No credentials were requested,
read, or written.

## Commits

- `7ff61e7` — portable skill skeleton.
- `f514141` — setup choices and CLI contracts.
- `a127047` — safe recovery routing.
- `6ff9ce0` — deterministic archive.
- `e81eeda` — smoke contracts and documentation.
