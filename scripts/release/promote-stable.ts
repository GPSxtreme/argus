import { promoteStableBundle } from "./stable-bundle.js";

const usage = "Usage: promote-stable.ts RELEASE_DIRECTORY STABLE_DIRECTORY";

const main = async (): Promise<void> => {
  const [releaseDirectory, stableDirectory, ...extra] = process.argv.slice(2);
  if (
    releaseDirectory === undefined ||
    stableDirectory === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(usage);
  }
  const promoted = await promoteStableBundle(releaseDirectory, stableDirectory);
  process.stdout.write(
    `${promoted.version} ${promoted.manifestSha256} ${promoted.installerSha256}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
