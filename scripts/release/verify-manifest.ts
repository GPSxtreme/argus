import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { verifyReleaseManifestWithIdentity } from "../../packages/release/src/index.js";

const usage =
  "Usage: verify-manifest.ts MANIFEST_PATH SIGNATURE_PATH [PUBLIC_KEY_PATH]";

const main = async (): Promise<void> => {
  const [manifestArgument, signatureArgument, publicKeyArgument, ...extra] =
    process.argv.slice(2);
  if (
    manifestArgument === undefined ||
    signatureArgument === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(usage);
  }
  const manifestPath = resolve(manifestArgument);
  const signaturePath = resolve(signatureArgument);
  const publicKeyPath = resolve(
    publicKeyArgument ?? join(dirname(manifestPath), "release-public.pem"),
  );
  const [manifestBytes, signature, publicKeyPem] = await Promise.all([
    readFile(manifestPath),
    readFile(signaturePath),
    readFile(publicKeyPath, "utf8"),
  ]);
  const verified = verifyReleaseManifestWithIdentity(
    manifestBytes,
    signature,
    publicKeyPem,
  );
  const directory = dirname(manifestPath);
  const artifacts = [
    ["fxembed", "fxembed.js"],
    ["wrapper", "argus"],
    ["installer", "install.sh"],
    ["publicKey", "release-public.pem"],
    ["fxembedLicense", "FXEMBED-LICENSE.md"],
    ["fxembedProvenance", "fxembed-provenance.json"],
  ] as const;
  for (const [name, filename] of artifacts) {
    const asset = verified.manifest.assets[name];
    if (asset === undefined) {
      throw new TypeError(`Signed manifest is missing ${name} checksum coverage.`);
    }
    const bytes = await readFile(join(directory, filename));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new TypeError(`Signed checksum mismatch for ${filename}.`);
    }
  }
  process.stdout.write(
    `${verified.manifest.version} ${verified.manifestSha256}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
