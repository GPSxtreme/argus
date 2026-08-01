import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const [modulesRoot, outputRoot, imageKind, versionsJson] = process.argv.slice(2);
if (!modulesRoot || !outputRoot || !["app", "cli"].includes(imageKind)) {
  throw new Error(
    "usage: generate-third-party-notices.mjs <node_modules> <output> <app|cli> <versions-json>",
  );
}

const versions = JSON.parse(versionsJson ?? "{}");
const requiredVersionKeys =
  imageKind === "app" ? ["tini"] : ["docker", "compose"];
for (const key of requiredVersionKeys) {
  if (typeof versions[key] !== "string" || versions[key].length === 0) {
    throw new Error(`missing notice version: ${key}`);
  }
}

const exceptions = JSON.parse(
  readFileSync(new URL("./license-exceptions.json", import.meta.url), "utf8"),
);
const packageDirectories = [];
const virtualStore = join(modulesRoot, ".pnpm");
for (const storeEntry of await readdir(virtualStore, { withFileTypes: true })) {
  if (!storeEntry.isDirectory()) continue;
  const packagesRoot = join(virtualStore, storeEntry.name, "node_modules");
  if (!existsSync(packagesRoot)) continue;
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(packagesRoot, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of await readdir(path, { withFileTypes: true })) {
        if (!scopedEntry.isDirectory()) continue;
        const scopedPath = join(path, scopedEntry.name);
        if (existsSync(join(scopedPath, "package.json"))) {
          packageDirectories.push(scopedPath);
        }
      }
    } else if (existsSync(join(path, "package.json"))) {
      packageDirectories.push(path);
    }
  }
}

const packages = new Map();
for (const directory of packageDirectories) {
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  if (!manifest.name || !manifest.version) continue;
  const key = `${manifest.name}@${manifest.version}`;
  if (!packages.has(key)) packages.set(key, { directory, manifest });
}

const licenseNamePattern =
  /^(?:licen[cs]e|notice|copying|copyright|mit|apache)(?:[._-].*)?$/iu;
const npmLicenseRoot = join(outputRoot, "licenses", "npm");
mkdirSync(npmLicenseRoot, { recursive: true });
const lines = [
  "# Argus third-party notices",
  "",
  "Generated deterministically from the production dependency closure.",
  "",
  "## npm packages",
  "",
];
const missing = [];

for (const [key, { directory, manifest }] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  if (String(manifest.name).startsWith("@argus/")) continue;
  const repository =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository?.url;
  const project =
    manifest.homepage ??
    repository ??
    `https://www.npmjs.com/package/${manifest.name}`;
  const licenseName = String(manifest.license ?? "UNKNOWN");
  const safeName = key.replaceAll("/", "__").replaceAll("@", "_");
  const discovered = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && licenseNamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "case" }));
  const packaged = [];

  for (const [index, fileName] of discovered.entries()) {
    const relativePath = `licenses/npm/${safeName}-${String(index + 1).padStart(2, "0")}-${fileName}`;
    cpSync(join(directory, fileName), join(outputRoot, relativePath));
    packaged.push(relativePath);
  }

  if (packaged.length === 0) {
    const audited = exceptions.packages?.[key];
    if (
      !audited ||
      typeof audited.spdx !== "string" ||
      typeof audited.source !== "string" ||
      typeof audited.textFile !== "string"
    ) {
      missing.push(key);
      continue;
    }
    if (audited.spdx !== licenseName) {
      throw new Error(
        `${key}: audited SPDX ${audited.spdx} does not match ${licenseName}`,
      );
    }
    const relativePath = `licenses/npm/${safeName}-AUDITED-${audited.spdx.replaceAll("/", "_")}.txt`;
    const auditedText = readFileSync(
      new URL(audited.textFile, import.meta.url),
      "utf8",
    ).trim();
    if (auditedText.length === 0) {
      throw new Error(`${key}: audited license text is empty`);
    }
    writeFileSync(
      join(outputRoot, relativePath),
      `Audited source: ${audited.source}\n\n${auditedText}\n`,
    );
    packaged.push(relativePath);
  }

  lines.push(
    `- ${key} — ${licenseName} — ${project} — ${packaged.join(", ")}`,
  );
}

if (missing.length > 0) {
  throw new Error(`missing packaged license text: ${missing.join(", ")}`);
}

lines.push("", "## Redistributed tools", "");
if (imageKind === "app") {
  lines.push(
    `- Tini ${versions.tini} — MIT — https://github.com/krallin/tini — licenses/tini-copyright`,
  );
} else {
  lines.push(
    `- Docker CLI ${versions.docker} — Apache-2.0 — https://github.com/docker/cli — licenses/docker-cli-LICENSE`,
    `- Docker Compose ${versions.compose} — Apache-2.0 — https://github.com/docker/compose — licenses/docker-compose-LICENSE`,
  );
}
lines.push("");
writeFileSync(join(outputRoot, "THIRD_PARTY_NOTICES.md"), lines.join("\n"));
