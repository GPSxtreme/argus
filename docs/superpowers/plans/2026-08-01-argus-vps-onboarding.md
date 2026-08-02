# Argus VPS Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the resumable `argus onboard` workflow and lifecycle commands that manage a complete single-VPS Docker deployment, including SearXNG and FxEmbed.

**Architecture:** Add a testable `@argus/deployment` package containing schemas, reconciliation, service provisioners, and diagnostics. Keep `apps/cli` as a thin Commander and Clack interface over that package. The installed CLI runs in a pinned management container with `/opt/argus` and the host Docker socket mounted; application containers remain separate.

**Tech Stack:** Node.js 24, TypeScript 6, Zod 4, Commander 14, `@clack/prompts` 1.7.0, Execa 10.0.1, Docker Compose, Vitest

## Global Constraints

- V1 supports Ubuntu and Debian VPS hosts on Linux x64 and arm64.
- Docker Compose is the only V1 deployment substrate.
- SQLite is the default; PostgreSQL is optional.
- Instance state lives under `/opt/argus`.
- SearXNG is private and managed locally when web queries are enabled.
- FxEmbed managed mode deploys a pinned bundle to the user's Cloudflare account.
- Secrets must never appear in YAML, state, logs, JSON output, or agent context.
- All mutations follow inspect, plan, confirm, apply, verify, and atomic-state-write.
- Re-running onboarding must not duplicate resources.
- Existing ingestion, API, and direct development commands must continue to pass their tests.

## Cross-plan Execution Order

1. Complete this plan through Task 8.
2. Complete Tasks 1–5 of `2026-08-01-argus-release-installer.md`.
3. Return here for Tasks 9–10.
4. Complete Task 6 of the release-installer plan.
5. Execute `2026-08-01-argus-agent-skill.md`.
6. Execute `2026-08-01-argus-project-site.md`.

---

## Planned File Structure

```text
packages/deployment/
  package.json                    package metadata
  tsconfig.json                   TypeScript project config
  src/contracts.ts                stable setup/state/result contracts
  src/errors.ts                   structured deployment failures
  src/executor.ts                 injectable host-command interface
  src/files.ts                    atomic files, permissions, backups
  src/config.ts                   answers -> runtime YAML/secrets
  src/preflight.ts                host capability inspection
  src/compose.ts                  pinned Compose model and renderer
  src/searxng.ts                  SearXNG settings and health
  src/fxembed.ts                  Cloudflare Worker reconciliation
  src/reconciler.ts               start/stop/status/repair orchestration
  src/doctor.ts                   service and ingestion diagnostics
  src/update.ts                   backup/update/rollback state machine
  src/index.ts                    public exports
  test/*.test.ts                  focused unit/contract tests
  test/fixtures/                  command and Cloudflare fixtures
apps/cli/
  src/program.ts                  injectable Commander program factory
  src/output.ts                   human/JSON output adapter
  src/prompts.ts                  Clack prompt adapter
  src/main.ts                     process entry point only
  test/*.test.ts                  CLI contract tests
deploy/managed/
  searxng/settings.yml            minimal JSON-enabled settings
  compose.fixture.yaml            golden rendered Compose fixture
```

### Task 1: Deployment Contracts and Structured Errors

**Files:**
- Create: `packages/deployment/package.json`
- Create: `packages/deployment/tsconfig.json`
- Create: `packages/deployment/src/contracts.ts`
- Create: `packages/deployment/src/errors.ts`
- Create: `packages/deployment/src/index.ts`
- Test: `packages/deployment/test/contracts.test.ts`

**Interfaces:**
- Consumes: `ArgusConfig` from `@argus/config`.
- Produces: `OnboardingAnswersV1`, `DeploymentStateV1`, `DeploymentPlan`, `CommandResult`, `DiagnosticReport`, `DeploymentError`, and their Zod schemas.

- [ ] **Step 1: Write failing schema and redaction tests**

