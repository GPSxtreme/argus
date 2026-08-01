# Biome and Husky Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared Biome lint command, local Husky checks, and push-only
lint CI.

**Architecture:** The root `package.json` owns the canonical lint command.
Husky hooks and GitHub Actions call root scripts rather than duplicating tool
arguments, keeping local and remote checks identical.

**Tech Stack:** Node.js 24, pnpm 10.33.0, Biome, Husky, GitHub Actions.

## Global Constraints

- Biome performs non-mutating lint checks; formatting is outside this change.
- Pre-commit runs lint only.
- Pre-push runs lint, typecheck, and tests.
- `.github/workflows/push.yaml` runs lint on every push.
- Existing `.github/workflows/ci.yml` remains responsible for tests,
  typechecking, and builds.

---

### Task 1: Establish the Biome lint contract

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `biome.json`
- Modify: source files reported by Biome

**Interfaces:**
- Produces: root scripts `lint` and `lint:check`.
- Consumes: TypeScript, JavaScript, and JSON files in the repository.

- [ ] **Step 1: Verify the lint command does not exist**

Run:

```bash
pnpm lint
```

Expected: non-zero exit because the root `lint` script is missing.

- [ ] **Step 2: Install Biome and add root scripts**

Run:

```bash
pnpm add --save-dev @biomejs/biome@latest
```

Add these scripts to `package.json`:

```json
{
  "lint": "biome lint .",
  "lint:check": "biome lint ."
}
```

- [ ] **Step 3: Add the Biome configuration**

Create `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.11/schema.json",
  "files": {
    "includes": [
      "**",
      "!**/node_modules",
      "!**/dist",
      "!**/coverage",
      "!**/.turbo",
      "!**/.worktrees",
      "!data"
    ]
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "formatter": {
    "enabled": false
  }
}
```

Use the schema version installed by pnpm if it differs from the example.

- [ ] **Step 4: Run lint and fix reported violations**

Run:

```bash
pnpm lint
```

Expected: PASS after source-level lint violations are corrected without
repository-wide formatting changes.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml biome.json apps packages
git commit -m "chore: add Biome linting"
```

### Task 2: Add Husky hooks and push CI

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `.husky/pre-commit`
- Create: `.husky/pre-push`
- Create: `.github/workflows/push.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: root scripts `lint`, `typecheck`, and `test`.
- Produces: install-time Husky initialization and push-triggered lint CI.

- [ ] **Step 1: Install and initialize Husky**

Run:

```bash
pnpm add --save-dev husky@latest
pnpm exec husky init
```

Ensure `package.json` contains:

```json
{
  "prepare": "husky"
}
```

- [ ] **Step 2: Configure portable hook commands**

Set `.husky/pre-commit` to:

```sh
pnpm lint
```

Set `.husky/pre-push` to:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

- [ ] **Step 3: Add push-only lint CI**

Create `.github/workflows/push.yaml` with:

```yaml
name: Push lint

on:
  push:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
```

- [ ] **Step 4: Document and execute the checks**

Add `pnpm lint` to the README development commands, then run:

```bash
pnpm prepare
.husky/pre-commit
.husky/pre-push
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/push.yaml")'
pnpm build
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml .husky .github/workflows/push.yaml README.md
git commit -m "chore: add local and push quality gates"
```
