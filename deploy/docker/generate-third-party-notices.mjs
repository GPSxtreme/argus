import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [modulesRoot, outputRoot, imageKind, versionsJson, legalRootArgument] =
  process.argv.slice(2);
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

const defaultLegalRoot = dirname(fileURLToPath(import.meta.url));
const legalRoot = resolve(legalRootArgument ?? defaultLegalRoot);
const exceptions = JSON.parse(
  readFileSync(join(legalRoot, "license-exceptions.json"), "utf8"),
);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const immutableSourcePattern =
  /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//u;
const resolveLegalFile = (metadata, label) => {
  for (const field of [
    "sha256",
    "source",
    "sourceSha256",
    "textFile",
  ]) {
    if (typeof metadata?.[field] !== "string" || metadata[field].length === 0) {
      throw new Error(`${label}: missing ${field}`);
    }
  }
  if (
    !sha256Pattern.test(metadata.sha256) ||
    !sha256Pattern.test(metadata.sourceSha256)
  ) {
    throw new Error(`${label}: invalid SHA-256 metadata`);
  }
  if (!immutableSourcePattern.test(metadata.source)) {
    throw new Error(`${label}: source URL is not commit-pinned`);
  }
  const path = resolve(legalRoot, metadata.textFile);
  if (relative(legalRoot, path).startsWith("..")) {
    throw new Error(`${label}: legal text escapes the legal root`);
  }
  const text = readFileSync(path, "utf8");
  const actualSha256 = createHash("sha256").update(text).digest("hex");
  if (actualSha256 !== metadata.sha256) {
    throw new Error(
      `${label}: checksum mismatch (expected ${metadata.sha256}, received ${actualSha256})`,
    );
  }
  if (/<year>|<copyright holders>/iu.test(text)) {
    throw new Error(`${label}: placeholder attribution is forbidden`);
  }
  return { path, text };
};

for (const [packageVersion, metadata] of Object.entries(
  exceptions.packages ?? {},
)) {
  if (
    typeof metadata.copyright !== "string" ||
    !metadata.copyright.startsWith("Copyright")
  ) {
    throw new Error(`${packageVersion}: missing copyright identity`);
  }
  const versionSeparator = packageVersion.lastIndexOf("@");
  const packageName = packageVersion.slice(0, versionSeparator);
  const version = packageVersion.slice(versionSeparator + 1);
  const safePackageName = packageName
    .replaceAll("/", "__")
    .replaceAll("@", "_");
  if (
    !metadata.textFile.includes(
      `/legal/npm/${safePackageName}/${version}/`,
    )
  ) {
    throw new Error(`${packageVersion}: version mismatch in legal text path`);
  }
  const { text } = resolveLegalFile(metadata, packageVersion);
  if (!text.includes(metadata.copyright)) {
    throw new Error(`${packageVersion}: copyright identity mismatch`);
  }
}
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
      typeof audited.copyright !== "string" ||
      typeof audited.sha256 !== "string" ||
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
    const auditedText = resolveLegalFile(audited, key);
    if (auditedText.text.trim().length === 0) {
      throw new Error(`${key}: audited license text is empty`);
    }
    cpSync(auditedText.path, join(outputRoot, relativePath));
    packaged.push(relativePath);
  }

  lines.push(
    `- ${key} — ${licenseName} — ${project}${exceptions.packages?.[key] ? ` — ${exceptions.packages[key].copyright} — ${exceptions.packages[key].source}` : ""} — ${packaged.join(", ")}`,
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
  const toolOutputRoot = join(outputRoot, "licenses", "tools");
  mkdirSync(toolOutputRoot, { recursive: true });
  const copyToolLegal = (toolKey, displayName, outputPrefix) => {
    const metadata = exceptions.tools?.[toolKey];
    if (!metadata || metadata.version !== versions[toolKey]) {
      throw new Error(
        `${displayName} version mismatch: expected ${metadata?.version ?? "missing"}, received ${versions[toolKey]}`,
      );
    }
    const license = resolveLegalFile(
      metadata.license,
      `${displayName} ${metadata.version} LICENSE`,
    );
    const notice = resolveLegalFile(
      metadata.notice,
      `${displayName} ${metadata.version} NOTICE`,
    );
    const licensePath = `licenses/tools/${outputPrefix}-${metadata.version}-LICENSE`;
    const noticePath = `licenses/tools/${outputPrefix}-${metadata.version}-NOTICE`;
    cpSync(license.path, join(outputRoot, licensePath));
    cpSync(notice.path, join(outputRoot, noticePath));
    return { licensePath, noticePath };
  };
  const dockerLegal = copyToolLegal("docker", "Docker CLI", "docker-cli");
  const composeLegal = copyToolLegal(
    "compose",
    "Docker Compose",
    "docker-compose",
  );
  lines.push(
    `- Docker CLI ${versions.docker} — Apache-2.0 — https://github.com/docker/cli — ${dockerLegal.licensePath}, ${dockerLegal.noticePath}`,
    `- Docker Compose ${versions.compose} — Apache-2.0 — https://github.com/docker/compose — ${composeLegal.licensePath}, ${composeLegal.noticePath}`,
  );
}
lines.push("");
writeFileSync(join(outputRoot, "THIRD_PARTY_NOTICES.md"), lines.join("\n"));
