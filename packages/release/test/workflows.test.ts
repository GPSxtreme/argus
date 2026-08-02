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
});
