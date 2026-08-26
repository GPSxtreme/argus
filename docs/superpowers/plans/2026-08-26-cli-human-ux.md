# Argus CLI Human UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give beginners an actionable interactive Argus home menu and make every default human command output concise and readable without changing existing direct-command JSON contracts.

**Architecture:** Add a small menu router that returns direct-command argv and delegates to a fresh Commander program, so interactive and direct flows share all operation, confirmation, redaction, and verification logic. Move human formatting into pure renderers at the CLI boundary; deployment adapters continue to return structured status and bounded raw logs, while `--json` bypasses human formatting.

**Tech Stack:** TypeScript 6, Commander 14, `@clack/prompts`, YAML 2, Vitest 3, Biome 2, existing Argus deployment adapters.

**Spec:** `docs/superpowers/specs/2026-08-26-cli-human-ux-design.md`

## Global Constraints

- Interactive prompts open only when both stdin and stdout are TTYs.
- Menu mutations use the existing inspect, confirm, apply, and verify paths.
- Existing direct-command JSON envelope shapes, exit codes, and redaction guarantees remain unchanged.
- Bare `argus --json` intentionally changes from a usage error to a versioned help success.
- Human output is not a compatibility surface and should be replaced rather than wrapped in legacy fallbacks.
- Raw logs remain bounded and become available only through `argus logs --raw` or the existing JSON data field.
- No new runtime dependency is required; use the libraries already installed.

---

### Task 1: Pure Human Renderers

**Files:**
- Create: `apps/cli/src/human.ts`
- Create: `apps/cli/test/human.test.ts`
- Modify: `apps/cli/src/program.ts:372-407`

**Interfaces:**
- Consumes: raw deployment status objects, `DiagnosticReport`, raw Docker Compose log strings, configuration objects, and generic inspected plans.
- Produces: `renderHumanStatus(value: unknown): string`, `renderHumanDoctor(report: DiagnosticReport): string`, `renderHumanLogs(raw: string): string`, `renderHumanConfig(value: unknown): string`, and `renderHumanPlan(plan: unknown): string`.

- [ ] **Step 1: Write failing renderer tests with literal expectations**

Add tests that prove the production behavior, including this minimum fixture set:

```ts
expect(renderHumanStatus({
  state: "running",
  services: { argus: "healthy", searxng: "" },
})).toBe("Argus is running\n\n  argus     healthy\n  searxng   unknown");

expect(renderHumanLogs(
  'argus-1  | {"level":30,"time":1787743134312,"pid":7,"hostname":"host","name":"argus","targetId":"screen-news:web:query:movies","inserted":7,"revised":0,"duplicates":19,"msg":"job complete"}\n',
)).toBe(
  "11:18:54  argus    INFO  job complete  source=web target=screen-news:web:query:movies inserted=7 revised=0 duplicates=19",
);

expect(renderHumanLogs(
  "searxng-1  | Too many requests from upstream\n",
)).toBe("--:--:--  searxng  LOG   Too many requests from upstream");

expect(renderHumanConfig({ api: { token: "[REDACTED]" } })).toBe(
  'api:\n  token: "[REDACTED]"',
);

expect(renderHumanPlan({
  currentVersion: "0.1.22",
  targetVersion: "0.1.22",
  changes: [],
  noop: true,
})).toBe("Argus is already up to date (0.1.22).");
```

Also cover Pino levels 10–60, invalid JSON, multiline non-JSON logs, retry fields, changed plans, lifecycle plans, and diagnostics with recovery guidance. Derive all expected strings literally rather than by calling production helpers.

- [ ] **Step 2: Run renderer tests and verify RED**

Run: `pnpm vitest run apps/cli/test/human.test.ts`

Expected: FAIL because `../src/human.js` and its exported renderers do not exist.

- [ ] **Step 3: Implement the pure renderers**

Create `human.ts` with no IO or deployment side effects. Use these exact exported signatures:

