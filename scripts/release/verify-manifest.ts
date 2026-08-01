import { readFile } from "node:fs/promises";
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
  process.stdout.write(
    `${verified.manifest.version} ${verified.manifestSha256}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
