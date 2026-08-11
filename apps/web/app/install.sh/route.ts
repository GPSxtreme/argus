import { accessSync, constants, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const revalidate = false;

const installerPaths = [
  resolve(process.cwd(), "apps/web/public/releases/stable/install.sh"),
  resolve(process.cwd(), "public/releases/stable/install.sh"),
];

const stableInstallerPath: string = (() => {
  const path = installerPaths.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      accessSync(candidate, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });

  if (path === undefined) {
    throw new Error("Stable installer bundle is unavailable.");
  }

  return path;
})();

export async function GET(): Promise<Response> {
  return new Response(await readFile(stableInstallerPath), {
    headers: {
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      "content-type": "text/x-shellscript; charset=utf-8",
    },
  });
}