```ts
import type { DiagnosticReport } from "@argus/deployment";
import { stringify } from "yaml";

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export const renderHumanStatus = (value: unknown): string => {
  const status = value && typeof value === "object"
    ? value as { state?: unknown; services?: unknown }
    : {};
  const state = nonEmpty(status.state) ?? "unknown";
  const services = status.services && typeof status.services === "object"
    ? Object.entries(status.services)
    : [];
  const width = Math.max(0, ...services.map(([name]) => name.length));
  return [
    `Argus is ${state}`,
    ...(services.length ? ["", ...services.map(([name, serviceState]) =>
      `  ${name.padEnd(width)}   ${nonEmpty(serviceState) ?? "unknown"}`)] : []),
  ].join("\n");
};

export const renderHumanDoctor = (report: DiagnosticReport): string => [
  `Argus diagnostics: ${report.healthy ? "healthy" : "needs attention"}`,
  "",
  ...report.checks.flatMap((check) => [
    `  ${check.component.padEnd(10)} ${check.status}  ${check.message}`,
    ...(check.recovery ? [`               Try: ${check.recovery}`] : []),
  ]),
].join("\n");

export const renderHumanLogs = (raw: string): string =>
  raw.trimEnd().split("\n").filter(Boolean).map(renderLogLine).join("\n");
export const renderHumanConfig = (value: unknown): string => stringify(value).trimEnd();
export const renderHumanPlan = (plan: unknown): string => {
  const value = plan && typeof plan === "object"
    ? plan as Record<string, unknown>
    : {};
  const current = nonEmpty(value.currentVersion);
  const target = nonEmpty(value.targetVersion);
  const changes = Array.isArray(value.changes) ? value.changes : [];
  if (value.noop === true && target) return `Argus is already up to date (${target}).`;
  return [
    "Plan",
    ...(current ? ["", `  Current   ${current}`] : []),
    ...(target ? [`  Target    ${target}`] : []),
    ...(changes.length ? ["", ...changes.map(renderPlanChange)] : ["", "  No changes."]),
  ].join("\n");
};
```

Define the private `renderLogLine(line: string): string` and `renderPlanChange(change: unknown): string` immediately above the exports. `renderLogLine` uses `/^([^\s]+?)-\d+\s+\|\s?(.*)$/u` to split service and payload, `JSON.parse` inside a narrow try/catch, the explicit Pino level map, `new Date(time).toISOString().slice(11, 19)` for the clock, and `padEnd` columns for service and level. `renderPlanChange` reads `action`, `component`, and `summary` from object values and returns `  • ${summary}` when a non-empty summary exists, otherwise `  • ${action} ${component}` with missing values normalized to `change` and `component`.

`renderHumanLogs` must:

1. split bounded output into lines;
2. parse the optional `service-N | payload` Compose prefix;
3. parse JSON payloads only when they are objects;
4. map Pino levels `{10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL"}`;
5. format epoch milliseconds as UTC `HH:mm:ss`;
6. retain only `source`, `targetId`, `attempt`, `maxAttempts`, `retryAt`, `inserted`, `revised`, and `duplicates` as detail fields;
7. derive `source` from the second colon-delimited target segment when the log omits it;
8. omit PID, hostname, logger name, job ID, and other opaque metadata;
9. preserve non-JSON payload text under the normalized service name.

- [ ] **Step 4: Replace inline renderers and verify GREEN**

Import the five renderers into `program.ts`, remove `renderHumanPlan`, `renderHumanStatus`, and `renderHumanDoctor` from that file, and run:

`pnpm vitest run apps/cli/test/human.test.ts apps/cli/test/program.test.ts`

Expected: PASS with no stderr warnings.

- [ ] **Step 5: Commit the renderer boundary**

```bash
git add apps/cli/src/human.ts apps/cli/src/program.ts apps/cli/test/human.test.ts
git commit -m "feat: add readable CLI renderers"
```

---

### Task 2: Actionable Interactive Home Menu

**Files:**
- Create: `apps/cli/src/menu.ts`
- Create: `apps/cli/test/menu.test.ts`
- Modify: `apps/cli/src/program.ts:636-946`
- Modify: `apps/cli/src/prompts.ts:30-40`
- Modify: `apps/cli/test/program.test.ts`
- Modify: `apps/cli/test/process.test.ts`

