import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildReleaseArtifacts,
  managementStateForRelease,
  renderArgusWrapper,
  type ReleaseImageInput,
  verifyReleaseManifestWithIdentity,
} from "../src/index.js";

const fixturePrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGJqC73Ezwmnx3FFQ5W1czmiNwXmLFn2Xso+6xXKPXKf
-----END PRIVATE KEY-----`;
const sha = (character: string): string => character.repeat(64);
const image = (
  name: ReleaseImageInput["name"],
  repository: string,
  character: string,
): ReleaseImageInput => ({
  name,
  reference: `${repository}@sha256:${sha(character)}`,
});

const input = (version = "1.2.3", cliDigest = "b") => ({
  version,
  sourceDateEpoch: "1785580200",
  images: [
    image("app", "ghcr.io/gpsxtreme/argus", "a"),
    image("cli", "ghcr.io/gpsxtreme/argus-cli", cliDigest),
    image("searxng", "docker.io/searxng/searxng", "c"),
    image("postgres", "docker.io/library/postgres", "d"),
  ],
  fxembed: {
    bytes: Buffer.from("export default { fetch() {} };\n"),
    url: `https://github.com/gpsxtreme/argus/releases/download/v${version}/fxembed.js`,
    compatibilityDate: "2026-04-11",
  },
  wrapper: {
    bytes: Buffer.from("#!/bin/sh\nexec true\n"),
    url: `https://github.com/gpsxtreme/argus/releases/download/v${version}/argus`,
  },
  installer: {
    bytes: Buffer.from("#!/bin/sh\n# installer\n"),
    url: `https://github.com/gpsxtreme/argus/releases/download/v${version}/install.sh`,
  },
  publicKeyUrl:
    `https://github.com/gpsxtreme/argus/releases/download/v${version}/release-public.pem`,
  fxembedLicense: {
    bytes: Buffer.from("MIT\n"),
    url: `https://github.com/gpsxtreme/argus/releases/download/v${version}/FXEMBED-LICENSE.md`,
  },
  fxembedProvenance: {
    bytes: Buffer.from('{"revision":"fixture"}\n'),
    url: `https://github.com/gpsxtreme/argus/releases/download/v${version}/fxembed-provenance.json`,
  },
  privateKeyPem: fixturePrivateKey,
});

