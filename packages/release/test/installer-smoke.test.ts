import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");

const read = (path: string): Promise<string> =>
  readFile(resolve(root, path), "utf8");

describe("clean-host installer smoke contract", () => {
  it("installs the exact signed wrapper twice and verifies onboarding health", async () => {
    const smoke = await read("scripts/e2e/installer-smoke.sh");

    expect(smoke).toMatch(/^#!\/bin\/sh\nset -eu\n/u);
    for (const required of [
      "ARGUS_INSTALLER_URL",
      "ARGUS_MANIFEST_URL",
      "ARGUS_EXPECTED_VERSION",
      "ARGUS_EXPECTED_WRAPPER_SHA256",
    ]) {
      expect(smoke).toContain(required);
    }
    expect(smoke.match(/sh "\$argus_installer"/gu)).toHaveLength(2);
    expect(smoke).toContain("sha256sum");
    expect(smoke).toContain("cmp -s");
    expect(smoke).toContain("argus --version");
    expect(smoke).toContain("argus onboard --from");
    expect(smoke).toContain("https://example.com/");
    expect(smoke).toContain("argus doctor --json");
    expect(smoke).toContain(".ok == true");
    expect(smoke).toContain(".data.healthy == true");
    expect(smoke).toContain(".argusVersion == $version");
    expect(smoke).toContain("refusing non-clean host");
    expect(smoke).toContain(": > \"$argus_artifacts/installer.log\"");
    expect(smoke).not.toMatch(
      /(?:OPENROUTER|TELEGRAM|CLOUDFLARE|ARGUS_RELEASE_ED25519_KEY)=/u,
    );
  });

  it("defines pinned OS and architecture coverage with sanitized artifacts", async () => {
    const source = await read(".github/workflows/installer-smoke.yml");
    const workflow = parse(source) as {
      jobs?: {
        smoke?: {
          strategy?: { matrix?: { include?: unknown[] } };
          steps?: Array<Record<string, unknown>>;
        };
      };
    };
    const smoke = workflow.jobs?.smoke;
    const matrix = smoke?.strategy?.matrix?.include;
    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          os: "ubuntu-22.04",
          arch: "amd64",
          docker: "present",
        }),
        expect.objectContaining({
          os: "ubuntu-24.04",
          arch: "amd64",
          docker: "absent",
        }),
        expect.objectContaining({
          os: "ubuntu-24.04",
          arch: "arm64",
          docker: "present",
        }),
        expect.objectContaining({
          os: "debian-12",
          arch: "amd64",
          docker: "present",
        }),
        expect.objectContaining({
          os: "debian-13",
          arch: "arm64",
          docker: "absent",
        }),
      ]),
    );
    expect(source).toMatch(
      /actions\/checkout@[a-f0-9]{40}\s+#\s+v[0-9]/u,
    );
    expect(source).toMatch(
      /(?:ubuntu|debian)@sha256:[a-f0-9]{64}/u,
    );
    expect(source).toContain("workflow_run:");
    expect(source).toContain('workflows: ["Signed release"]');
    expect(source).toContain("install -m 0600 /dev/null");
    expect(source).toContain("sudo chown");
    expect(source).toContain("if: failure()");
    expect(source).toContain("installer.log");
    expect(source).toContain("wrapper.sha256");
    expect(source).toContain("compose.log");
    expect(source).toContain("doctor.json");
    expect(source).not.toMatch(
      /path:\s*(?:\.?\/)?(?:opt\/argus\/)?(?:secrets\.env|release-private|environment)/u,
    );
    expect(source).not.toContain("ARGUS_RELEASE_ED25519_KEY");
  });
});