```ts
import { describe, expect, it } from "vitest";
import {
  onboardingAnswersSchema,
  deploymentStateSchema,
  DeploymentError,
} from "../src/index.js";

it("rejects managed X without a Cloudflare account id", () => {
  expect(() =>
    onboardingAnswersSchema.parse({
      version: 1,
      deployment: { provider: "vps-docker", root: "/opt/argus", storage: "sqlite", apiHost: "0.0.0.0", apiPort: 8788 },
      managed: { searxng: "disabled", fxembed: "managed" },
      cloudflare: {},
      watches: [],
      intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
    }),
  ).toThrow();
});

it("serializes deployment errors without secret causes", () => {
  const error = new DeploymentError("CF_DEPLOY_FAILED", "token secret-token failed", {
    secrets: ["secret-token"],
    recovery: "argus repair fxembed",
  });
  expect(error.toJSON()).toEqual({
    code: "CF_DEPLOY_FAILED",
    message: "token [REDACTED] failed",
    recovery: "argus repair fxembed",
  });
});
```

- [ ] **Step 2: Run the focused test and verify missing exports fail**

Run: `pnpm vitest run packages/deployment/test/contracts.test.ts`

Expected: FAIL because `../src/index.js` does not exist.

- [ ] **Step 3: Implement the versioned contracts**

```ts
export interface OnboardingAnswersV1 {
  version: 1;
  deployment: {
    provider: "vps-docker";
    root: string;
    storage: "sqlite" | "postgres";
    apiHost: string;
    apiPort: number;
  };
  managed: {
    searxng: "disabled" | "managed" | "external";
    fxembed: "disabled" | "managed" | "external";
  };
  cloudflare?: { accountId?: string };
  external?: { searxngEndpoint?: string; fxembedEndpoint?: string };
  watches: Array<{
    id: string;
    enabled: boolean;
    schedule: string;
    x: { accounts: string[]; queries: string[] };
    telegram: { channels: string[] };
    web: { urls: string[]; feeds: string[]; queries: string[] };
    keywords: string[];
    retentionDays?: number;
  }>;
  intelligence: { enabled: boolean; model: string; processors?: Array<{ id: string; schedule?: string; watchIds?: string[] }> };
}

export interface DeploymentStateV1 {
  schemaVersion: 1;
  argusVersion: string;
  composeProject: string;
  configHash: string;
  services: Record<string, { image: string; healthy: boolean }>;
  fxembed?: { accountId: string; workerName: string; endpoint: string; bundleHash: string };
  updatedAt: string;
}

export interface DeploymentPlan {
  contractVersion: 1;
  changes: Array<{
    component: "files" | "argus" | "postgres" | "searxng" | "fxembed";
    action: "create" | "update" | "restart" | "remove";
    summary: string;
    external: boolean;
  }>;
}

export interface DiagnosticReport {
  contractVersion: 1;
  healthy: boolean;
  checks: Array<{
    component: string;
    status: "healthy" | "unhealthy" | "skipped";
    code: string;
    message: string;
    recovery?: string;
    logsCommand?: string;
  }>;
}

export interface DeploymentErrorJSON {
  code: string;
  message: string;
  recovery?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

Implement discriminated Zod schemas and `DeploymentError.toJSON()` with exact secret replacement.

- [ ] **Step 4: Run contract tests, typecheck, and lint**

Run: `pnpm vitest run packages/deployment/test/contracts.test.ts && pnpm --filter @argus/deployment typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/deployment
git commit -m "feat: define deployment contracts"
```

### Task 2: Atomic Instance Files, Secrets, and Runtime Configuration

**Files:**
- Create: `packages/deployment/src/files.ts`
- Create: `packages/deployment/src/config.ts`
- Test: `packages/deployment/test/files.test.ts`
- Test: `packages/deployment/test/config.test.ts`

**Interfaces:**
- Consumes: `OnboardingAnswersV1`, `validateConfig()`.
- Produces: `instancePaths(root)`, `renderInstanceConfig(answers, endpoints)`, `writeInstanceFiles(input)`, `loadDeploymentState(root)`, and `saveDeploymentState(root, state)`.

- [ ] **Step 1: Write failing atomic-write and secret-reference tests**

```ts
it("writes runtime config without secret values", async () => {
  const rendered = renderInstanceConfig(answers, {
    searxng: "http://searxng:8080",
    fxembed: "https://argus-fx.workers.dev/api",
  });
  expect(rendered.yaml).toContain("token: ${ARGUS_API_TOKEN}");
  expect(rendered.yaml).not.toContain("api-secret");
  expect(rendered.secrets).toContain("ARGUS_API_TOKEN=api-secret");
});

