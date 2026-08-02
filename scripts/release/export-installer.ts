import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderInstaller } from "../../packages/release/src/installer.js";

const fixturePublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8lvLpgw7vM9/41Vwj2HWxUnN2e5x3E/Y6HsC5s1wkoY=
-----END PUBLIC KEY-----`;

interface Arguments {
  manifestUrl: string;
  publicKeyPem: string;
  output?: string;
}

const usage =
  "Usage: export-installer.ts --fixture [--output PATH] | --manifest-url HTTPS_URL --public-key-file PATH [--output PATH]";

const parseArguments = async (values: readonly string[]): Promise<Arguments> => {
  let fixture = false;
  let manifestUrl: string | undefined;
  let publicKeyFile: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--fixture") {
      if (fixture) throw new Error(usage);
      fixture = true;
      continue;
    }
    if (
      argument === "--manifest-url" ||
      argument === "--public-key-file" ||
      argument === "--output"
    ) {
      const value = values[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(usage);
      index += 1;
      if (argument === "--manifest-url") {
        if (manifestUrl !== undefined) throw new Error(usage);
        manifestUrl = value;
      } else if (argument === "--public-key-file") {
        if (publicKeyFile !== undefined) throw new Error(usage);
        publicKeyFile = value;
      } else {
        if (output !== undefined) throw new Error(usage);
        output = value;
      }
      continue;
    }
    throw new Error(usage);
  }
  if (fixture) {
    if (manifestUrl !== undefined || publicKeyFile !== undefined) {
      throw new Error(usage);
    }
    return {
      manifestUrl: "https://argus.gpsxtre.me/fixtures/manifest.json",
      publicKeyPem: fixturePublicKey,
      ...(output === undefined ? {} : { output }),
    };
  }
  if (manifestUrl === undefined || publicKeyFile === undefined) {
    throw new Error(usage);
  }
  const keyPath = resolve(publicKeyFile);
  const keyStat = await lstat(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink()) {
    throw new Error("Public key path must be a regular, non-symlink file.");
  }
  const publicKeyPem = await readFile(keyPath, "utf8");
  return {
    manifestUrl,
    publicKeyPem,
    ...(output === undefined ? {} : { output }),
  };
};

const main = async (): Promise<void> => {
  const arguments_ = await parseArguments(process.argv.slice(2));
  const installer = renderInstaller(arguments_);
  if (arguments_.output === undefined) {
    process.stdout.write(installer);
    return;
  }
  const output = resolve(arguments_.output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, installer, { mode: 0o755, flag: "wx" });
  await rename(temporary, output);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