**Interfaces:**
- Consumes: `PromptAdapter` and the existing direct command surface.
- Produces: `selectMenuInvocation(prompt: PromptAdapter): Promise<readonly string[] | null>`; a non-null value is argv for a direct Argus command, while `null` means Exit.

- [ ] **Step 1: Write failing menu-routing tests**

Use a queue-backed real `PromptAdapter` test double and literal argv assertions:

```ts
expect(await selectMenuInvocation(promptReturning("status"))).toEqual(["status"]);
expect(await selectMenuInvocation(promptReturning("onboard"))).toEqual(["onboard"]);
expect(await selectMenuInvocation(promptReturning("doctor"))).toEqual(["doctor"]);
expect(await selectMenuInvocation(promptReturning("update"))).toEqual(["update"]);
expect(await selectMenuInvocation(promptReturning("exit"))).toBeNull();
```

Add submenu cases:

```ts
expect(await selectMenuInvocation(promptQueue("logs", "argus", "50"))).toEqual([
  "logs", "argus", "--tail", "50",
]);
expect(await selectMenuInvocation(promptQueue("config", "show"))).toEqual([
  "config", "show",
]);
expect(await selectMenuInvocation(promptQueue("services", "restart"))).toEqual([
  "restart",
]);
expect(await selectMenuInvocation(promptQueue("secrets", "ARGUS_API_TOKEN"))).toEqual([
  "secrets", "set", "ARGUS_API_TOKEN",
]);
```

Assert every label is beginner-readable and every mutating selection maps to an existing direct command rather than calling a deployment adapter.

- [ ] **Step 2: Run menu tests and verify RED**

Run: `pnpm vitest run apps/cli/test/menu.test.ts`

Expected: FAIL because `../src/menu.js` does not exist.

- [ ] **Step 3: Implement the menu router**

Create `menu.ts` around one top-level select and only the sub-prompts needed by the chosen action:

```ts
export type MenuInvocation = readonly string[] | null;

export const selectMenuInvocation = async (
  prompt: PromptAdapter,
): Promise<MenuInvocation> => {
  const action = await prompt.select({
    message: "What do you want to do?",
    options: [
      { value: "onboard", label: "Set up Argus", hint: "first-time setup" },
      { value: "status", label: "Check status" },
      { value: "logs", label: "View logs" },
      { value: "config", label: "Manage configuration" },
      { value: "doctor", label: "Run diagnostics" },
      { value: "update", label: "Update Argus" },
      { value: "services", label: "Start, stop, or restart services" },
      { value: "secrets", label: "Manage secrets" },
      { value: "exit", label: "Exit" },
    ],
  });
  switch (action) {
    case "onboard": return ["onboard"];
    case "status": return ["status"];
    case "logs": return selectLogsInvocation(prompt);
    case "config": return selectConfigInvocation(prompt);
    case "doctor": return ["doctor"];
    case "update": return ["update"];
    case "services": return selectServiceInvocation(prompt);
    case "secrets": return selectSecretInvocation(prompt);
    case "exit": return null;
    default: throw new TypeError(`Unknown menu action: ${action}`);
  }
};
```

Define private helpers with exact signatures `selectLogsInvocation(prompt: PromptAdapter): Promise<readonly string[]>`, `selectConfigInvocation(prompt: PromptAdapter): Promise<readonly string[]>`, `selectServiceInvocation(prompt: PromptAdapter): Promise<readonly string[]>`, and `selectSecretInvocation(prompt: PromptAdapter): Promise<readonly string[]>`. The logs helper supports `all`, `argus`, `postgres`, and `searxng`, defaults to `argus`, asks for a tail defaulting to `200`, and throws `DeploymentError("LOG_TAIL_INVALID", ...)` unless the result matches `/^[1-9]\d*$/u`, is a safe integer, and is at most 10,000. It omits the service argv element for `all`. Configuration maps show, validate, apply, and schema to `['config', action]`. Services maps status, start, stop, and restart to `[action]`. Secrets asks for the name and returns `['secrets', 'set', name]`; the existing direct command validates the name and collects the value through its hidden prompt.

