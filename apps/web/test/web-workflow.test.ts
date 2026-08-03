import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/web.yml"), "utf8");
const webPackage = JSON.parse(
  readFileSync(resolve(process.cwd(), "apps/web/package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("web workflow", () => {
  it("uses the repository-pinned toolchain and runs every web test", () => {
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("uses: pnpm/action-setup@ff378ebe6b225b0680b81c1ad4498ae0d1d3a5e3 # v6.0.10");
    expect(workflow).not.toMatch(/pnpm\/action-setup[\s\S]*?\n\s+with:\n\s+version:/u);
    expect(workflow).toContain("node-version: 24.16.0");
    const generate = workflow.indexOf("pnpm --filter @argus/web generate");
    const tests = workflow.indexOf("pnpm vitest run apps/web/test");
    expect(generate).toBeGreaterThan(-1);
    expect(generate).toBeLessThan(tests);
    expect(workflow).toContain("pnpm vitest run apps/web/test");
    expect(webPackage.scripts?.postinstall).toBe("fumadocs-mdx");
    expect(webPackage.scripts?.generate).toBe("fumadocs-mdx");
  });
});