describe("release manifest builder", () => {
  it("emits deterministic canonical bytes and a valid detached Ed25519 signature", () => {
    const built = buildReleaseArtifacts(input());
    const manifestText = Buffer.from(built.manifestBytes).toString("utf8");
    const manifest = JSON.parse(manifestText) as {
      version: string;
      assets: Record<string, { sha256: string }>;
    };
    const hash = (bytes: Uint8Array): string =>
      createHash("sha256").update(bytes).digest("hex");
    expect(Buffer.from(buildReleaseArtifacts(input()).manifestBytes).toString("utf8")).toBe(
      manifestText,
    );
    expect(manifest.version).toBe("1.2.3");
    expect(Object.keys(manifest.assets)).toEqual([
      "fxembed",
      "wrapper",
      "installer",
      "publicKey",
      "fxembedLicense",
      "fxembedProvenance",
    ]);
    expect(manifest.assets.installer?.sha256).toBe(hash(input().installer.bytes));
    expect(manifest.assets.fxembed?.sha256).toBe(hash(input().fxembed.bytes));
    expect(manifest.assets.wrapper?.sha256).toBe(hash(input().wrapper.bytes));
    expect(manifest.assets.publicKey?.sha256).toBe(
      hash(Buffer.from(built.publicKeyPem)),
    );
    expect(manifest.assets.fxembedLicense?.sha256).toBe(hash(input().fxembedLicense.bytes));
    expect(manifest.assets.fxembedProvenance?.sha256).toBe(
      hash(input().fxembedProvenance.bytes),
    );
    expect(built.signature).toHaveLength(64);
    expect(
      verify(
        null,
        built.manifestBytes,
        createPublicKey(built.publicKeyPem),
        built.signature,
      ),
    ).toBe(true);
  });

  it("keeps immutable wrapper bytes across releases while signing distinct state", () => {
    const firstWrapper = Buffer.from(renderArgusWrapper());
    const secondWrapper = Buffer.from(renderArgusWrapper());
    const first = buildReleaseArtifacts({
      ...input("1.2.3", "b"),
      wrapper: {
        bytes: firstWrapper,
        url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/argus",
      },
    });
    const second = buildReleaseArtifacts({
      ...input("1.2.4", "e"),
      wrapper: {
        bytes: secondWrapper,
        url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.4/argus",
      },
    });

    const wrapperSha256 = (bytes: Uint8Array): string =>
      createHash("sha256").update(bytes).digest("hex");
    const firstVerified = verifyReleaseManifestWithIdentity(
      first.manifestBytes,
      first.signature,
      first.publicKeyPem,
    );
    const secondVerified = verifyReleaseManifestWithIdentity(
      second.manifestBytes,
      second.signature,
      second.publicKeyPem,
    );

    expect(firstWrapper).toEqual(secondWrapper);
    expect(wrapperSha256(firstWrapper)).toBe(wrapperSha256(secondWrapper));
    expect(firstVerified.manifest.assets.wrapper.sha256).toBe(
      secondVerified.manifest.assets.wrapper.sha256,
    );
    expect(first.manifestBytes).not.toEqual(second.manifestBytes);
    expect(first.signature).not.toEqual(second.signature);
    const firstState = managementStateForRelease(firstVerified);
    const secondState = managementStateForRelease(secondVerified);
    expect(firstState).toEqual({
      schema: 1,
      version: "1.2.3",
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${sha("b")}`,
    });
    expect(secondState).toEqual({
      schema: 1,
      version: "1.2.4",
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${sha("e")}`,
    });
    expect(firstState).not.toEqual(secondState);
  });

  it("rejects duplicate image tags before producing release bytes", () => {
    const duplicated = input();
    duplicated.images = [
      ...duplicated.images,
      image("app", "ghcr.io/gpsxtreme/other", "e"),
    ];

    expect(() => buildReleaseArtifacts(duplicated)).toThrow(
      "Duplicate release image tag: app",
    );
  });

  it("rejects mutable image tags before producing release bytes", () => {
    const mutable = input();
    mutable.images = [
      { name: "app", reference: "ghcr.io/gpsxtreme/argus:1.2.3" },
      ...mutable.images.slice(1),
    ];

    expect(() => buildReleaseArtifacts(mutable)).toThrow(
      "Release image app must be a digest-pinned OCI reference.",
    );
  });

  it("rejects SemVer build metadata that cannot form an injective OCI tag", () => {
    expect(() =>
      buildReleaseArtifacts({ ...input(), version: "1.2.3+build.1" }),
    ).toThrow("build metadata");
  });

  it("rejects an asset URL that is not bound to the release version", () => {
    const mismatched = input();
    mismatched.installer.url =
      "https://github.com/gpsxtreme/argus/releases/download/v1.2.4/install.sh";
    expect(() => buildReleaseArtifacts(mismatched)).toThrow("bound to the release version");
  });

  it("reserves a same-tag release before any mutable publish step", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const reservation = workflow.indexOf(
      "name: Reserve immutable GitHub Release",
    );
    const firstImagePush = workflow.indexOf(
      "name: Build and push application image",
    );

    expect(reservation).toBeGreaterThan(0);
    expect(reservation).toBeLessThan(firstImagePush);
    expect(workflow).toContain(
      'gh release create "$GITHUB_REF_NAME" --draft --title "$GITHUB_REF_NAME"',
    );
    expect(workflow).toContain("draft: false");
  });

  it("semantically pins the release workflow and covers every published asset", () => {
    const workflowText = readFileSync(
      new URL("../../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const workflow = parse(workflowText) as {
      jobs: { release: { "runs-on": string; steps: Array<Record<string, unknown>> } };
    };
    expect(workflow.jobs.release["runs-on"]).toBe("ubuntu-24.04");
    const steps = workflow.jobs.release.steps;
    for (const step of steps) {
      if (typeof step.uses === "string") {
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
      }
    }
    const buildStep = steps.find((step) => step.name === "Build and verify signed assets");
    expect(String(buildStep?.run)).toContain("--fxembed-license dist/release/FXEMBED-LICENSE.md");
    expect(String(buildStep?.run)).toContain(
      "--fxembed-provenance dist/release/fxembed-provenance.json",
    );
    const publishStep = steps.find((step) => step.name === "Publish immutable GitHub Release");
    const files = String((publishStep?.with as { files?: string } | undefined)?.files)
      .trim()
      .split("\n");
    expect(files).toEqual([
      "dist/release/manifest.json",
      "dist/release/manifest.sig",
      "dist/release/release-public.pem",
      "dist/release/install.sh",
      "dist/release/argus",
      "dist/release/fxembed.js",
      "dist/release/FXEMBED-LICENSE.md",
      "dist/release/fxembed-provenance.json",
    ]);
  });
});
