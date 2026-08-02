import { chmod, lutimes, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildSkillArchive } from "../src/index.js";

const skillRoot = join(import.meta.dirname, "../../../skills/argus-setup");

describe("buildSkillArchive", () => {
  it("builds byte-identical, sorted Argus skill archives across source mtimes", async () => {
    const first = await buildSkillArchive(skillRoot);
    await lutimes(join(skillRoot, "SKILL.md"), new Date(1_000), new Date(2_000));
    const second = await buildSkillArchive(skillRoot);
    const entries = unzipSync(first.bytes);

    expect(first.bytes).toEqual(second.bytes);
    expect(first.sha256).toBe(second.sha256);
    expect(Object.keys(entries)).toEqual([
      "argus-setup/LICENSE.txt",
      "argus-setup/SKILL.md",
      "argus-setup/references/cli-contracts.md",
      "argus-setup/references/recovery.md",
      "argus-setup/references/setup-choices.md",
    ]);
    expect(Object.keys(entries)).not.toContain(".DS_Store");
  });

  it("rejects symlinks in the skill package", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-skill-"));
    await mkdir(join(root, "references"));
    await writeFile(join(root, "SKILL.md"), "---\nname: argus-setup\ndescription: test\n---\n");
    await writeFile(join(root, "LICENSE.txt"), "test\n");
    await chmod(join(root, "SKILL.md"), 0o644);
    await symlink(join(root, "LICENSE.txt"), join(root, "references", "linked.md"));

    await expect(buildSkillArchive(root)).rejects.toThrow(/symlink/u);
  });
});