- [ ] **Step 4: Write failing root-program behavior tests**

In `program.test.ts`, configure `dependencies.interactive = true`, make `prompt.select` return `status`, parse bare argv, and assert the existing deployment `status()` method ran and produced the same output as direct `argus status`.

In `process.test.ts`, spawn bare non-TTY Argus and assert:

```ts
expect(result.exitCode).toBe(0);
expect(result.stderr).toBe("");
expect(result.stdout).toContain("Usage: argus [options] [command]");
```

Also assert bare `--json` is an `{ contractVersion: 1, ok: true, data: { help } }` envelope and keep the existing bare `config`/`secrets` help cases.

- [ ] **Step 5: Run root tests and verify RED**

Run: `pnpm vitest run apps/cli/test/program.test.ts apps/cli/test/process.test.ts -t 'bare|menu|subcommand help'`

Expected: FAIL because root invocation still raises `CLI_USAGE_ERROR` and does not call the menu router.

- [ ] **Step 6: Delegate the selected menu action to a fresh direct-command program**

Register a root action in `createProgram`:

```ts
program.action(async () => {
  const help = program.helpInformation().trimEnd();
  if (program.optsWithGlobals().json === true || dependencies.interactive !== true) {
    writeSuccess(dependencies.io, program.optsWithGlobals().json === true, { help }, help);
    return;
  }
  const invocation = await selectMenuInvocation(dependencies.prompt);
  if (invocation === null) return;
  await createProgram(dependencies).parseAsync(["node", "argus", ...invocation]);
});
```

Keep the existing namespace-help action behavior. Update the generic prompt cancellation copy from onboarding-specific wording to `Argus was cancelled.` with recovery `Try the command again when ready.`.

- [ ] **Step 7: Run menu and process tests and verify GREEN**

Run: `pnpm vitest run apps/cli/test/menu.test.ts apps/cli/test/program.test.ts apps/cli/test/process.test.ts`

Expected: PASS. Verify no deployment mutation method is invoked by menu routing itself.

- [ ] **Step 8: Commit the interactive entry point**

```bash
git add apps/cli/src/menu.ts apps/cli/src/program.ts apps/cli/src/prompts.ts apps/cli/test/menu.test.ts apps/cli/test/program.test.ts apps/cli/test/process.test.ts
git commit -m "feat: add interactive Argus home menu"
```

---

### Task 3: Wire Readable Logs, Status, Configuration, and Plans

**Files:**
- Modify: `apps/cli/src/program.ts:452-880`
- Modify: `apps/cli/test/program.test.ts`
- Modify: `apps/cli/test/process.test.ts`
- Modify: `apps/cli/test/integrations.test.ts:880-930`

**Interfaces:**
- Consumes: Task 1 renderers and existing deployment/config adapters.
- Produces: human-formatted direct commands plus `logs --raw`; JSON data values remain raw and structured as before.

- [ ] **Step 1: Write failing direct-command UX tests**

Add tests proving:

```ts
// Human logs are compact.
expect(humanLogs.stdout).toContain("INFO  job complete");
expect(humanLogs.stdout).not.toContain('"pid"');
expect(humanLogs.stdout).not.toContain("argus-1  |");

// Raw logs are exact.
expect(rawLogs.stdout).toBe(`${fixtureRawLogs}\n`);

// JSON logs preserve exact raw data.
expect(JSON.parse(jsonLogs.stdout).data.logs).toBe(fixtureRawLogs);

// Human config is YAML while JSON remains an object.
expect(humanConfig.stdout).toContain("storage:\n  adapter: sqlite");
expect(JSON.parse(jsonConfig.stdout).data.storage.adapter).toBe("sqlite");

// Human no-op update hides internal state.
expect(humanUpdate.stdout).toBe("Argus is already up to date (0.1.22).\n");
expect(humanUpdate.stdout).not.toContain("manifestSha256");
expect(humanUpdate.stdout).not.toContain("previousState");
```

