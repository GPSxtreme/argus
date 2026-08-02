import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../../..");

const loadSkill = async (relativePath: string) => {
  const source = await readFile(join(repositoryRoot, relativePath, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/u.exec(source);
  if (!match) throw new Error("Skill frontmatter is missing.");
  const frontmatter = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
  return { frontmatter, body: match[2] };
};

describe("Argus Agent Skill", () => {
  it("has the portable setup trigger contract", async () => {
    const skill = await loadSkill("skills/argus-setup");

    expect(skill.frontmatter.name).toBe("argus-setup");
    expect(skill.frontmatter.description).toMatch(/onboard|diagnose|repair/u);
    expect(skill.body).toContain("argus config schema --json");
    expect(skill.body).not.toMatch(/CLOUDFLARE_API_TOKEN=|OPENROUTER_API_KEY=/u);
  });

  it("validates the package through the executable validator", () => {
    const result = spawnSync(
      "pnpm",
      ["tsx", "scripts/skills/validate.ts", "skills/argus-setup"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
