import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReleaseArtifacts,
  renderArgusWrapper,
  type ReleaseImageInput,
} from "../src/index.js";

const fixturePrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGJqC73Ezwmnx3FFQ5W1czmiNwXmLFn2Xso+6xXKPXKf
-----END PRIVATE KEY-----`;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");
const policy = join(repositoryRoot, "scripts/e2e/release-acceptance-policy.ts");
const installerVerifier = join(repositoryRoot, "scripts/e2e/verify-sha256.sh");
const temporaryDirectories: string[] = [];

const sha = (character: string): string => character.repeat(64);
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const image = (
  name: ReleaseImageInput["name"],
  repository: string,
  character: string,
): ReleaseImageInput => ({
  name,
  reference: `${repository}@sha256:${sha(character)}`,
});

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "argus-release-acceptance-policy-"));
  temporaryDirectories.push(directory);
  return directory;
};

interface ReleaseFixture {
  directory: string;
  installer: Buffer;
  publicKeyPath: string;
  wrapper: Buffer;
}

const createReleaseFixture = ({
  privateKeyPem = fixturePrivateKey,
  wrapper = Buffer.from(renderArgusWrapper()),
  installer = Buffer.from("#!/bin/sh\n# verified installer\n"),
}: {
  privateKeyPem?: string;
  wrapper?: Buffer;
  installer?: Buffer;
} = {}): ReleaseFixture => {
  const root = temporaryDirectory();
  const directory = join(root, "release");
  mkdirSync(directory);
  const built = buildReleaseArtifacts({
    version: "1.2.3",
    sourceDateEpoch: "1785580200",
    images: [
      image("app", "ghcr.io/gpsxtreme/argus", "a"),
      image("cli", "ghcr.io/gpsxtreme/argus-cli", "b"),
      image("searxng", "docker.io/searxng/searxng", "c"),
      image("postgres", "docker.io/library/postgres", "d"),
      image("fxembed", "ghcr.io/gpsxtreme/argus-fxembed", "e"),
    ],
    fxembed: {
      bytes: Buffer.from("export default {};\n"),
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/fxembed.js",
      compatibilityDate: "2026-04-11",
    },
    wrapper: {
      bytes: wrapper,
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/argus",
    },
    installer: {
      bytes: installer,
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/install.sh",
    },
    publicKeyUrl:
      "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/release-public.pem",
    fxembedLicense: {
      bytes: Buffer.from("MIT\n"),
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/FXEMBED-LICENSE.md",
    },
    fxembedProvenance: {
      bytes: Buffer.from('{"revision":"fixture"}\n'),
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/fxembed-provenance.json",
    },
    privateKeyPem,
  });
  const publicKeyPath = join(root, "trusted-public.pem");
  writeFileSync(join(directory, "manifest.json"), built.manifestBytes);
  writeFileSync(join(directory, "manifest.sig"), built.signature);
  writeFileSync(join(directory, "release-public.pem"), built.publicKeyPem);
  writeFileSync(join(directory, "argus"), wrapper, { mode: 0o755 });
  writeFileSync(join(directory, "install.sh"), installer, { mode: 0o755 });
  writeFileSync(publicKeyPath, built.publicKeyPem);
  return { directory, installer, publicKeyPath, wrapper };
};

const runPolicy = (arguments_: readonly string[]) =>
  spawnSync(process.execPath, [tsxCli, policy, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release acceptance policy", () => {
  it("uses bootstrap mode when no earlier release has a verified durable launcher", () => {
    const directory = temporaryDirectory();
    const durableTags = join(directory, "durable-tags.json");
    writeFileSync(durableTags, '["v0.1.15"]\n');

    const result = runPolicy([
      "select-baseline",
      "--target",
      "v0.1.14",
      "--durable-tags",
      durableTags,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode: "bootstrap" });
  });

  it("uses the latest verified durable earlier release for the full update lifecycle", () => {
    const directory = temporaryDirectory();
    const durableTags = join(directory, "durable-tags.json");
    writeFileSync(durableTags, '["v0.1.13","v0.1.14","v0.1.9"]\n');

    const result = runPolicy([
      "select-baseline",
      "--target",
      "v0.1.15",
      "--durable-tags",
      durableTags,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "update",
      baselineTag: "v0.1.14",
    });
  });

  it("verifies the signed release and exact canonical durable launcher", () => {
    const fixture = createReleaseFixture();

    const result = runPolicy([
      "verify-release",
      fixture.directory,
      fixture.publicKeyPath,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      durable: true,
      version: "1.2.3",
      installerSha256: digest(fixture.installer),
      wrapperSha256: digest(fixture.wrapper),
    });
  });

  it("rejects an invalid manifest signature", () => {
    const fixture = createReleaseFixture();
    writeFileSync(join(fixture.directory, "manifest.sig"), Buffer.alloc(64));

    const result = runPolicy([
      "verify-release",
      fixture.directory,
      fixture.publicKeyPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release manifest signature is invalid");
  });

  it("rejects a release self-signed by a noncanonical root", () => {
    const privateKeyPem = generateKeyPairSync("ed25519").privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const fixture = createReleaseFixture({ privateKeyPem });

    const result = runPolicy(["verify-release", fixture.directory]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release manifest signature is invalid");
  });

  it("rejects an installer that does not match its signed hash", () => {
    const fixture = createReleaseFixture();
    writeFileSync(join(fixture.directory, "install.sh"), "#!/bin/sh\n# changed\n");

    const result = runPolicy([
      "verify-release",
      fixture.directory,
      fixture.publicKeyPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Signed checksum mismatch for install.sh");
  });

  it("does not classify a hash-bound launcher spoof as durable", () => {
    const wrapper = Buffer.from(`${renderArgusWrapper()}# spoof\n`);
    const fixture = createReleaseFixture({ wrapper });

    const result = runPolicy([
      "verify-release",
      fixture.directory,
      fixture.publicKeyPath,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ durable: false });
  });

  it("rechecks installer bytes immediately before the VPS harness executes them", () => {
    const fixture = createReleaseFixture();
    const installerPath = join(fixture.directory, "install.sh");

    expect(
      spawnSync("sh", [installerVerifier, installerPath, digest(fixture.installer)]).status,
    ).toBe(0);
    const mismatch = spawnSync("sh", [installerVerifier, installerPath, sha("0")], {
      encoding: "utf8",
    });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("SHA-256 mismatch");
  });
});
