#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const durableLauncherContract = [
  "argus_state='/opt/argus/management.state'",
  '[ -f "$argus_state" ] && [ ! -L "$argus_state" ] || argus_state_error',
  "IFS= read -r argus_version <&3 || argus_state_error",
  "IFS= read -r argus_cli_image <&3 || argus_state_error",
  '[ "$argus_schema" = \'schema=1\' ] || argus_state_error',
  '"$argus_cli_image" "$@"',
];

const fail = (message) => {
  throw new Error(`VPS acceptance policy: ${message}`);
};

const versionOf = (tag) => {
  const match = tagPattern.exec(tag);
  if (!match) fail(`invalid release tag ${JSON.stringify(tag)}`);
  return match.slice(1).map((part) => BigInt(part));
};

const compareTags = (left, right) => {
  const leftVersion = versionOf(left);
  const rightVersion = versionOf(right);
  for (let index = 0; index < leftVersion.length; index += 1) {
    const difference = leftVersion[index] - rightVersion[index];
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
};

const readDurableTags = (path) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("verified durable baseline list is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) {
    fail("verified durable baseline list must be an array of release tags");
  }
  const tags = new Set(parsed);
  if (tags.size !== parsed.length) fail("verified durable baseline list has duplicates");
  for (const tag of tags) versionOf(tag);
  return [...tags];
};

const selectBaseline = (target, durableTags) => {
  versionOf(target);
  const baseline = durableTags
    .filter((tag) => compareTags(tag, target) < 0)
    .sort(compareTags)
    .at(-1);
  return baseline
    ? { mode: "update", baselineTag: baseline }
    : { mode: "bootstrap" };
};

const verifyDurableLauncher = (manifestPath, wrapperPath) => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail("baseline manifest is not valid JSON");
  }
  const expectedSha256 = manifest?.assets?.wrapper?.sha256;
  if (typeof expectedSha256 !== "string" || !sha256Pattern.test(expectedSha256)) {
    fail("baseline manifest has no valid wrapper SHA-256");
  }

  let wrapper;
  try {
    wrapper = readFileSync(wrapperPath);
  } catch {
    fail("baseline wrapper cannot be read");
  }
  const actualSha256 = createHash("sha256").update(wrapper).digest("hex");
  if (actualSha256 !== expectedSha256) {
    fail("baseline wrapper does not match its manifest SHA-256");
  }
  try {
    execFileSync("sh", ["-n", wrapperPath], { stdio: "ignore" });
  } catch {
    fail("baseline wrapper is not valid POSIX shell");
  }

  const source = wrapper.toString("utf8");
  return durableLauncherContract.every((line) => source.includes(line));
};

try {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "select-baseline") {
    const [targetFlag, target, durableTagsFlag, durableTagsPath] = arguments_;
    if (
      arguments_.length !== 4 ||
      targetFlag !== "--target" ||
      durableTagsFlag !== "--durable-tags"
    ) {
      fail("usage: select-baseline --target vX.Y.Z --durable-tags FILE");
    }
    process.stdout.write(
      `${JSON.stringify(selectBaseline(target, readDurableTags(durableTagsPath)))}\n`,
    );
  } else if (command === "verify-durable-launcher") {
    const [manifestPath, wrapperPath] = arguments_;
    if (!manifestPath || !wrapperPath || arguments_.length !== 2) {
      fail("usage: verify-durable-launcher MANIFEST WRAPPER");
    }
    const durable = verifyDurableLauncher(manifestPath, wrapperPath);
    process.stdout.write(`${JSON.stringify({ durable })}\n`);
  } else {
    fail("unknown command");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
