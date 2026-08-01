import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [modulesRoot, outputRoot, imageKind] = process.argv.slice(2);
if (!modulesRoot || !outputRoot || !["app", "cli"].includes(imageKind)) {
  throw new Error(
    "usage: generate-third-party-notices.mjs <node_modules> <output> <app|cli>",
  );
}

const packageDirectories = [];
const walk = async (directory) => {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(join(path, "package.json"))) packageDirectories.push(path);
      await walk(path);
    }
  }
};
await walk(modulesRoot);

const packages = new Map();
for (const directory of packageDirectories) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (!manifest.name || !manifest.version) continue;
  const key = `${manifest.name}@${manifest.version}`;
  if (!packages.has(key)) packages.set(key, { directory, manifest });
}

mkdirSync(join(outputRoot, "licenses", "npm"), { recursive: true });
const lines = [
  "# Argus third-party notices",
  "",
  "Generated deterministically from the production dependency closure.",
  "",
  "## npm packages",
  "",
];

for (const [key, { directory, manifest }] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const repository =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository?.url;
  const project = manifest.homepage ?? repository ?? `https://www.npmjs.com/package/${manifest.name}`;
  const licenseName = String(manifest.license ?? "UNKNOWN");
  const safeName = key.replaceAll("/", "__").replaceAll("@", "_");
  const candidates = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];
  const license = candidates.map((name) => join(directory, name)).find(existsSync);
  const licensePath = license ? `licenses/npm/${safeName}-${basename(license)}` : undefined;
  if (license && licensePath) cpSync(license, join(outputRoot, licensePath));
  lines.push(
    `- ${key} — ${licenseName} — ${project}${licensePath ? ` — ${licensePath}` : ""}`,
  );
}

lines.push("", "## Redistributed tools", "");
if (imageKind === "app") {
  lines.push(
    "- Tini 0.19.0-1+b3 — MIT — https://github.com/krallin/tini — licenses/tini-copyright",
  );
} else {
  lines.push(
    "- Docker CLI 29.7.1 — Apache-2.0 — https://github.com/docker/cli — licenses/docker-cli-LICENSE",
    "- Docker Compose 2.39.1 — Apache-2.0 — https://github.com/docker/compose — licenses/docker-compose-LICENSE",
  );
}
lines.push("");
writeFileSync(join(outputRoot, "THIRD_PARTY_NOTICES.md"), lines.join("\n"));
