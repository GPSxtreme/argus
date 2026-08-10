import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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

const runFailingVpsOnboard = () => {
  const harness = readFileSync(
    repositoryFile("scripts/e2e/vps-smoke.sh"),
    "utf8",
  );
  const onboardFunction = harness.match(
    /(argus_vps_redact_json\(\) \{[\s\S]*?\n\}\n\nargus_vps_onboard\(\) \{[\s\S]*?\n\})\n\nargus_vps_onboard/u,
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

describe("GitHub workflow toolchain", () => {
  it("installs Expect before running the mandatory workflow harness tests", () => {
    const workflow = readFileSync(
      repositoryFile(".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("sudo apt-get install -y expect");
    expect(workflow).toContain("ARGUS_REQUIRE_EXPECT_TESTS=1 pnpm test");
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
    expect(harness).toContain('argus status --json');
    expect(harness).toContain('changes == []');
    expect(harness).toContain('format=json');
    expect(harness).toContain('controlled-web-page');
    expect(harness).toContain('8788');
    expect(fixture.deployment?.root).toBe('/opt/argus');
    expect(fixture.managed?.searxng).toBe('managed');
    expect(workflow.jobs.vps_smoke?.['runs-on']).toBe('ubuntu-24.04');
    expect(JSON.stringify(workflow)).toContain('ubuntu:24.04');
    expect(JSON.stringify(workflow)).toContain('debian:13');
    expect(JSON.stringify(workflow)).toContain('"ARGUS_VPS_E2E":"1"');
    expect(operations).toContain('/opt/argus');
    expect(operations).toContain('secrets.env');
    expect(operations).toContain('0600');
    expect(operations).toContain('argus update --json --yes');
    expect(readme).toContain('vps-smoke.yml');
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
});
