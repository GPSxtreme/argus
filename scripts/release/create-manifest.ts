import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildReleaseArtifacts,
  renderArgusWrapper,
  renderInstaller,
  type ReleaseImageInput,
} from "../../packages/release/src/index.js";

const fixturePrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGJqC73Ezwmnx3FFQ5W1czmiNwXmLFn2Xso+6xXKPXKf
-----END PRIVATE KEY-----`;
const fixtureDigest = (character: string): string => character.repeat(64);
const usage =
  "Usage: create-manifest.ts --fixture | --version VERSION --source-date-epoch EPOCH --image NAME=REFERENCE (four times) --fxembed PATH --fxembed-compatibility-date YYYY-MM-DD --wrapper PATH --release-base-url HTTPS_URL --output-dir PATH [--signing-key-file PATH]";

interface Arguments {
  version: string;
  sourceDateEpoch: string;
  images: ReleaseImageInput[];
  fxembedPath: string;
  fxembedCompatibilityDate: string;
  wrapperPath: string;
  releaseBaseUrl: string;
  outputDirectory: string;
  privateKeyPem: string;
}

const regularFile = async (path: string): Promise<string> => {
  const resolved = resolve(path);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(`${path} must be a regular, non-symlink file.`);
  }
  return resolved;
};

const parseImage = (value: string): ReleaseImageInput => {
  const separator = value.indexOf("=");
  const name = value.slice(0, separator);
  const reference = value.slice(separator + 1);
  if (
    separator < 1 ||
    !["app", "cli", "searxng", "postgres"].includes(name) ||
    reference.length === 0
  ) {
    throw new TypeError(usage);
  }
  return { name: name as ReleaseImageInput["name"], reference };
};

const fixtureArguments = async (): Promise<Arguments> => {
  const directory = resolve("dist/release");
  await mkdir(directory, { recursive: true });
  const fxembedPath = join(directory, "fxembed.js");
  const wrapperPath = join(directory, "argus");
  const wrapper = renderArgusWrapper({
    version: "0.0.0-fixture",
    cliImageDigest: `ghcr.io/gpsxtreme/argus-cli@sha256:${fixtureDigest("b")}`,
  });
  await atomicWrite(
    fxembedPath,
    Buffer.from("export default { async fetch() { return new Response('ok'); } };\n"),
    0o644,
  );
  await atomicWrite(wrapperPath, Buffer.from(wrapper), 0o755);
  return {
    version: "0.0.0-fixture",
    sourceDateEpoch: "1785580200",
    images: [
      { name: "app", reference: `ghcr.io/gpsxtreme/argus@sha256:${fixtureDigest("a")}` },
      { name: "cli", reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${fixtureDigest("b")}` },
      { name: "searxng", reference: `docker.io/searxng/searxng@sha256:${fixtureDigest("c")}` },
      { name: "postgres", reference: `docker.io/library/postgres@sha256:${fixtureDigest("d")}` },
    ],
    fxembedPath,
    fxembedCompatibilityDate: "2026-04-11",
    wrapperPath,
    releaseBaseUrl: "https://github.com/gpsxtreme/argus/releases/download/v0.0.0-fixture",
    outputDirectory: directory,
    privateKeyPem: fixturePrivateKey,
  };
};

const parseArguments = async (values: readonly string[]): Promise<Arguments> => {
  if (values.length === 1 && values[0] === "--fixture") return fixtureArguments();
  if (values.includes("--fixture")) throw new TypeError(usage);

  const scalar = new Map<string, string>();
  const images: ReleaseImageInput[] = [];
  const accepted = new Set([
    "--version",
    "--source-date-epoch",
    "--image",
    "--fxembed",
    "--fxembed-compatibility-date",
    "--wrapper",
    "--release-base-url",
    "--output-dir",
    "--signing-key-file",
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !accepted.has(option) ||
      value.startsWith("--")
    ) {
      throw new TypeError(usage);
    }
    if (option === "--image") {
      images.push(parseImage(value));
      continue;
    }
    if (scalar.has(option)) throw new TypeError(`Duplicate argument: ${option}`);
    scalar.set(option, value);
  }
  const required = (name: string): string => {
    const value = scalar.get(name);
    if (value === undefined) throw new TypeError(usage);
    return value;
  };
  const keyFile = scalar.get("--signing-key-file");
  const privateKeyPem =
    keyFile === undefined
      ? process.env.ARGUS_RELEASE_ED25519_KEY
      : await readFile(await regularFile(keyFile), "utf8");
  if (privateKeyPem === undefined) {
    throw new TypeError(
      "ARGUS_RELEASE_ED25519_KEY or --signing-key-file is required.",
    );
  }
  return {
    version: required("--version"),
    sourceDateEpoch: required("--source-date-epoch"),
    images,
    fxembedPath: await regularFile(required("--fxembed")),
    fxembedCompatibilityDate: required("--fxembed-compatibility-date"),
    wrapperPath: await regularFile(required("--wrapper")),
    releaseBaseUrl: required("--release-base-url").replace(/\/+$/u, ""),
    outputDirectory: resolve(required("--output-dir")),
    privateKeyPem,
  };
};

const atomicWrite = async (
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const main = async (): Promise<void> => {
  const arguments_ = await parseArguments(process.argv.slice(2));
  const [fxembedBytes, wrapperBytes] = await Promise.all([
    readFile(arguments_.fxembedPath),
    readFile(arguments_.wrapperPath),
  ]);
  const built = buildReleaseArtifacts({
    version: arguments_.version,
    sourceDateEpoch: arguments_.sourceDateEpoch,
    images: arguments_.images,
    fxembed: {
      bytes: fxembedBytes,
      url: `${arguments_.releaseBaseUrl}/fxembed.js`,
      compatibilityDate: arguments_.fxembedCompatibilityDate,
    },
    wrapper: {
      bytes: wrapperBytes,
      url: `${arguments_.releaseBaseUrl}/argus`,
    },
    privateKeyPem: arguments_.privateKeyPem,
  });
  const installer = renderInstaller({
    manifestUrl: `${arguments_.releaseBaseUrl}/manifest.json`,
    publicKeyPem: built.publicKeyPem,
  });
  await Promise.all([
    atomicWrite(join(arguments_.outputDirectory, "manifest.json"), built.manifestBytes, 0o644),
    atomicWrite(join(arguments_.outputDirectory, "manifest.sig"), built.signature, 0o644),
    atomicWrite(join(arguments_.outputDirectory, "release-public.pem"), Buffer.from(built.publicKeyPem), 0o644),
    atomicWrite(join(arguments_.outputDirectory, "install.sh"), Buffer.from(installer), 0o755),
  ]);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
