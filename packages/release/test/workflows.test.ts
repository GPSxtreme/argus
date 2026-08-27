import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      outputs?: Record<string, string>;
      "runs-on"?: string;
      steps?: WorkflowStep[];
    }
  >;
}

const repositoryFile = (path: string): URL =>
  new URL(`../../../${path}`, import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;
const expectAvailable =
  spawnSync("sh", ["-c", "command -v expect >/dev/null 2>&1"]).status === 0;

if (process.env.ARGUS_REQUIRE_EXPECT_TESTS === "1" && !expectAvailable) {
  throw new Error("ARGUS_REQUIRE_EXPECT_TESTS=1 requires the expect executable");
}

const runVpsOnboardExpect = ({
  noPrompt = false,
  expectTimeout = 900,
  processTimeout = 5_000,
}: {
  noPrompt?: boolean;
  expectTimeout?: number;
  processTimeout?: number;
}) => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const expectProgram = harness
    .match(/expect <<'ARGUS_VPS_EXPECT'\n([\s\S]*?)\nARGUS_VPS_EXPECT/u)?.[1]
    ?.replace("set timeout 900", `set timeout ${expectTimeout}`);
  expect(expectProgram).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), "argus-vps-expect-"));
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "onboard.log");
    const argus = join(bin, "argus");
    const docker = join(bin, "docker");
    mkdirSync(bin);
    writeFileSync(
      argus,
      `#!/bin/sh
if [ "\${ARGUS_VPS_TEST_NO_PROMPT:-0}" = 1 ]; then
  sleep 10
  exit 0
fi
exec pnpm tsx ${shellQuote(join(repositoryRoot, "apps/cli/src/main.ts"))} onboard --from ${shellQuote(join(repositoryRoot, "scripts/e2e/fixtures/onboard-web.yaml"))} --yes --json
`,
      { mode: 0o755 },
    );
    writeFileSync(docker, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = spawnSync("expect", [], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        ARGUS_INSTALL_ROOT: directory,
        ARGUS_VPS_OUTPUT: output,
        ARGUS_VPS_JSON: `${output}.json`,
        ARGUS_VPS_TOKEN: "argus-vps-test-token",
        ARGUS_VPS_TEST_NO_PROMPT: noPrompt ? "1" : "0",
      },
      input: expectProgram,
      timeout: processTimeout,
    });
    return {
      result,
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runCliMenuExpect = (
  selection: "status" | "exit" | "cancel" | "eof",
) => {
  const directory = mkdtempSync(join(tmpdir(), "argus-cli-menu-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const digest = "a".repeat(64);
    writeFileSync(
      join(directory, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        argusVersion: "0.1.0-test",
        composeProject: "argus",
        configHash: "fixture",
        services: {
          argus: {
            image: `ghcr.io/gpsxtreme/argus@sha256:${digest}`,
            healthy: true,
          },
        },
        compose: {
          version: "0.1.0-test",
          apiPort: 8788,
          storage: "sqlite",
          searxng: false,
          images: {
            argus: `ghcr.io/gpsxtreme/argus@sha256:${digest}`,
            postgres: `docker.io/library/postgres@sha256:${digest}`,
            searxng: `docker.io/searxng/searxng@sha256:${digest}`,
          },
        },
        updatedAt: "2026-08-26T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(bin, "docker"),
      "#!/bin/sh\nprintf '%s\\n' '[{\"Service\":\"argus\",\"State\":\"running\",\"Health\":\"healthy\"}]'\n",
      { mode: 0o755 },
    );

    const navigation =
      selection === "status"
        ? 'after 100\nsend "\\r"'
        : selection === "exit"
          ? 'for {set i 0} {$i < 7} {incr i} { send -- "\\033\\[B"; after 75 }\nsend "\\r"'
          : selection === "cancel"
            ? 'after 100\nsend -- "\\003"'
            : 'after 100\nsend -- "\\004"';
    const expectedExit = selection === "cancel" || selection === "eof" ? 130 : 0;
    const expectProgram = `
set timeout 20
spawn -noecho sh -c {stty rows 40 columns 120; exec pnpm tsx apps/cli/src/main.ts}
expect "What do you want to do?"
${navigation}
expect eof
set status [wait]
set code [lindex $status 3]
if {$code != ${expectedExit}} { exit 1 }
exit 0
`;
    return spawnSync("expect", [], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ARGUS_INSTALL_ROOT: directory,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      input: expectProgram,
      timeout: 25_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runFailingVpsOnboard = () => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const onboardFunction = harness.match(
    /(argus_vps_redact_json\(\) \{[\s\S]*?\n\}\n\nargus_vps_onboard\(\) \{[\s\S]*?\n\})\n\nargus_vps_assert_idempotent_onboard/u,
  )?.[1];
  expect(onboardFunction).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), "argus-vps-failure-"));
  const token = "argus_vps_test_secret";
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "onboard.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "argus"),
      `#!/bin/sh
if [ "\${1:-}" = doctor ]; then
  printf '%s\\n' '{"contractVersion":1,"ok":false,"error":{"code":"DOCTOR_FAILED","message":"fixture doctor failed with ${token}"},"data":{"healthy":false,"checks":[{"component":"host","status":"unhealthy","code":"INSUFFICIENT_DISK","message":"fixture disk check"}]}}'
  exit 1
fi
printf '%s\\n' '{"contractVersion":1,"ok":false,"error":{"code":"APPLY_FAILED","message":"fixture failed with ${token}","details":{"apiToken":"${token}"}}}'
exit 4
`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      "sh",
      [
        "-c",
        `set -eu
${onboardFunction}
argus_vps_token=${shellQuote(token)}
argus_vps_onboard ${shellQuote(output)}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      },
    );
    return { result, token };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runInvalidVpsOnboardContract = () => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const onboardFunctions = harness.match(
    /(argus_vps_redact_json\(\) \{[\s\S]*?\n\}\n\nargus_vps_update\(\) \{[\s\S]*?\n\}\n\nargus_vps_onboard\(\) \{[\s\S]*?\n\})\n\nargus_vps_assert_idempotent_onboard/u,
  )?.[1];
  expect(onboardFunctions).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), "argus-vps-invalid-onboard-"));
  const token = "argus_vps_invalid_contract_secret";
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "onboard.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "argus"),
      `#!/bin/sh
printf '%s\n' '{"contractVersion":1,"ok":false,"error":{"code":"INVALID_FIXTURE","message":"fixture failed with ${token}"}}'
`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      "sh",
      [
        "-c",
        `set -eu
${onboardFunctions}
argus_vps_token=${shellQuote(token)}
argus_vps_onboard ${shellQuote(output)}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      },
    );
    return { result, token };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runVpsOnboardIdempotenceAssertion = () => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const assertionFunction = harness.match(
    /(argus_vps_assert_idempotent_onboard\(\) \{[\s\S]*?\n\})\n\nargus_vps_phase=/u,
  )?.[1];
  expect(assertionFunction).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), "argus-vps-idempotence-"));
  try {
    const output = join(directory, "onboard.json");
    writeFileSync(
      output,
      JSON.stringify({
        contractVersion: 1,
        ok: true,
        data: {
          plan: {
            release: { manifest: { version: "0.1.23" } },
            plan: { deployment: { changes: [] } },
          },
          result: { deployment: { changes: [] } },
        },
      }),
    );

    return spawnSync(
      "sh",
      [
        "-c",
        `set -eu
argus_vps_redact_json() { cat "$1"; }
${assertionFunction}
argus_vps_assert_idempotent_onboard ${shellQuote(output)}
`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runFailingVpsUpdate = () => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const updateFunctions = harness.match(
    /(argus_vps_redact_json\(\) \{[\s\S]*?\n\}\n\nargus_vps_update\(\) \{[\s\S]*?\n\})\n\nargus_vps_onboard/u,
  )?.[1];
  expect(updateFunctions).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), "argus-vps-update-failure-"));
  const token = "argus_vps_update_test_secret";
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "update.json");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "argus"),
      `#!/bin/sh
printf '%s\n' '{"contractVersion":1,"ok":false,"error":{"code":"UPDATE_FAILED","message":"fixture failed with ${token}","details":{"apiToken":"${token}"}}}'
exit 4
`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      "sh",
      [
        "-c",
        `set -eu
${updateFunctions}
argus_vps_token=${shellQuote(token)}
argus_vps_update ${shellQuote(output)}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      },
    );
    return { result, token };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runInvalidVpsUpdateContract = () => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const updateFunctions = harness.match(
    /(argus_vps_redact_json\(\) \{[\s\S]*?\n\}\n\nargus_vps_update\(\) \{[\s\S]*?\n\})\n\nargus_vps_onboard/u,
  )?.[1];
  expect(updateFunctions).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), "argus-vps-invalid-update-"));
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "update.json");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "argus"),
      "#!/bin/sh\nprintf '%s\\n' '{\"contractVersion\":1,\"ok\":true,\"data\":{\"version\":\"0.1.22\",\"health\":{\"healthy\":true}}}'\n",
      { mode: 0o755 },
    );

    return spawnSync(
      "sh",
      [
        "-c",
        `set -eu
${updateFunctions}
argus_vps_token=argus_vps_test_secret
ARGUS_UPDATE_EXPECTED_VERSION=0.1.23
argus_vps_update ${shellQuote(output)}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runAnsiPrefixedSuccessfulVpsOnboard = () => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const onboardFunctions = harness.match(
    /(argus_vps_redact_json\(\) \{[\s\S]*?\n\}\n\nargus_vps_onboard\(\) \{[\s\S]*?\n\})\n\nargus_vps_assert_idempotent_onboard/u,
  )?.[1];
  expect(onboardFunctions).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), "argus-vps-success-"));
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "onboard.log");
    const response = JSON.stringify({
      contractVersion: 1,
      ok: true,
      data: {
        plan: {
          release: "0.1.23",
          plan: {
            deployment: { changes: [] },
            diagnostics: "x".repeat(8_192),
          },
        },
      },
    });
    mkdirSync(bin);
    writeFileSync(
      join(bin, "argus"),
      `#!/bin/sh
stty -echo
printf 'Argus API token'
IFS= read -r ignored
stty echo
printf '\\r\\n\\033[?25h%s\\n' ${shellQuote(response)}
`,
      { mode: 0o755 },
    );

    return spawnSync(
      "sh",
      [
        "-c",
        `set -eu
${onboardFunctions}
argus_vps_token=argus_vps_test_secret
argus_vps_onboard ${shellQuote(output)}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("GitHub workflow toolchain", () => {
  it("installs Expect before running the mandatory workflow harness tests", () => {
    const workflow = readFileSync(
      repositoryFile(".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("sudo apt-get install -y expect");
    expect(workflow).toContain("ARGUS_REQUIRE_EXPECT_TESTS=1 pnpm test");

    const releaseWorkflow = readFileSync(
      repositoryFile(".github/workflows/release.yml"),
      "utf8",
    );
    expect(releaseWorkflow).toContain("sudo apt-get install -y expect");
    expect(releaseWorkflow).toContain("ARGUS_REQUIRE_EXPECT_TESTS=1 pnpm test");
  });

  it.runIf(expectAvailable)(
    "executes status from the real terminal menu",
    () => {
      const result = runCliMenuExpect("status");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Set up Argus");
      expect(result.stdout).toContain("Manage secrets");
      expect(result.stdout).toContain("Argus: running");
    },
    30_000,
  );

  it.runIf(expectAvailable)(
    "exits cleanly from the real terminal menu",
    () => {
      const result = runCliMenuExpect("exit");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Goodbye.");
    },
    30_000,
  );

  it.runIf(expectAvailable)(
    "cancels the real terminal menu without a stack trace",
    () => {
      const result = runCliMenuExpect("cancel");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Argus was cancelled.");
      expect(result.stdout).not.toContain("CliExitError");
    },
    30_000,
  );

  it.runIf(expectAvailable)(
    "treats terminal EOF as a clean cancellation",
    () => {
      const result = runCliMenuExpect("eof");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Argus was cancelled.");
      expect(result.stdout).not.toContain("unsettled top-level await");
    },
    30_000,
  );

  it("enforces complete stable bundle changes on both pull requests and pushes", () => {
    const workflow = parse(
      readFileSync(repositoryFile(".github/workflows/ci.yml"), "utf8"),
    ) as Workflow;
    const steps = workflow.jobs.verify?.steps ?? [];
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const policy = steps.find(
      (step) => step.name === "Enforce stable release bundle change set",
    );

    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(policy).toMatchObject({
      if: "github.event_name == 'pull_request' || github.event.deleted == false",
      env: {
        BASE_SHA:
          "$" + "{{ github.event.pull_request.base.sha || github.event.before }}",
      },
    });
    expect(policy?.run).toContain(
      "node scripts/ci/assert-stable-bundle-change.mjs",
    );
  });

  it("uses the integrity-pinned packageManager as the only pnpm setup version source", () => {
    const rootManifest = JSON.parse(
      readFileSync(repositoryFile("package.json"), "utf8"),
    ) as { packageManager?: string };
    const packageManager = rootManifest.packageManager;
    expect(packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]+$/u);
    const pnpmVersion = packageManager?.match(/^pnpm@([^+]+)/u)?.[1];
    expect(pnpmVersion).toBeDefined();

    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/push.yaml",
      ".github/workflows/release.yml",
    ]) {
      const workflow = parse(
        readFileSync(repositoryFile(path), "utf8"),
      ) as Workflow;
      const setupSteps = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.uses?.startsWith("pnpm/action-setup@"));

      expect(setupSteps, path).toHaveLength(1);
      expect(setupSteps[0]?.with?.version, path).toBeUndefined();
    }

    const release = parse(
      readFileSync(repositoryFile(".github/workflows/release.yml"), "utf8"),
    ) as Workflow;
    expect(release.jobs.release?.env?.PNPM_VERSION).toBe(pnpmVersion);
    const installStep = release.jobs.release?.steps?.find(
      (step) => step.name === "Install dependencies",
    );
    expect(installStep?.run).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: The workflow must verify the literal shell variable.
      'test "$(pnpm --version)" = "${PNPM_VERSION}"',
    );
  });

  it("makes the pinned FxEmbed build reproducible before checking its output", () => {
    const workflow = parse(
      readFileSync(repositoryFile(".github/workflows/release.yml"), "utf8"),
    ) as Workflow;
    const release = workflow.jobs.release;
    const buildStep = release?.steps?.find(
      (step) => step.name === "Build pinned FxEmbed worker",
    );
    const run = buildStep?.run ?? "";
    const patch = readFileSync(
      repositoryFile("scripts/release/fxembed-reproducible.patch"),
      "utf8",
    );
    const provenance = JSON.parse(
      readFileSync(
        repositoryFile("scripts/release/fxembed-provenance.json"),
        "utf8",
      ),
    ) as {
      reproducibilityPatch?: string;
      reproducibilityPatchSha256?: string;
      sourceDateEpoch?: number;
    };
    const patchSha256 = createHash("sha256").update(patch).digest("hex");
    const lockCheck = run.indexOf(
      '"$FXEMBED_LOCK_SHA256" dist/fxembed-source/package-lock.json',
    );
    const patchCheck = run.indexOf(
      'git -C dist/fxembed-source apply --check "$GITHUB_WORKSPACE/$FXEMBED_PATCH"',
    );
    const outputCheck = run.indexOf(
      '"$FXEMBED_OUTPUT_SHA256" dist/release/fxembed.js',
    );

    expect(release?.env?.FXEMBED_PATCH_SHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(release?.env?.FXEMBED_PATCH_SHA256).toBe(patchSha256);
    expect(run).toContain(
      'printf \'%s  %s\\n\' "$FXEMBED_PATCH_SHA256" "$FXEMBED_PATCH" | sha256sum --check --strict',
    );
    expect(run).toContain(
      'git -C dist/fxembed-source apply --check "$GITHUB_WORKSPACE/$FXEMBED_PATCH"',
    );
    expect(run).toContain(
      'git -C dist/fxembed-source apply "$GITHUB_WORKSPACE/$FXEMBED_PATCH"',
    );
    expect(run).toContain(
      'SOURCE_DATE_EPOCH="$(git -C dist/fxembed-source show -s --format=%ct "$FXEMBED_REVISION")"',
    );
    expect(run).toContain('export SOURCE_DATE_EPOCH');
    expect(lockCheck).toBeGreaterThan(-1);
    expect(patchCheck).toBeGreaterThan(lockCheck);
    expect(outputCheck).toBeGreaterThan(patchCheck);
    expect(patch).toContain("process.env.SOURCE_DATE_EPOCH");
    expect(patch).toContain("SOURCE_DATE_EPOCH must be an unsigned integer");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is literal patch content.
    expect(patch).not.toContain("+const releaseName = `${workerName}-${gitBranch}-${gitCommit}-${new Date()");
    expect(provenance.reproducibilityPatch).toBe(
      "scripts/release/fxembed-reproducible.patch",
    );
    expect(provenance.reproducibilityPatchSha256).toBe(
      release?.env?.FXEMBED_PATCH_SHA256,
    );
    expect(provenance.sourceDateEpoch).toBe(1_785_545_724);
  });

  it("pins upstream images and refuses to overwrite an existing release", () => {
    const workflow = parse(
      readFileSync(repositoryFile(".github/workflows/release.yml"), "utf8"),
    ) as Workflow;
    const release = workflow.jobs.release;
    const postgres = release?.env?.POSTGRES_IMAGE;
    const searxng = release?.env?.SEARXNG_IMAGE;
    const steps = release?.steps ?? [];
    const reservation = steps.find(
      (step) => step.name === "Reserve immutable GitHub Release",
    );
    const publish = steps.find(
      (step) => step.name === "Publish immutable GitHub Release",
    );

    expect(postgres).toMatch(
      /^docker\.io\/library\/postgres@sha256:[a-f0-9]{64}$/u,
    );
    expect(searxng).toMatch(
      /^docker\.io\/searxng\/searxng@sha256:[a-f0-9]{64}$/u,
    );
    expect(steps.some((step) => step.name === "Resolve upstream image indexes")).toBe(
      false,
    );
    expect(reservation?.run).toContain(
      'gh release view "$GITHUB_REF_NAME"',
    );
    expect(reservation?.run).toContain("exit 1");
    expect(publish?.with?.overwrite_files).toBe(false);
  });

  it("tests SQLite backup and restore against the built digest-pinned application image", () => {
    const workflow = parse(
      readFileSync(repositoryFile(".github/workflows/release.yml"), "utf8"),
    ) as Workflow;
    const steps = workflow.jobs.release?.steps ?? [];
    const appBuild = steps.findIndex(
      (step) => step.name === "Build and push application image",
    );
    const volumeTest = steps.findIndex(
      (step) => step.name === "Verify SQLite named-volume backup and restore",
    );
    const step = steps[volumeTest];

    expect(volumeTest).toBeGreaterThan(appBuild);
    expect(step?.env).toEqual({
      ARGUS_SQLITE_VOLUME_TEST: "1",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is a literal workflow expression.
      ARGUS_APP_IMAGE: "${{ env.APP_IMAGE }}@${{ steps.app.outputs.digest }}",
    });
    expect(step?.run).toContain('docker pull "$ARGUS_APP_IMAGE"');
    expect(step?.run).toContain(
      "pnpm vitest run packages/deployment/test/sqlite-volume.live.test.ts",
    );
  });

  it("exports every verified release input needed for one stable-bundle promotion", () => {
    const workflow = parse(
      readFileSync(repositoryFile(".github/workflows/release.yml"), "utf8"),
    ) as Workflow;
    const steps = workflow.jobs.release?.steps ?? [];
    const verificationIndex = steps.findIndex(
      (step) => step.name === "Build and verify signed assets",
    );
    const promotionArtifactIndex = steps.findIndex(
      (step) => step.name === "Upload verified stable-promotion input",
    );
    const publishIndex = steps.findIndex(
      (step) => step.name === "Publish immutable GitHub Release",
    );
    const promotionArtifact = steps[promotionArtifactIndex];

    expect(promotionArtifact?.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(promotionArtifact?.with).toEqual({
      name: "stable-promotion-input",
      path: [
        "dist/release/manifest.json",
        "dist/release/manifest.sig",
        "dist/release/release-public.pem",
        "dist/release/argus",
        "dist/release/install.sh",
        "dist/release/fxembed.js",
        "dist/release/FXEMBED-LICENSE.md",
        "dist/release/fxembed-provenance.json",
      ].join("\n"),
      "if-no-files-found": "error",
    });
    expect(verificationIndex).toBeGreaterThanOrEqual(0);
    expect(promotionArtifactIndex).toBeGreaterThan(verificationIndex);
    expect(publishIndex).toBeGreaterThan(promotionArtifactIndex);
  });

  it("defines a clean-VPS smoke using an immutable signed candidate", () => {
    const harness = readFileSync(
      repositoryFile("scripts/e2e/vps-smoke.sh"),
      "utf8",
    );
    const fixture = parse(
      readFileSync(
        repositoryFile("scripts/e2e/fixtures/onboard-web.yaml"),
        "utf8",
      ),
    ) as { deployment?: { root?: unknown }; managed?: { searxng?: unknown } };
    const workflow = parse(
      readFileSync(repositoryFile(".github/workflows/vps-smoke.yml"), "utf8"),
    ) as Workflow;
    const operations = readFileSync(repositoryFile("docs/operations.md"), "utf8");
    const readme = readFileSync(repositoryFile("README.md"), "utf8");

    expect(harness).toContain('ARGUS_VPS_E2E=1');
    expect(harness).toContain('ARGUS_INSTALLER_URL');
    expect(harness).toContain('ARGUS_MANIFEST_URL');
    expect(harness.match(/argus_vps_onboard "/g)?.length).toBe(2);
    expect(harness).toContain(
      'argus onboard --from /opt/argus/.vps-smoke-onboard.yaml --yes --json',
    );
    expect(harness).toContain('argus doctor --json');
    expect(harness).toContain('.data.healthy == true');
    expect(harness).toContain(
      'argus VPS smoke: failed during $argus_vps_phase (exit $argus_vps_status)',
    );
    expect(harness).not.toContain('--network argus_argus-private');
    expect(harness).toContain('argus status --json');
    expect(harness).toContain('argus_vps_status_attempt=0');
    expect(harness).toContain(
      '[ "$argus_vps_status_attempt" -ge 30 ]',
    );
    expect(harness).toContain('JSON status did not become healthy');
    expect(harness).toContain('spawn sh -c {stty rows 40 columns 120; exec argus}');
    expect(harness).toContain('expect "Argus: running"');
    expect(harness).toContain('argus --help >');
    expect(harness).toContain('argus config >');
    expect(harness).toContain('argus secrets >');
    expect(harness).toContain('argus logs argus --tail 10 >');
    expect(harness).toContain('argus logs argus --tail 10 --raw >');
    expect(harness).toContain('compact logs were not human-readable');
    expect(harness).toContain('raw logs did not preserve Docker prefixes');
    expect(harness).toContain('raw logs did not preserve structured service output');
    expect(harness).toContain('argus doctor >');
    expect(harness).toContain('Argus diagnostics: healthy');
    expect(harness).toContain('argus config show >');
    expect(harness).toContain('argus config validate >');
    expect(harness).toContain('argus start --dry-run >');
    expect(harness).toContain('argus stop --dry-run >');
    expect(harness).toContain('argus restart --dry-run >');
    expect(harness).toContain('argus repair argus --dry-run >');
    expect(harness).toContain('argus update --dry-run >');
    expect(harness).toContain('a human dry-run plan was blank');
    expect(harness).toContain('a human dry-run plan exposed internal state');
    expect(harness.indexOf('argus_vps_menu_output=')).toBeGreaterThan(
      harness.indexOf('argus_vps_update "$argus_vps_work/update.json"'),
    );
    expect(harness).toContain('changes == []');
    expect(harness).toContain('controlled-web-page');
    expect(harness).toContain('8788');
    expect(fixture.deployment?.root).toBe('/opt/argus');
    expect(fixture.managed?.searxng).toBe('managed');
    expect(workflow.jobs.vps_smoke?.['runs-on']).toBe('ubuntu-24.04');
    expect(workflow.jobs.candidate?.outputs).toMatchObject({
      acceptance_mode: '$' + '{{ steps.release.outputs.acceptance_mode }}',
      installer_sha256: '$' + '{{ steps.release.outputs.installer_sha256 }}',
      update_manifest_asset_url:
        '$' + '{{ steps.release.outputs.update_manifest_asset_url }}',
      update_version: '$' + '{{ steps.release.outputs.update_version }}',
      update_manifest_sha256:
        '$' + '{{ steps.release.outputs.update_manifest_sha256 }}',
    });
    expect(
      workflow.jobs.vps_smoke?.steps?.find(
        (step) => step.name === "Verify clean VPS onboarding and operation",
      )?.env,
    ).toMatchObject({
      ARGUS_EXPECTED_INSTALLER_SHA256:
        '$' + '{{ needs.candidate.outputs.installer_sha256 }}',
      ARGUS_VPS_SMOKE_MODE:
        '$' + '{{ needs.candidate.outputs.acceptance_mode }}',
      ARGUS_UPDATE_MANIFEST_ASSET_URL:
        '$' + '{{ needs.candidate.outputs.update_manifest_asset_url }}',
      ARGUS_UPDATE_EXPECTED_VERSION:
        '$' + '{{ needs.candidate.outputs.update_version }}',
      ARGUS_UPDATE_MANIFEST_SHA256:
        '$' + '{{ needs.candidate.outputs.update_manifest_sha256 }}',
    });
    expect(JSON.stringify(workflow)).toContain('ubuntu:24.04');
    expect(JSON.stringify(workflow)).toContain('debian:13');
    expect(JSON.stringify(workflow)).toContain('"ARGUS_VPS_E2E":"1"');
    expect(JSON.stringify(workflow)).toContain(
      "release-acceptance-policy.ts",
    );
    expect(JSON.stringify(workflow)).toContain("manifest.sig");
    expect(JSON.stringify(workflow)).toContain("release-public.pem");
    expect(JSON.stringify(workflow)).toContain("verify-release");
    expect(harness).toContain("ARGUS_VPS_SMOKE_MODE");
    expect(harness).toContain("ARGUS_EXPECTED_INSTALLER_SHA256");
    expect(harness).toContain("scripts/e2e/verify-sha256.sh");
    expect(operations).toContain('/opt/argus');
    expect(operations).toContain('secrets.env');
    expect(operations).toContain('0600');
    expect(operations).toContain('argus update --json --yes');
    expect(readme).toContain('vps-smoke.yml');
  });

  it("validates the real persisted SQLite volume snapshot after a VPS update", () => {
    const harness = readFileSync(
      repositoryFile("scripts/e2e/vps-smoke.sh"),
      "utf8",
    );

    expect(harness).toContain(".backup.sqliteSnapshot.quickCheck == \"ok\"");
    expect(harness).toContain(".backup.sqliteSnapshot.volume.project == \"argus\"");
    expect(harness).toContain(
      ".backup.sqliteSnapshot.volume.logicalName == \"argus-data\"",
    );
    expect(harness).toContain(
      ".backup.sqliteSnapshot.volume.destination == \"/app/data\"",
    );
    expect(harness).toContain("realpath -e");
    expect(harness).toContain("sha256sum");
    expect(harness).toContain("stat -c %s");
    expect(harness).not.toContain(".backup.sqliteFiles");
  });

  it.skipIf(!expectAvailable)(
    "drives the real onboarding secret prompt from a headless PTY",
    () => {
      const { result, output } = runVpsOnboardExpect({});

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toContain('"PREFLIGHT_FAILED"');
    },
  );

  it.skipIf(!expectAvailable)(
    "returns the bounded timeout status when onboarding never prompts",
    () => {
      const { result } = runVpsOnboardExpect({
        noPrompt: true,
        expectTimeout: 1,
        processTimeout: 4_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(124);
    },
  );

  it.skipIf(!expectAvailable)(
    "reports a structured onboarding failure without exposing secrets",
    () => {
      const { result, token } = runFailingVpsOnboard();

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(4);
      expect(result.stderr).toContain("onboard failed with exit code 4");
      expect(result.stderr).toContain('"code": "APPLY_FAILED"');
      expect(result.stderr).toContain("onboard failure diagnostics");
      expect(result.stderr).toContain('"code": "INSUFFICIENT_DISK"');
      expect(result.stderr).toContain("[REDACTED]");
      expect(result.stderr).not.toContain(token);
    },
  );

  it("reports a structured update failure without exposing secrets", () => {
    const { result, token } = runFailingVpsUpdate();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("update failed with exit code 4");
    expect(result.stderr).toContain('"code": "UPDATE_FAILED"');
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(token);
  });

  it("reports an invalid successful update contract", () => {
    const result = runInvalidVpsUpdateContract();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("update returned an invalid contract");
    expect(result.stderr).toContain('"version": "0.1.22"');
  });

  it("reports an invalid onboarding contract without exposing secrets", () => {
    const { result, token } = runInvalidVpsOnboardContract();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("onboard returned an invalid contract");
    expect(result.stderr).toContain('"code": "INVALID_FIXTURE"');
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(token);
  });

  it("accepts the production-shaped idempotent onboarding plan", () => {
    const result = runVpsOnboardIdempotenceAssertion();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.skipIf(!expectAvailable)(
    "extracts successful JSON prefixed by terminal cursor state",
    () => {
      const result = runAnsiPrefixedSuccessfulVpsOnboard();

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    },
  );
});