Add a status fixture with an empty service health and assert the human output says `unknown`, never a blank value.

- [ ] **Step 2: Run direct-command tests and verify RED**

Run: `pnpm vitest run apps/cli/test/program.test.ts apps/cli/test/process.test.ts apps/cli/test/integrations.test.ts -t 'logs|config|plan|status'`

Expected: FAIL because human handlers still pass raw strings and JSON serialization through unchanged.

- [ ] **Step 3: Wire renderers and the raw-log flag**

Change the logs registration to include:

```ts
.option("--raw", "show exact Docker Compose output")
```

Use this output boundary:

```ts
return {
  data: { service: service ?? "all", logs },
  human: options.raw ? logs : renderHumanLogs(logs),
};
```

Use `renderHumanConfig(shown)` for human config show and `renderHumanPlan(plan)` for every dry-run and pre-confirmation plan. Continue passing the original object as `data` to `execute`.

Update the deployment status adapter so `health` is used only when it is a non-empty string; otherwise use non-empty `state`, then `unknown`. Keep the service object shape unchanged.

- [ ] **Step 4: Run direct-command tests and verify GREEN**

Run: `pnpm vitest run apps/cli/test/human.test.ts apps/cli/test/program.test.ts apps/cli/test/process.test.ts apps/cli/test/integrations.test.ts`

Expected: PASS, including existing JSON contract and redaction cases.

- [ ] **Step 5: Commit the human command wiring**

```bash
git add apps/cli/src/program.ts apps/cli/test/program.test.ts apps/cli/test/process.test.ts apps/cli/test/integrations.test.ts
git commit -m "feat: make CLI output human readable"
```

---

### Task 4: Actionable Human Errors and Beginner Documentation

**Files:**
- Modify: `apps/cli/src/output.ts:70-120`
- Create: `apps/cli/test/output.test.ts`
- Modify: `apps/cli/test/process.test.ts`
- Modify: `apps/web/content/docs/quick-start.mdx`
- Modify: `apps/web/content/docs/operations.mdx`
- Modify: `apps/web/content/docs/configuration.mdx`
- Modify: `apps/web/content/docs/troubleshooting.mdx`

**Interfaces:**
- Consumes: existing `DeploymentErrorJSON` and stable JSON writer.
- Produces: human errors formatted as explanation, recovery, then support code; JSON failure envelopes remain byte-for-byte structurally equivalent.

- [ ] **Step 1: Write failing error-output tests**

Add literal tests around `writeFailure`:

```ts
expect(stderr).toBe(
  "Error: Log tail must be a positive integer no greater than 10000.\n" +
  "Try: Run 'argus logs --tail 200'.\n" +
  "Code: LOG_TAIL_INVALID\n",
);
expect(JSON.parse(jsonStdout)).toEqual({
  contractVersion: 1,
  ok: false,
  error: {
    code: "LOG_TAIL_INVALID",
    message: "Log tail must be a positive integer no greater than 10000.",
    recovery: "Run 'argus logs --tail 200'.",
  },
});
```

Keep tests for confirmation exit code 2, prompt cancellation exit code 130, secret redaction, missing recovery, and generic command failure.

- [ ] **Step 2: Run output tests and verify RED**

Run: `pnpm vitest run apps/cli/test/output.test.ts apps/cli/test/process.test.ts -t 'error|usage'`

Expected: FAIL because human errors currently begin with the internal code.

- [ ] **Step 3: Implement the human-only error layout**

Change only the non-JSON branch of `writeFailure`:

```ts
io.stderr(
  `Error: ${serialized.message}\n${
    serialized.recovery ? `Try: ${serialized.recovery}\n` : ""
  }Code: ${serialized.code}\n`,
);
```

Improve command-specific recovery strings where a concrete safe retry exists, including invalid log tail and invalid service names. Do not change JSON field names or exit-code selection.

- [ ] **Step 4: Update beginner-facing documentation**

