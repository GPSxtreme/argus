# Argus Config Filename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `argus.yaml` the default runtime configuration and
`argus.example.yaml` the distributed sample.

**Architecture:** Export one default filename from the configuration package so
the CLI and runtime cannot drift. Rename the sample and update deployment and
documentation references mechanically.

**Tech Stack:** TypeScript 6, Vitest, YAML, Docker Compose.

## Global Constraints

- `ARGUS_CONFIG` remains the explicit path override.
- No compatibility alias is added for the unreleased old filename.
- The configuration schema and contents do not change.

---

### Task 1: Rename the configuration files everywhere

**Files:**
- Rename: `argus.config.example.yaml` to `argus.example.yaml`
- Modify: `packages/config/src/load.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/test/load.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/argus/src/main.ts`
- Modify: `.env.example`
- Modify: `deploy/docker/Dockerfile`
- Modify: `deploy/docker/compose.yaml`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/superpowers/specs/2026-07-31-argus-v1-design.md`
- Modify: `docs/superpowers/plans/2026-07-31-argus-v1-implementation.md`

**Interfaces:**
- Produces: `DEFAULT_CONFIG_FILENAME = "argus.yaml"` from `@argus/config`.
- Consumes: existing `loadConfig(path, env)` and `ARGUS_CONFIG`.

- [ ] **Step 1: Add a failing default-filename behavior test**

Add to `packages/config/test/load.test.ts`:

```ts
it("resolves the short default configuration filename from the working directory", () => {
  expect(resolveConfigPath({ cwd: "/srv/argus", environment: {} }))
    .toBe("/srv/argus/argus.yaml");
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
pnpm vitest run packages/config/test/load.test.ts
```

Expected: failure because `resolveConfigPath` is not exported.

- [ ] **Step 3: Implement the rename**

Export `DEFAULT_CONFIG_FILENAME` and `resolveConfigPath` from the config
package, consume the resolver in the CLI and runtime entrypoint, rename the
sample to `argus.example.yaml`, and replace all active references with
`argus.yaml` or `argus.example.yaml`.

- [ ] **Step 4: Verify behavior and stale references**

Run:

```bash
pnpm vitest run packages/config/test/load.test.ts
pnpm test
pnpm typecheck
pnpm build
OPENROUTER_API_KEY=test ARGUS_API_TOKEN=test pnpm argus config validate argus.example.yaml
docker compose -f deploy/docker/compose.yaml config --quiet
rg -n "argus\\.config(\\.example)?\\.yaml" . --glob '!node_modules/**' --glob '!**/dist/**'
```

Expected: all commands pass and the final search returns only the historical
rename design/spec explanation, not an active runtime or documentation
reference.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "refactor: shorten Argus config filenames"
```
