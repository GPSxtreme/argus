import { dirname, join, resolve } from "node:path";
import { verifyReleaseFiles } from "./verify-release-directory.js";

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
  const directory = dirname(manifestPath);
  const verified = await verifyReleaseFiles({
    releaseDirectory: directory,
    manifestPath,
    signaturePath,
    verificationPublicKeyPath: publicKeyPath,
  });
  process.stdout.write(
    `${verified.release.manifest.version} ${verified.release.manifestSha256}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
