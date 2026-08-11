#!/usr/bin/env -S pnpm tsx

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  renderArgusWrapper,
  stableReleasePublicKey,
  verifyReleaseManifestWithIdentity,
} from "../../packages/release/src/index.js";

const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const fail = (message: string): never => {
  throw new Error(`VPS acceptance policy: ${message}`);
};

const versionOf = (tag: string): bigint[] => {
  const match = tagPattern.exec(tag);
  if (!match) fail(`invalid release tag ${JSON.stringify(tag)}`);
  return match.slice(1).map((part) => BigInt(part));
};

const compareTags = (left: string, right: string): number => {
  const leftVersion = versionOf(left);
  const rightVersion = versionOf(right);
  for (let index = 0; index < leftVersion.length; index += 1) {
    const leftPart = leftVersion[index];
    const rightPart = rightVersion[index];
    if (leftPart === undefined || rightPart === undefined) {
      fail("release version comparison is incomplete");
    }
    const difference = leftPart - rightPart;
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
};

const readDurableTags = async (path: string): Promise<string[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("verified durable baseline list is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) {
    fail("verified durable baseline list must be an array of release tags");
  }
  const tags = new Set(parsed as string[]);
  if (tags.size !== parsed.length) {
    fail("verified durable baseline list has duplicates");
  }
  for (const tag of tags) versionOf(tag);
  return [...tags];
};

const selectBaseline = (
  target: string,
  durableTags: readonly string[],
): { mode: "bootstrap" } | { mode: "update"; baselineTag: string } => {
  versionOf(target);
  const baseline = durableTags
    .filter((tag) => compareTags(tag, target) < 0)
    .sort(compareTags)
    .at(-1);
  return baseline === undefined
    ? { mode: "bootstrap" }
    : { mode: "update", baselineTag: baseline };
};

const assertChecksum = (
  filename: string,
  bytes: Uint8Array,
  expected: string,
): string => {
  const actual = sha256(bytes);
  if (actual !== expected) {
    fail(`Signed checksum mismatch for ${filename}.`);
  }
  return actual;
};

const verifyRelease = async (
  directory: string,
  trustedPublicKeyPem: string,
): Promise<{
  durable: boolean;
  version: string;
  installerSha256: string;
  wrapperSha256: string;
}> => {
  const releaseDirectory = resolve(directory);
  const [manifest, signature, candidatePublicKey, installer, wrapper] =
    await Promise.all([
      readFile(join(releaseDirectory, "manifest.json")),
      readFile(join(releaseDirectory, "manifest.sig")),
      readFile(join(releaseDirectory, "release-public.pem")),
      readFile(join(releaseDirectory, "install.sh")),
      readFile(join(releaseDirectory, "argus")),
    ]);
  const verified = verifyReleaseManifestWithIdentity(
    manifest,
    signature,
    trustedPublicKeyPem,
  );
  const installerAsset = verified.manifest.assets.installer;
  if (installerAsset === undefined) {
    fail("Signed manifest is missing installer checksum coverage.");
  }
  assertChecksum(
    "release-public.pem",
    candidatePublicKey,
    verified.manifest.assets.publicKey.sha256,
  );
  const installerSha256 = assertChecksum(
    "install.sh",
    installer,
    installerAsset.sha256,
  );
  const wrapperSha256 = assertChecksum(
    "argus",
    wrapper,
    verified.manifest.assets.wrapper.sha256,
  );
  const canonicalWrapper = Buffer.from(renderArgusWrapper());
  return {
    durable: wrapper.equals(canonicalWrapper),
    version: verified.manifest.version,
    installerSha256,
    wrapperSha256,
  };
};

const main = async (): Promise<void> => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "select-baseline") {
    const [targetFlag, target, durableTagsFlag, durableTagsPath] = arguments_;
    if (
      arguments_.length !== 4 ||
      targetFlag !== "--target" ||
      target === undefined ||
      durableTagsFlag !== "--durable-tags" ||
      durableTagsPath === undefined
    ) {
      fail("usage: select-baseline --target vX.Y.Z --durable-tags FILE");
    }
    process.stdout.write(
      `${JSON.stringify(selectBaseline(target, await readDurableTags(durableTagsPath)))}\n`,
    );
    return;
  }
  if (command === "verify-release") {
    const [directory, trustedPublicKeyPath] = arguments_;
    if (directory === undefined || arguments_.length > 2) {
      fail("usage: verify-release RELEASE_DIRECTORY [TRUSTED_PUBLIC_KEY_PATH]");
    }
    const trustedPublicKeyPem =
      trustedPublicKeyPath === undefined
        ? stableReleasePublicKey
        : await readFile(resolve(trustedPublicKeyPath), "utf8");
    process.stdout.write(
      `${JSON.stringify(await verifyRelease(directory, trustedPublicKeyPem))}\n`,
    );
    return;
  }
  fail("unknown command");
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