In Quick Start, lead with bare `argus` as the recommended human entry point and show direct commands as the advanced/automation path. Document `argus logs` as compact, `argus logs --raw` as exact, human YAML config output, and `--json` as the agent/script contract.

In Operations and Troubleshooting, keep machine verification examples but add the corresponding readable human commands without `--json`. Do not duplicate the full command reference across pages.

- [ ] **Step 5: Run error and documentation tests and verify GREEN**

Run:

```bash
pnpm vitest run apps/cli/test/output.test.ts apps/cli/test/process.test.ts apps/web/test/content.test.ts
pnpm biome check apps/cli/src/output.ts apps/cli/test/output.test.ts apps/cli/test/process.test.ts
```

Expected: PASS with no formatting or content-link failures.

- [ ] **Step 6: Commit errors and docs**

```bash
git add apps/cli/src/output.ts apps/cli/test/output.test.ts apps/cli/test/process.test.ts apps/web/content/docs/quick-start.mdx apps/web/content/docs/operations.mdx apps/web/content/docs/configuration.mdx apps/web/content/docs/troubleshooting.mdx
git commit -m "docs: teach the beginner CLI workflow"
```

---

### Task 5: Full Verification and Installed-Terminal Acceptance

**Files:**
- Modify: `packages/release/test/workflows.test.ts`
- Modify: `.github/workflows/release.yml`
- Verify: all files changed by Tasks 1–4

**Interfaces:**
- Consumes: the complete CLI candidate.
- Produces: automated repository evidence and a recorded real-terminal acceptance result suitable for signed release promotion.

- [ ] **Step 1: Run the complete local quality gate**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Expected: Biome clean, 16/16 typecheck tasks pass, all non-opt-in tests pass, and no whitespace errors.

- [ ] **Step 2: Exercise the real interactive menu through a PTY**

Extend `packages/release/test/workflows.test.ts` with `runCliMenuExpect(selection: "status" | "exit" | "cancel")`, following its existing `expectAvailable` and `spawnSync("expect")` pattern. Spawn `pnpm tsx apps/cli/src/main.ts` with a disposable install root and controlled Docker fixture. Verify the menu visibly contains all nine choices, selecting Status executes status, selecting Exit returns 0, and prompt cancellation returns 130 without a stack trace. Set `ARGUS_REQUIRE_EXPECT_TESTS=1` in the signed release verification workflow so the candidate gate cannot silently skip this PTY contract.

- [ ] **Step 3: Audit every public direct command locally**

Run the safe matrix and inspect the actual terminal text, not only exit codes:

```bash
argus --help
argus config
argus secrets
argus status
argus logs argus --tail 10
argus logs argus --tail 10 --raw
argus doctor
argus config show
argus config validate
argus start --dry-run
argus stop --dry-run
argus restart --dry-run
argus repair argus --dry-run
argus update --dry-run
```

Expected: no generic missing-subcommand errors, blank states, Docker prefixes in compact logs, raw JSON in human output, leaked secrets, or internal signed state in human plans.

- [ ] **Step 4: Request code review before integration**

Use `superpowers:requesting-code-review` to inspect the complete branch against `docs/superpowers/specs/2026-08-26-cli-human-ux-design.md`. Resolve every correctness, safety, JSON compatibility, and UX issue, then rerun Step 1.

- [ ] **Step 5: Commit any acceptance-harness changes**

```bash
git add packages/release/test/workflows.test.ts .github/workflows/release.yml
git commit -m "test: gate the installed CLI experience"
```

- [ ] **Step 6: Integrate, release, and validate the installed VPS**

After user-approved integration, create the next patch release through the existing signed release workflow. Wait for the clean-host installer matrix, promote the verified candidate to stable, update prudhvi-laptop with `argus update --yes`, and repeat the menu/direct-command acceptance matrix against `/usr/local/bin/argus`.

Do not call the release complete until the installed wrapper shows the interactive menu, compact logs, concise plans, normalized status, redacted YAML config, and unchanged JSON command envelopes.
