import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderInstaller } from "@argus/release";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { GET as getInstaller } from "../app/install.sh/route";
import { GET as getSkill } from "../app/skill/SKILL.md/route";
import { GET as getArchive } from "../app/skill/argus-skill.zip/route";
import { canonicalManifestUrl, installerOptions, skillRoot } from "../lib/distribution";
import { releasePublicKey } from "../lib/release-public-key";

const expectedManifestUrl = "https://argus.gpsxtre.me/releases/stable/manifest.json";
const expectedPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAX5aHXYBKV+lpb4/k61gstTYs+u5gvFyno7/LCJ1zXRw=
-----END PUBLIC KEY-----`;

describe("distribution routes", () => {
  it("serves the canonical installer renderer with shell and cache headers", async () => {
    const response = await getInstaller();
    const text = await response.text();
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    expect(canonicalManifestUrl).toBe(expectedManifestUrl);
    expect(releasePublicKey).toBe(expectedPublicKey);
    expect(text).toContain(expectedManifestUrl);
    expect(text).toBe(renderInstaller(installerOptions));
    expect(text).toContain(expectedPublicKey);
  });

  it("serves the repository Agent Skill entry file without a duplicate copy", async () => {
    const response = await getSkill();
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toBe(await readFile(path.join(skillRoot, "SKILL.md"), "utf8"));
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
});
