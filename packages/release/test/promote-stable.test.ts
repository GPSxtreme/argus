import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReleaseArtifacts,
  type ReleaseManifestV1,
  type ReleaseImageInput,
  renderArgusWrapper,
  renderInstaller,
  serializeReleaseManifestCanonical,
  verifyReleaseDirectory,
} from "../src/index.js";
import {
  createStableBundleIO,
  promoteStableBundle,
} from "../src/stable-bundle.js";

const fixturePrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGJqC73Ezwmnx3FFQ5W1czmiNwXmLFn2Xso+6xXKPXKf
-----END PRIVATE KEY-----`;
const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");
const verifyManifestCli = resolve(
  repositoryRoot,
  "scripts/release/verify-manifest.ts",
);

const sha = (character: string): string => character.repeat(64);
const image = (
  name: ReleaseImageInput["name"],
  repository: string,
  character: string,
): ReleaseImageInput => ({
  name,
  reference: `${repository}@sha256:${sha(character)}`,
});
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

interface FixtureRelease {
  root: string;
  release: string;
  stable: string;
  manifest: Buffer;
  signature: Buffer;
  publicKeyPem: string;
}

const createFixtureRelease = async (
  privateKeyPem = fixturePrivateKey,
  wrapper = Buffer.from(renderArgusWrapper()),
): Promise<FixtureRelease> => {
  const root = await mkdtemp(join(tmpdir(), "argus-promote-stable-"));
  temporaryDirectories.push(root);
  const release = join(root, "release");
  const stable = join(root, "stable");
  await mkdir(release);
  await mkdir(stable);

  const fxembed = Buffer.from("export default { fetch() {} };\n");
  const installer = Buffer.from("#!/bin/sh\n# immutable candidate\n");
  const fxembedLicense = Buffer.from("MIT\n");
  const fxembedProvenance = Buffer.from('{"revision":"fixture"}\n');
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
      bytes: fxembed,
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
      bytes: fxembedLicense,
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/FXEMBED-LICENSE.md",
    },
    fxembedProvenance: {
      bytes: fxembedProvenance,
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/fxembed-provenance.json",
    },
    privateKeyPem,
  });
  await Promise.all([
    writeFile(join(release, "manifest.json"), built.manifestBytes),
    writeFile(join(release, "manifest.sig"), built.signature),
    writeFile(join(release, "release-public.pem"), built.publicKeyPem),
    writeFile(join(release, "argus"), wrapper, { mode: 0o755 }),
    writeFile(join(release, "install.sh"), installer, { mode: 0o755 }),
    writeFile(join(release, "fxembed.js"), fxembed),
    writeFile(join(release, "FXEMBED-LICENSE.md"), fxembedLicense),
    writeFile(join(release, "fxembed-provenance.json"), fxembedProvenance),
  ]);
  await writeStableSentinels(stable);
  return {
    root,
    release,
    stable,
    manifest: Buffer.from(built.manifestBytes),
    signature: Buffer.from(built.signature),
    publicKeyPem: built.publicKeyPem,
  };
};

interface CrossSignedFixture extends FixtureRelease {
  verificationPublicKeyPath: string;
  verificationPublicKeyPem: string;
}

const createCrossSignedFixture = async (): Promise<CrossSignedFixture> => {
  const fixture = await createFixtureRelease();
  const verificationKey = generateKeyPairSync("ed25519");
  const verificationPublicKeyPem = verificationKey.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const verificationPublicKeyPath = join(fixture.root, "external-trust.pem");
  const verificationSignature = sign(
    null,
    fixture.manifest,
    verificationKey.privateKey,
  );
  await Promise.all([
    writeFile(join(fixture.release, "manifest.sig"), verificationSignature),
    writeFile(verificationPublicKeyPath, verificationPublicKeyPem),
  ]);
  return {
    ...fixture,
    signature: Buffer.from(verificationSignature),
    verificationPublicKeyPath,
    verificationPublicKeyPem,
  };
};

const writeStableSentinels = async (stable: string): Promise<void> => {
  await Promise.all([
    writeFile(join(stable, "install.sh"), "prior installer\n", { mode: 0o755 }),
    writeFile(join(stable, "manifest.json"), "prior manifest\n"),
    writeFile(join(stable, "manifest.sig"), "prior signature\n"),
  ]);
};

interface StableBundleBytes {
  "install.sh": Buffer;
  "manifest.json": Buffer;
  "manifest.sig": Buffer;
}

const stableBytes = async (stable: string): Promise<StableBundleBytes> => ({
  "install.sh": await readFile(join(stable, "install.sh")),
  "manifest.json": await readFile(join(stable, "manifest.json")),
  "manifest.sig": await readFile(join(stable, "manifest.sig")),
});

const installerTrustRoot = (installer: Buffer): string => {
  const marker = "<<'ARGUS_RELEASE_PUBLIC_KEY'\n";
  const contents = installer.toString("utf8");
  const start = contents.indexOf(marker);
  const end = contents.indexOf("\nARGUS_RELEASE_PUBLIC_KEY\n", start + marker.length);
  if (start === -1 || end === -1) {
    throw new TypeError("Promoted installer is missing its trust-root heredoc.");
  }
  return contents.slice(start + marker.length, end);
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("promoteStableBundle", () => {
  it("rejects a self-signed substitute before changing the trusted stable bundle", async () => {
    const trusted = await createFixtureRelease();
    const attackerPrivateKey = generateKeyPairSync("ed25519").privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const attacker = await createFixtureRelease(attackerPrivateKey);
    const prior = await stableBytes(trusted.stable);

    await expect(
      promoteStableBundle(attacker.release, trusted.stable),
    ).rejects.toThrow("Release manifest signature is invalid");

    await expect(stableBytes(trusted.stable)).resolves.toEqual(prior);
  });

  it("promotes a fully verified release as one stable installer, manifest, and signature bundle", async () => {
    const fixture = await createFixtureRelease();
    const prior = await stableBytes(fixture.stable);

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).resolves.toEqual({
      version: "1.2.3",
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      installerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const promoted = await stableBytes(fixture.stable);
    expect(promoted["manifest.json"]).toEqual(fixture.manifest);
    expect(promoted["manifest.sig"]).toEqual(fixture.signature);
    expect(promoted["install.sh"].toString("utf8")).toContain(
      "https://argus.gpsxtre.me/releases/stable/manifest.json",
    );
    expect(promoted["install.sh"].toString("utf8")).toContain(fixture.publicKeyPem);
    expect(promoted["install.sh"]).not.toEqual(prior["install.sh"]);
    expect(promoted["manifest.json"]).not.toEqual(prior["manifest.json"]);
    expect(promoted["manifest.sig"]).not.toEqual(prior["manifest.sig"]);
    expect(digest(promoted["manifest.json"])).toBe(digest(fixture.manifest));
    expect((await stat(join(fixture.stable, "install.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(fixture.stable, "manifest.json"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(fixture.stable, "manifest.sig"))).mode & 0o777).toBe(0o644);
    expect((await readdir(fixture.stable)).sort()).toEqual([
      "install.sh",
      "manifest.json",
      "manifest.sig",
    ]);
  });

  it("rejects a signed, hash-bound malformed wrapper before changing stable bundle bytes", async () => {
    const fixture = await createFixtureRelease(
      fixturePrivateKey,
      Buffer.from("#!/bin/sh\nexec true\n"),
    );
    const prior = await stableBytes(fixture.stable);

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).rejects.toThrow("Candidate argus wrapper does not match the stable wrapper.");

    await expect(stableBytes(fixture.stable)).resolves.toEqual(prior);
  });

  it("rejects an argus replacement after verification before changing stable bundle bytes", async () => {
    const fixture = await createFixtureRelease(
      fixturePrivateKey,
      Buffer.from("#!/bin/sh\nexec true\n"),
    );
    const prior = await stableBytes(fixture.stable);
    const wrapperPath = join(fixture.release, "argus");
    const replacementIO = createStableBundleIO({
      async readFile(path: string): Promise<Buffer> {
        if (path === wrapperPath) return Buffer.from(renderArgusWrapper());
        return readFile(path);
      },
    });

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        io: replacementIO,
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).rejects.toThrow("Signed checksum mismatch for argus.");

    await expect(stableBytes(fixture.stable)).resolves.toEqual(prior);
  });

  it("promotes a bundle whose installer verifies with the root instead of its distinct candidate asset", async () => {
    const fixture = await createCrossSignedFixture();

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        trustedPublicKeyPem: fixture.verificationPublicKeyPem,
      }),
    ).resolves.toMatchObject({
      version: "1.2.3",
      manifestSha256: digest(fixture.manifest),
    });

    const promoted = await stableBytes(fixture.stable);
    expect(promoted["manifest.json"]).toEqual(fixture.manifest);
    expect(promoted["manifest.sig"]).toEqual(fixture.signature);
    const trustRoot = installerTrustRoot(promoted["install.sh"]);
    expect(trustRoot).toBe(fixture.verificationPublicKeyPem.trim());
    expect(trustRoot).not.toBe(fixture.publicKeyPem.trim());
    expect(
      verify(
        null,
        promoted["manifest.json"],
        trustRoot,
        promoted["manifest.sig"],
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        promoted["manifest.json"],
        fixture.publicKeyPem,
        promoted["manifest.sig"],
      ),
    ).toBe(false);
    expect(digest(await readFile(join(fixture.release, "release-public.pem")))).toBe(
      (JSON.parse(fixture.manifest.toString("utf8")) as ReleaseManifestV1).assets
        .publicKey.sha256,
    );
  });

  it("preserves the prior bundle when the root-signed release lacks its trusted root", async () => {
    const fixture = await createCrossSignedFixture();
    const prior = await stableBytes(fixture.stable);

    await expect(
      promoteStableBundle(fixture.release, fixture.stable),
    ).rejects.toThrow("Release manifest signature is invalid");

    await expect(stableBytes(fixture.stable)).resolves.toEqual(prior);
  });

  it("reads candidate public-key bytes once for signature trust, asset identity, and output", async () => {
    const fixture = await createFixtureRelease();
    const replacementPublicKey = generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const manifest = JSON.parse(fixture.manifest.toString("utf8")) as ReleaseManifestV1;
    manifest.assets.publicKey.sha256 = digest(Buffer.from(replacementPublicKey));
    const manifestBytes = Buffer.from(serializeReleaseManifestCanonical(manifest));
    await Promise.all([
      writeFile(join(fixture.release, "manifest.json"), manifestBytes),
      writeFile(
        join(fixture.release, "manifest.sig"),
        sign(null, manifestBytes, createPrivateKey(fixturePrivateKey)),
      ),
    ]);
    const candidateKeyPath = join(fixture.release, "release-public.pem");
    let candidateKeyReads = 0;
    const verificationIO = {
      async readFile(path: string): Promise<Buffer> {
        if (path === candidateKeyPath) {
          candidateKeyReads += 1;
          return Buffer.from(
            candidateKeyReads === 1
              ? fixture.publicKeyPem
              : replacementPublicKey,
          );
        }
        return readFile(path);
      },
    };

    await expect(
      verifyReleaseDirectory(fixture.release, undefined, verificationIO),
    ).rejects.toThrow("Signed checksum mismatch for release-public.pem");
    expect(candidateKeyReads).toBe(1);
  });

  it("returns the hash-bound candidate identity when an external key verifies the signature", async () => {
    const fixture = await createCrossSignedFixture();

    const verified = await verifyReleaseDirectory(
      fixture.release,
      fixture.verificationPublicKeyPath,
    );

    expect(verified.publicKeyPem).toBe(fixture.publicKeyPem);
    expect(verified.publicKeyPem).not.toBe(fixture.verificationPublicKeyPem);
    const installer = renderInstaller({
      manifestUrl: "https://argus.gpsxtre.me/releases/stable/manifest.json",
      publicKeyPem: verified.publicKeyPem,
    });
    expect(installer).toContain(fixture.publicKeyPem);
    expect(installer).not.toContain(fixture.verificationPublicKeyPem);
  });

  it.each([
    ["a bad signature", async (fixture: FixtureRelease) => {
      await writeFile(join(fixture.release, "manifest.sig"), "invalid");
    }],
    ["a mismatched wrapper checksum", async (fixture: FixtureRelease) => {
      await writeFile(join(fixture.release, "argus"), "#!/bin/sh\nexit 1\n");
    }],
    ["a missing signed asset", async (fixture: FixtureRelease) => {
      await rm(join(fixture.release, "fxembed.js"));
    }],
    ["a mismatched release public key", async (fixture: FixtureRelease) => {
      await writeFile(
        join(fixture.release, "release-public.pem"),
        "-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----\n",
      );
    }],
  ])("leaves every stable bundle byte untouched for %s", async (_label, corrupt) => {
    const fixture = await createFixtureRelease();
    const prior = await stableBytes(fixture.stable);
    await corrupt(fixture);

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).rejects.toThrow();

    await expect(stableBytes(fixture.stable)).resolves.toEqual(prior);
  });

  it("restores the complete prior bundle when the staging swap fails", async () => {
    const fixture = await createFixtureRelease();
    const prior = await stableBytes(fixture.stable);
    const nodeIO = createStableBundleIO();
    const failingIO = createStableBundleIO({
      rename: async (from, to) => {
        if (from.includes(".staging-") && to === fixture.stable) {
          throw new Error("injected staging promotion failure");
        }
        await nodeIO.rename(from, to);
      },
    });

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        io: failingIO,
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).rejects.toThrow("injected staging promotion failure");

    await expect(stableBytes(fixture.stable)).resolves.toEqual(prior);
  });

  it("retains the prior bundle as recovery evidence when restoration cannot be synced", async () => {
    const fixture = await createFixtureRelease();
    const prior = await stableBytes(fixture.stable);
    const nodeIO = createStableBundleIO();
    const failingIO = createStableBundleIO({
      syncDirectory: async (directory) => {
        if (directory === dirname(fixture.stable)) {
          throw new Error("injected parent sync failure");
        }
        await nodeIO.syncDirectory(directory);
      },
    });

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        io: failingIO,
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).rejects.toThrow("injected parent sync failure");

    const recovery = (await readdir(fixture.root)).find((entry) =>
      entry.startsWith(".stable.backup-"),
    );
    expect(recovery).toBeDefined();
    await expect(stableBytes(join(fixture.root, recovery ?? "missing"))).resolves.toEqual(
      prior,
    );
  });

  it("never replaces a published complete bundle with a partially deleted backup", async () => {
    const fixture = await createFixtureRelease();
    const nodeIO = createStableBundleIO();
    const failingIO = createStableBundleIO({
      removeDirectory: async (directory) => {
        if (directory.includes(".stable.backup-")) {
          await rm(join(directory, "manifest.json"));
          throw new Error("injected partial backup cleanup failure");
        }
        await nodeIO.removeDirectory(directory);
      },
    });

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        io: failingIO,
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).rejects.toThrow("injected partial backup cleanup failure");

    const stable = await stableBytes(fixture.stable);
    expect(stable["manifest.json"]).toEqual(fixture.manifest);
    expect(stable["manifest.sig"]).toEqual(fixture.signature);
    expect(stable["install.sh"].toString("utf8")).toContain(
      "https://argus.gpsxtre.me/releases/stable/manifest.json",
    );
  });

  it("keeps the already published bundle complete when backup-removal durability cannot be proven", async () => {
    const fixture = await createFixtureRelease();
    const nodeIO = createStableBundleIO();
    let parentSyncs = 0;
    const failingIO = createStableBundleIO({
      syncDirectory: async (directory) => {
        if (directory === dirname(fixture.stable)) {
          parentSyncs += 1;
          if (parentSyncs === 2) {
            throw new Error("injected final parent sync failure");
          }
        }
        await nodeIO.syncDirectory(directory);
      },
    });

    await expect(
      promoteStableBundle(fixture.release, fixture.stable, {
        io: failingIO,
        trustedPublicKeyPem: fixture.publicKeyPem,
      }),
    ).rejects.toThrow("injected final parent sync failure");

    const stable = await stableBytes(fixture.stable);
    expect(stable["manifest.json"]).toEqual(fixture.manifest);
    expect(stable["manifest.sig"]).toEqual(fixture.signature);
    expect(stable["install.sh"].toString("utf8")).toContain(
      "https://argus.gpsxtre.me/releases/stable/manifest.json",
    );
  });
});

describe("verify-manifest CLI", () => {
  it("verifies arbitrary explicit manifest and signature paths", async () => {
    const fixture = await createFixtureRelease();
    const manifestPath = join(fixture.release, "candidate-release.json");
    const signaturePath = join(fixture.release, "candidate-release.ed25519");
    await Promise.all([
      writeFile(manifestPath, fixture.manifest),
      writeFile(signaturePath, fixture.signature),
    ]);

    const result = spawnSync(
      process.execPath,
      [tsxCli, verifyManifestCli, manifestPath, signaturePath],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `1.2.3 ${digest(fixture.manifest)}\n`,
    });
  });

  it("uses a distinct explicit public key only as the signature trust anchor", async () => {
    const fixture = await createCrossSignedFixture();
    const withOverride = spawnSync(
      process.execPath,
      [
        tsxCli,
        verifyManifestCli,
        join(fixture.release, "manifest.json"),
        join(fixture.release, "manifest.sig"),
        fixture.verificationPublicKeyPath,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const withoutOverride = spawnSync(
      process.execPath,
      [
        tsxCli,
        verifyManifestCli,
        join(fixture.release, "manifest.json"),
        join(fixture.release, "manifest.sig"),
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(withOverride).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `1.2.3 ${digest(fixture.manifest)}\n`,
    });
    expect(withoutOverride.status).not.toBe(0);
    expect(withoutOverride.stderr).toContain(
      "Release manifest signature is invalid",
    );
  });
});
