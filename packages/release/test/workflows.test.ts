import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
      steps?: WorkflowStep[];
    }
  >;
}

const repositoryFile = (path: string): URL =>
  new URL(`../../../${path}`, import.meta.url);

describe("GitHub workflow toolchain", () => {
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
});
