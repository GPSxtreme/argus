import { readFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { GET as getInstaller } from "../app/install.sh/route";
import { GET as getSkill } from "../app/skill/SKILL.md/route";
import { GET as getArchive } from "../app/skill/argus-skill.zip/route";
import { GET as getResearchArchive } from "../app/skill/argus-research.zip/route";
import { GET as getResearchSkill } from "../app/skill/research/SKILL.md/route";
import { researchSkillRoot, setupSkillRoot } from "../lib/distribution";

const stableInstaller = path.resolve(
  process.cwd(),
  "apps/web/public/releases/stable/install.sh",
);

describe("distribution routes", () => {
  it("serves the pinned stable installer with shell and cache headers", async () => {
    const response = await getInstaller();

    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      await readFile(stableInstaller),
    );
  });

  it("serves the repository Agent Skill entry file without a duplicate copy", async () => {
    const response = await getSkill();
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toBe(await readFile(path.join(setupSkillRoot, "SKILL.md"), "utf8"));
  });

  it("serves a valid deterministic Agent Skill ZIP attachment", async () => {
    const response = await getArchive();
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="argus-skill.zip"');
    expect(Object.keys(entries).sort()).toEqual([
      "argus-setup/LICENSE.txt",
      "argus-setup/SKILL.md",
      "argus-setup/references/cli-contracts.md",
      "argus-setup/references/recovery.md",
      "argus-setup/references/setup-choices.md",
    ]);
  });

  it("serves the research skill entry and deterministic ZIP", async () => {
    const sourceResponse = await getResearchSkill();
    expect(await sourceResponse.text()).toBe(
      await readFile(path.join(researchSkillRoot, "SKILL.md"), "utf8"),
    );

    const archiveResponse = await getResearchArchive();
    const entries = unzipSync(new Uint8Array(await archiveResponse.arrayBuffer()));
    expect(archiveResponse.headers.get("content-disposition")).toBe(
      'attachment; filename="argus-research.zip"',
    );
    expect(Object.keys(entries).sort()).toEqual([
      "argus-research/LICENSE.txt",
      "argus-research/SKILL.md",
      "argus-research/references/api.md",
      "argus-research/references/provenance.md",
      "argus-research/references/traversal.md",
    ]);
  });
});
