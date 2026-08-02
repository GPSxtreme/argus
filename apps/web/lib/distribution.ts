import { accessSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";
import { releasePublicKey } from "./release-public-key";

export const canonicalManifestUrl = "https://argus.gpsxtre.me/releases/stable/manifest.json";

export const installerOptions = {
  manifestUrl: canonicalManifestUrl,
  publicKeyPem: releasePublicKey,
} as const;

const skillRoots = [
  resolve(process.cwd(), "skills/argus-setup"),
  resolve(process.cwd(), "../../skills/argus-setup"),
];

export const skillRoot: string = (() => {
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
    throw new Error("Argus Agent Skill package is unavailable.");
  }

  return root;
})();
