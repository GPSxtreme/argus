#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const stableDirectory = "apps/web/public/releases/stable/";
const bundleMembers = new Set(["install.sh", "manifest.json", "manifest.sig"]);

const fail = (message) => {
  throw new Error(`stable release bundle policy: ${message}`);
};

const changedPaths = (base, head) => {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, head],
    { encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean);
};

try {
  const [base, head] = process.argv.slice(2);
  if (!base || !head || process.argv.length !== 4) {
    fail("usage: assert-stable-bundle-change.mjs BASE_SHA HEAD_SHA");
  }

  const changedBundleMembers = changedPaths(base, head)
    .filter((path) => path.startsWith(stableDirectory))
    .map((path) => path.slice(stableDirectory.length));

  if (changedBundleMembers.length === 0) process.exit(0);

  const changed = new Set(changedBundleMembers);
  const manifestChanged = changed.has("manifest.json");
  const signatureChanged = changed.has("manifest.sig");
  const installerChanged = changed.has("install.sh");
  const missing = ["manifest.json", "manifest.sig"].filter(
    (member) => !changed.has(member),
  );
  const unexpected = changedBundleMembers.filter(
    (member) => !bundleMembers.has(member),
  );
  if (!manifestChanged || !signatureChanged || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.sort().join(", ")}` : undefined,
      unexpected.length > 0
        ? `unexpected ${[...new Set(unexpected)].sort().join(", ")}`
        : undefined,
    ].filter(Boolean);
    fail(`stable directory changes must include manifest.json and manifest.sig, with optional install.sh (${details.join("; ")})`);
  }
  if (installerChanged && (!manifestChanged || !signatureChanged)) {
    fail("install.sh requires manifest.json and manifest.sig");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
