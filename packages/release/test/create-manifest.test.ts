import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildReleaseArtifacts,
  type ReleaseImageInput,
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

const input = () => ({
  version: "1.2.3",
  sourceDateEpoch: "1785580200",
  images: [
    image("app", "ghcr.io/gpsxtreme/argus", "a"),
    image("cli", "ghcr.io/gpsxtreme/argus-cli", "b"),
    image("searxng", "docker.io/searxng/searxng", "c"),
    image("postgres", "docker.io/library/postgres", "d"),
  ],
  fxembed: {
    bytes: Buffer.from("export default { fetch() {} };\n"),
    url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/fxembed.js",
    compatibilityDate: "2026-04-11",
  },
  wrapper: {
    bytes: Buffer.from("#!/bin/sh\nexec true\n"),
    url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/argus",
  },
  privateKeyPem: fixturePrivateKey,
});

describe("release manifest builder", () => {
  it("emits deterministic canonical bytes and a valid detached Ed25519 signature", () => {
    const built = buildReleaseArtifacts(input());
    const fxembedHash = createHash("sha256")
      .update(input().fxembed.bytes)
      .digest("hex");
    const wrapperHash = createHash("sha256")
      .update(input().wrapper.bytes)
      .digest("hex");

    expect(Buffer.from(built.manifestBytes).toString("utf8")).toBe(
      `{"schemaVersion":1,"version":"1.2.3","publishedAt":"2026-08-01T10:30:00.000Z","images":{"app":{"reference":"ghcr.io/gpsxtreme/argus@sha256:${sha("a")}","digest":"sha256:${sha("a")}"},"cli":{"reference":"ghcr.io/gpsxtreme/argus-cli@sha256:${sha("b")}","digest":"sha256:${sha("b")}"},"searxng":{"reference":"docker.io/searxng/searxng@sha256:${sha("c")}","digest":"sha256:${sha("c")}"},"postgres":{"reference":"docker.io/library/postgres@sha256:${sha("d")}","digest":"sha256:${sha("d")}"}},"assets":{"fxembed":{"url":"https://github.com/gpsxtreme/argus/releases/download/v1.2.3/fxembed.js","sha256":"${fxembedHash}","compatibilityDate":"2026-04-11"},"wrapper":{"url":"https://github.com/gpsxtreme/argus/releases/download/v1.2.3/argus","sha256":"${wrapperHash}"}},"minimumStateSchema":1}`,
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
});