it("creates secrets.env with mode 0600", async () => {
  await writeInstanceFiles({ root, rendered, io: nodeInstanceIO });
  expect((await stat(join(root, "secrets.env"))).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: Run tests and verify the functions are absent**

Run: `pnpm vitest run packages/deployment/test/files.test.ts packages/deployment/test/config.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement deterministic rendering and atomic writes**

`renderInstanceConfig()` must produce:

```yaml
version: 1
runtime:
  role: all
storage:
  adapter: sqlite
  url: /app/data/argus.db
sources:
  x:
    enabled: true
    endpoint: https://argus-fx.workers.dev/api
  web:
    enabled: true
    searchEndpoint: http://searxng:8080
api:
  host: 0.0.0.0
  port: 8788
  token: ${ARGUS_API_TOKEN}
```

Write temporary siblings with mode `0600`, `fsync`, and `rename`; write
non-secret YAML/state with mode `0644`. Validate the rendered YAML through
`loadConfig()` with the in-memory secrets map before replacing existing files.

- [ ] **Step 4: Verify focused and existing config tests**

Run: `pnpm vitest run packages/deployment/test packages/config/test`

Expected: PASS, including idempotent config reconciliation.

- [ ] **Step 5: Commit instance file support**

```bash
git add packages/deployment/src/files.ts packages/deployment/src/config.ts packages/deployment/test
git commit -m "feat: render secure instance configuration"
```

### Task 3: Host Command Executor and Preflight

**Files:**
- Create: `packages/deployment/src/executor.ts`
- Create: `packages/deployment/src/preflight.ts`
- Test: `packages/deployment/test/preflight.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CommandExecutor {
  run(command: string, args: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  }): Promise<CommandResult>;
}

export interface PreflightReport {
  supported: boolean;
  os: { id: "ubuntu" | "debian"; version: string; arch: "x64" | "arm64" };
  docker: { installed: boolean; compose: boolean; daemonReachable: boolean };
  resources: { memoryBytes: number; diskFreeBytes: number };
  ports: Array<{ port: number; available: boolean }>;
  failures: Array<{ code: string; message: string; recovery: string }>;
}
```

- [ ] **Step 1: Write failing fixture-driven preflight tests**

Use a fake executor returning `/etc/os-release`, `uname -m`, Docker version,
memory, disk, and socket output. Assert Ubuntu `aarch64` normalizes to `arm64`,
unsupported Fedora returns `supported: false`, and a busy API port produces
`PORT_IN_USE`.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/deployment/test/preflight.test.ts`

Expected: FAIL because `inspectHost()` is missing.

- [ ] **Step 3: Implement `createExecaExecutor()` and `inspectHost()`**

Use `execa()` only in the production adapter. Keep parsing functions pure and
export them for fixture tests. Minimum recommendations are 1 GiB memory for
SQLite, 2 GiB when SearXNG is enabled, and 5 GiB free disk.

- [ ] **Step 4: Run test, typecheck, and lint**

Run: `pnpm vitest run packages/deployment/test/preflight.test.ts && pnpm --filter @argus/deployment typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit preflight support**

```bash
git add packages/deployment package.json pnpm-lock.yaml
git commit -m "feat: inspect VPS prerequisites"
```

### Task 4: Compose Rendering and Core Lifecycle Reconciliation

**Files:**
- Create: `packages/deployment/src/compose.ts`
- Create: `packages/deployment/src/reconciler.ts`
- Create: `deploy/managed/compose.fixture.yaml`
- Test: `packages/deployment/test/compose.test.ts`
- Test: `packages/deployment/test/reconciler.test.ts`

**Interfaces:**
- Consumes: `CommandExecutor`, `DeploymentStateV1`, rendered instance files.
- Produces: `renderCompose(input)`, `inspectDeployment(context)`,
  `planDeployment(actual, desired)`, `applyDeployment(plan, context)`,
  `startDeployment()`, `stopDeployment()`, `restartDeployment()`,
  `getDeploymentStatus()`.

- [ ] **Step 1: Write failing golden and idempotency tests**

```ts
expect(renderCompose({
  version: "0.2.0",
  storage: "sqlite",
  searxng: true,
})).toBe(await readFile(fixture("compose.fixture.yaml"), "utf8"));

const second = planDeployment(await inspectDeployment(context), desired);
expect(second.changes).toEqual([]);
```

- [ ] **Step 2: Run tests and observe missing renderer/reconciler failures**

Run: `pnpm vitest run packages/deployment/test/compose.test.ts packages/deployment/test/reconciler.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement pinned services and plan/apply/verify**

The SQLite Compose model must include:

```yaml
services:
  argus:
    image: ghcr.io/gpsxtreme/argus:${ARGUS_VERSION}
    env_file: [secrets.env]
    environment:
      ARGUS_CONFIG: /app/argus.yaml
      ARGUS_ROLE: all
    volumes:
      - ./argus.yaml:/app/argus.yaml:ro
      - argus-data:/app/data
    ports:
      - "${ARGUS_API_PORT}:8788"
    restart: unless-stopped
```

Add PostgreSQL and SearXNG only when selected. Use project name `argus`, a
private network, image digests from a release manifest, and `docker compose
config` before apply. A no-change plan must execute no mutating command.

- [ ] **Step 4: Verify lifecycle tests**

Run: `pnpm vitest run packages/deployment/test/compose.test.ts packages/deployment/test/reconciler.test.ts`

Expected: PASS with command snapshots for start, stop, restart, and status.

- [ ] **Step 5: Commit lifecycle reconciliation**

```bash
git add packages/deployment deploy/managed
git commit -m "feat: reconcile VPS service lifecycle"
```

### Task 5: Managed SearXNG

**Files:**
- Create: `deploy/managed/searxng/settings.yml`
- Create: `packages/deployment/src/searxng.ts`
- Test: `packages/deployment/test/searxng.test.ts`
- Test: `packages/deployment/test/searxng.live.test.ts`

**Interfaces:**
- Produces: `renderSearxngSettings()`, `checkSearxngHealth(endpoint, fetcher)`,
  and `repairSearxng(context)`.

- [ ] **Step 1: Write a failing JSON-format and health test**

Assert settings contain `formats: [html, json]`, limiter remains enabled, the
service binds internally, and a fixture `/search?q=argus&format=json` response
with one result returns `{ healthy: true, resultCount: 1 }`.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/deployment/test/searxng.test.ts`

Expected: FAIL because the settings and health module do not exist.

- [ ] **Step 3: Implement managed settings, health, and repair**

`repairSearxng()` must rewrite only the versioned managed settings, run
`docker compose up -d --force-recreate searxng`, wait with bounded backoff,
and return a structured diagnostic rather than throwing raw fetch output.

- [ ] **Step 4: Run focused tests and a local opt-in Compose smoke**

Run: `pnpm vitest run packages/deployment/test/searxng.test.ts`

Run when Docker is available:
`ARGUS_SEARXNG_TEST=1 pnpm vitest run packages/deployment/test/searxng.live.test.ts`

Expected: unit PASS; live test returns at least one JSON search result.

- [ ] **Step 5: Commit managed SearXNG**

```bash
git add deploy/managed/searxng packages/deployment
git commit -m "feat: manage SearXNG deployment"
```

### Task 6: Managed FxEmbed Cloudflare Reconciliation

**Files:**
- Create: `packages/deployment/src/fxembed.ts`
- Create: `packages/deployment/test/fixtures/cloudflare-worker.json`
- Test: `packages/deployment/test/fxembed.test.ts`
- Test: `packages/deployment/test/fxembed.live.test.ts`

**Interfaces:**
- Produces:

```ts
export interface FxEmbedBundle {
  script: Uint8Array;
  sha256: string;
  compatibilityDate: string;
}

export interface CloudflareWorkersClient {
  getWorker(accountId: string, name: string): Promise<{ etag?: string; bundleHash?: string } | undefined>;
  putWorker(input: { accountId: string; name: string; bundle: FxEmbedBundle; token: string }): Promise<void>;
  enableWorkersDev(accountId: string, name: string, token: string): Promise<string>;
}

export function reconcileFxEmbed(input: {
  accountId: string;
  workerName: string;
  token: string;
  bundle: FxEmbedBundle;
  client: CloudflareWorkersClient;
}): Promise<{ changed: boolean; endpoint: string; bundleHash: string }>;
```

- [ ] **Step 1: Write failing create/update/no-op/redaction tests**

Assert a missing Worker uploads once, a matching bundle hash is a no-op, a
changed hash updates once, the deterministic name is `argus-fxembed`, and HTTP
errors never include the token.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/deployment/test/fxembed.test.ts`

Expected: FAIL on missing client and reconciler.

- [ ] **Step 3: Implement the Cloudflare API adapter**

Use Cloudflare's Workers Script API with `Authorization: Bearer`, multipart
metadata declaring the module entry point, and the pinned compatibility date
from the release bundle. Store only account ID, Worker name, endpoint, and
bundle hash in state. Never persist the token outside `secrets.env`.

- [ ] **Step 4: Verify fixture tests and gated live smoke**

Run: `pnpm vitest run packages/deployment/test/fxembed.test.ts`

Run only with a dedicated account:
`ARGUS_FXEMBED_LIVE=1 pnpm vitest run packages/deployment/test/fxembed.live.test.ts`

Expected: fixture PASS; live test deploys the deterministic Worker twice and
asserts the second run reports `changed: false`.

- [ ] **Step 5: Commit managed FxEmbed**

```bash
git add packages/deployment
git commit -m "feat: reconcile managed FxEmbed"
```

### Task 7: Doctor, Source Smoke Tests, and Repairs

**Files:**
- Create: `packages/deployment/src/doctor.ts`
- Test: `packages/deployment/test/doctor.test.ts`

**Interfaces:**
- Consumes: lifecycle status, Argus `/health`, enabled source configuration.
- Produces: `runDoctor(context): Promise<DiagnosticReport>` and
  `repairService(service, context)`.

- [ ] **Step 1: Write failing aggregate diagnostic tests**

Use fake checks for Docker, Argus, storage, SearXNG, FxEmbed, Telegram, Web,
and X. Assert failures include `component`, `code`, `message`, `recovery`, and
`logsCommand`; disabled components are `skipped`, not failed.

- [ ] **Step 2: Run focused test**

Run: `pnpm vitest run packages/deployment/test/doctor.test.ts`

Expected: FAIL because `runDoctor()` is missing.

- [ ] **Step 3: Implement bounded checks**

Run independent checks concurrently with per-check timeouts. For enabled
sources, enqueue a dedicated smoke-test watch through the authenticated API,
poll records to a fixed deadline, and verify canonical source URLs. Never
discard the user's existing data to perform a smoke test.

- [ ] **Step 4: Run focused and existing API tests**

Run: `pnpm vitest run packages/deployment/test/doctor.test.ts apps/argus/test/app.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit diagnostics**

```bash
git add packages/deployment
git commit -m "feat: diagnose managed Argus services"
```

### Task 8: Interactive Wizard and Stable CLI Output

**Files:**
- Create: `apps/cli/src/program.ts`
- Create: `apps/cli/src/output.ts`
- Create: `apps/cli/src/prompts.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/package.json`
- Test: `apps/cli/test/program.test.ts`
- Test: `apps/cli/test/onboard.test.ts`

**Interfaces:**
- Consumes: all public `@argus/deployment` operations.
- Produces: `createProgram(dependencies)`, `PromptAdapter`, stable JSON envelopes
  `{ contractVersion: 1, ok: boolean, data?: unknown, error?: DeploymentErrorJSON }`.

- [ ] **Step 1: Write failing CLI contract tests**

```ts
const result = await runCli(["status", "--json"], fakes);
expect(JSON.parse(result.stdout)).toEqual({
  contractVersion: 1,
  ok: true,
  data: { state: "running", services: { argus: "healthy" } },
});
expect(result.stderr).toBe("");
```

Add wizard tests proving disabled X skips Cloudflare questions, web queries
select managed SearXNG by default, and secrets call `secret()` rather than
`text()`.

- [ ] **Step 2: Run CLI tests**

Run: `pnpm vitest run apps/cli/test`

Expected: FAIL because `createProgram()` and prompt adapter do not exist.

- [ ] **Step 3: Refactor the entry point and register commands**

`main.ts` must contain only dependency construction, `parseAsync()`, and one
top-level error boundary. Register `onboard`, `start`, `stop`, `restart`,
`status`, `logs`, `doctor`, `repair`, `config`, and `secrets` in `program.ts`.
Use `@clack/prompts` only behind `PromptAdapter` so tests never require a TTY.

`onboard --from setup.yaml --json` treats `setup.yaml` as non-secret answers,
validates it with `onboardingAnswersSchema`, prompts only for missing secrets,
then invokes the same reconciliation function as interactive mode.
Implement `argus config schema --json` with Zod 4's `z.toJSONSchema()` and add
a contract test proving the emitted schema accepts the checked-in onboarding
fixture. Add tests proving `config show --json` redacts every value loaded from
`secrets.env`.

- [ ] **Step 4: Run CLI, full tests, typecheck, and lint**

Run: `pnpm vitest run apps/cli/test && pnpm test && pnpm typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit onboarding CLI**

```bash
git add apps/cli packages/deployment package.json pnpm-lock.yaml
git commit -m "feat: add interactive Argus onboarding"
```

### Task 9: Update, Backup, Rollback, and Repair

**Files:**
- Create: `packages/deployment/src/update.ts`
- Test: `packages/deployment/test/update.test.ts`
- Modify: `apps/cli/src/program.ts`

**Interfaces:**
- Consumes: verified `ReleaseManifestV1` from `@argus/release`; execute this
  task after Task 1 of the release-installer plan.
- Produces: `planUpdate()`, `applyUpdate()`, `backupInstance()`,
  `rollbackUpdate()`, and `repairService()`.

- [ ] **Step 1: Write failing state-machine tests**

Test a healthy update, failed migration, failed health check, successful
rollback, incompatible rollback, and no-op current version. Assert SQLite
backup includes `.db`, `-wal`, and `-shm` when present.
Add a CLI contract assertion that `argus update --json` returns the applied
version and final health report.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run packages/deployment/test/update.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement explicit update phases**

Use phases `planned`, `backed_up`, `pulled`, `migrated`, `restarted`,
`verified`, `rolled_back`. Persist the phase atomically after each successful
step. Never delete backups automatically in V1. Reject unsigned or
incompatible release manifests before stopping services.
Register `argus update` in `apps/cli/src/program.ts`; it must show the plan and
request confirmation in human mode, while JSON automation requires an
explicit `--yes` flag before applying mutations.

- [ ] **Step 4: Run update and CLI tests**

Run: `pnpm vitest run packages/deployment/test/update.test.ts apps/cli/test`

Expected: PASS with exact recovery commands.

- [ ] **Step 5: Commit update and repair**

```bash
git add packages/deployment apps/cli
git commit -m "feat: add safe Argus updates and repair"
```

### Task 10: Clean-VPS End-to-End Harness and Operations Documentation

**Files:**
- Create: `scripts/e2e/vps-smoke.sh`
- Create: `scripts/e2e/fixtures/onboard-web.yaml`
- Create: `.github/workflows/vps-smoke.yml`
- Modify: `docs/operations.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: installed CLI image and all lifecycle commands.
- Produces: repeatable Ubuntu/Debian smoke evidence.

- [ ] **Step 1: Add an initially failing workflow assertion**

The harness must run:

```bash
argus onboard --from /fixtures/onboard-web.yaml --json
argus onboard --from /fixtures/onboard-web.yaml --json
argus doctor --json
argus status --json
```

Assert the second onboarding result has `changes: []`, doctor is healthy, a
controlled Web page is ingested, SearXNG returns JSON, and only port 8788 is
publicly bound.

- [ ] **Step 2: Run the harness in an Ubuntu container/VM**

Run: `ARGUS_VPS_E2E=1 scripts/e2e/vps-smoke.sh ubuntu:24.04`

Expected: FAIL until the management image and fixtures are wired.

- [ ] **Step 3: Finish the harness and documentation**

Document installation, `/opt/argus`, secret permissions, backup paths,
managed/external modes, lifecycle commands, JSON contracts, and recovery
examples. Add Debian 13 and Ubuntu 24.04 workflow matrix entries; architecture
coverage is completed by the release plan.

- [ ] **Step 4: Run complete verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Run: `ARGUS_VPS_E2E=1 scripts/e2e/vps-smoke.sh ubuntu:24.04`

Expected: all local checks and the clean-VPS smoke pass.

- [ ] **Step 5: Commit VPS onboarding**

```bash
git add scripts/e2e .github/workflows/vps-smoke.yml README.md docs/operations.md
git commit -m "test: verify clean VPS onboarding"
```
