import { accessSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";
import { releasePublicKey } from "./release-public-key";

export const canonicalManifestUrl = "https://argus.gpsxtre.me/releases/stable/manifest.json";

export const installerOptions = {
  manifestUrl: canonicalManifestUrl,
  publicKeyPem: releasePublicKey,
} as const;

const findSkillRoot = (name: string): string => {
  const skillRoots = [
    resolve(process.cwd(), `skills/${name}`),
    resolve(process.cwd(), `../../skills/${name}`),
  ];
  const root = skillRoots.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      accessSync(candidate, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });

  if (root === undefined) {
    throw new Error(`Argus Agent Skill package is unavailable: ${name}.`);
  }

  return root;
};

export const setupSkillRoot = findSkillRoot("argus-setup");
export const researchSkillRoot = findSkillRoot("argus-research");
