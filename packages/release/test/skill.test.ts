import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../../..");

const loadSkill = async (relativePath: string) => {
  const source = await readFile(join(repositoryRoot, relativePath, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/u.exec(source);
  const frontmatterSource = match?.[1];
  const body = match?.[2];
  if (!frontmatterSource || body === undefined) throw new Error("Skill frontmatter is missing.");
  const frontmatter = Object.fromEntries(
    frontmatterSource.split("\n").map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
  return { frontmatter, body };
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

  it("links the live setup choices and JSON command contracts", async () => {
    const skill = await loadSkill("skills/argus-setup");
    const choices = await readFile(
      join(repositoryRoot, "skills/argus-setup/references/setup-choices.md"),
      "utf8",
    );
    const contracts = await readFile(
      join(repositoryRoot, "skills/argus-setup/references/cli-contracts.md"),
      "utf8",
    );
    const help = spawnSync("pnpm", ["argus", "--help"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(skill.body).toContain("[setup choices](references/setup-choices.md)");
    expect(skill.body).toContain("[CLI contracts](references/cli-contracts.md)");
    expect(choices).toContain("VPS Docker only");
    expect(contracts).toContain('{"contractVersion":1,"ok":true,"data":{}}');
    expect(help.status, help.stderr).toBe(0);
    for (const command of ["onboard", "status", "logs", "doctor", "repair", "config"]) {
      expect(help.stdout).toContain(command);
    }
  });

  it("routes recovery through Argus without destructive infrastructure commands", async () => {
    const recovery = await readFile(
      join(repositoryRoot, "skills/argus-setup/references/recovery.md"),
      "utf8",
    );
    const packageText = [
      await readFile(join(repositoryRoot, "skills/argus-setup/SKILL.md"), "utf8"),
      recovery,
    ].join("\n");

    for (const forbidden of [
      /docker compose down -v/u,
      /docker volume rm/u,
      /rm -rf \/opt\/argus/u,
      /wrangler delete/u,
      /cat \/opt\/argus\/secrets\.env/u,
    ]) {
      expect(packageText).not.toMatch(forbidden);
    }
    expect(packageText).toContain("argus repair");
    expect(packageText).toContain("argus logs");
    expect(packageText).toContain("Stop when the CLI requests new authority");
  });
});
