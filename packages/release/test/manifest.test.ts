import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_RELEASE_MANIFEST_BYTES,
  ReleaseManifestError,
  releaseManifestSha256,
  serializeReleaseManifestCanonical,
  verifyReleaseManifest,
  verifyReleaseManifestWithIdentity,
} from "../src/index.js";

const sha = (character: string): string => character.repeat(64);

const validManifest = {
  schemaVersion: 1,
  version: "1.2.3",
  publishedAt: "2026-08-01T10:30:00.000Z",
  images: {
    app: {
      reference: `ghcr.io/gpsxtreme/argus@sha256:${sha("a")}`,
      digest: `sha256:${sha("a")}`,
    },
    cli: {
      reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${sha("b")}`,
      digest: `sha256:${sha("b")}`,
    },
    searxng: {
      reference: `docker.io/searxng/searxng@sha256:${sha("c")}`,
      digest: `sha256:${sha("c")}`,
    },
    postgres: {
      reference: `docker.io/library/postgres@sha256:${sha("d")}`,
      digest: `sha256:${sha("d")}`,
    },
  },
  assets: {
    fxembed: {
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/fxembed.js",
      sha256: sha("e"),
      compatibilityDate: "2026-08-01",
    },
    wrapper: {
      url: "https://github.com/gpsxtreme/argus/releases/download/v1.2.3/argus",
      sha256: sha("f"),
    },
  },
  minimumStateSchema: 1,
} as const;

const keys = () => generateKeyPairSync("ed25519");
const bytesOf = (value: unknown): Uint8Array =>
  Buffer.from(JSON.stringify(value), "utf8");
const signatureOf = (bytes: Uint8Array, privateKey: KeyObject): Uint8Array =>
  sign(null, bytes, privateKey);
const publicPem = (publicKey: KeyObject): string =>
  publicKey.export({ type: "spki", format: "pem" }).toString();

const expectCode = (
  operation: () => unknown,
  code: string,
): void => {
  try {
    operation();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseManifestError);
    expect((error as ReleaseManifestError).code).toBe(code);
  }
};

describe("verifyReleaseManifest", () => {
  it("verifies exact served bytes and returns a strict versioned manifest", () => {
    const { privateKey, publicKey } = keys();
    const bytes = bytesOf(validManifest);

    expect(
      verifyReleaseManifest(bytes, signatureOf(bytes, privateKey), publicPem(publicKey)),
    ).toEqual(validManifest);
  });

  it.each([
    "0.0.0",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3-1alpha",
    "1.2.3+build.001",
    "1.2.3-rc.1+build.20260801",
  ])("accepts normalized SemVer 2.0 release version %s", (version) => {
    const { privateKey, publicKey } = keys();
    const bytes = bytesOf({ ...validManifest, version });

    expect(
      verifyReleaseManifest(bytes, signatureOf(bytes, privateKey), publicPem(publicKey)),
    ).toMatchObject({ version });
  });

  it("rejects a changed byte and a wrong key before parsing", () => {
    const signer = keys();
    const other = keys();
    const bytes = bytesOf(validManifest);
    const signature = signatureOf(bytes, signer.privateKey);
    const tampered = Uint8Array.from(bytes);
    const changedIndex = tampered.length - 2;
    tampered[changedIndex] = (tampered[changedIndex] ?? 0) ^ 1;

    expectCode(
      () => verifyReleaseManifest(tampered, signature, publicPem(signer.publicKey)),
      "RELEASE_SIGNATURE_INVALID",
    );
    expectCode(
      () => verifyReleaseManifest(bytes, signature, publicPem(other.publicKey)),
      "RELEASE_SIGNATURE_INVALID",
    );
  });

  it("signs whitespace as part of the exact manifest identity", () => {
    const { privateKey, publicKey } = keys();
    const compact = bytesOf(validManifest);
    const spaced = Buffer.from(`\n${JSON.stringify(validManifest, null, 2)}\n`);
    const compactSignature = signatureOf(compact, privateKey);

    expectCode(
      () => verifyReleaseManifest(spaced, compactSignature, publicPem(publicKey)),
      "RELEASE_SIGNATURE_INVALID",
    );
    expectCode(
      () =>
        verifyReleaseManifest(
          spaced,
          signatureOf(spaced, privateKey),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_NON_CANONICAL",
    );
  });

  it("serializes one exact canonical byte contract and rejects URL whitespace", () => {
    expect(Buffer.from(serializeReleaseManifestCanonical(validManifest)).toString("utf8"))
      .toBe(JSON.stringify(validManifest));
    expectCode(
      () =>
        serializeReleaseManifestCanonical({
          ...validManifest,
          assets: {
            ...validManifest.assets,
            wrapper: {
              ...validManifest.assets.wrapper,
              url: `  ${validManifest.assets.wrapper.url}  `,
            },
          },
        }),
      "RELEASE_MANIFEST_SCHEMA_INVALID",
    );
  });

  it.each([
    "https://example.com",
    "https://example.com/",
    "https://example.com:0/argus",
    "https://example.com:65536/argus",
    "https://singlelabel/argus",
    "https://-bad.example/argus",
    "https://bad-.example/argus",
    "https://example.com/argus path",
  ])("rejects shell-unsafe release asset URL %s", (url) => {
    const { privateKey, publicKey } = keys();
    const bytes = bytesOf({
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: { ...validManifest.assets.wrapper, url },
      },
    });
    expectCode(
      () => verifyReleaseManifest(bytes, signatureOf(bytes, privateKey), publicPem(publicKey)),
      "RELEASE_MANIFEST_SCHEMA_INVALID",
    );
  });

  it.each([
    Buffer.from(` ${JSON.stringify(validManifest)}`),
    Buffer.from(`${JSON.stringify(validManifest)}\n`),
    Buffer.from(`\uFEFF${JSON.stringify(validManifest)}`),
    Buffer.from(
      JSON.stringify(
        (({ version, ...rest }) => ({ version, ...rest }))(validManifest),
      ),
    ),
  ])("rejects signed noncanonical byte variants", (bytes) => {
    const { privateKey, publicKey } = keys();
    expectCode(
      () => verifyReleaseManifest(bytes, signatureOf(bytes, privateKey), publicPem(publicKey)),
      "RELEASE_MANIFEST_NON_CANONICAL",
    );
  });

  it("only reports invalid JSON after the invalid bytes have a valid signature", () => {
    const { privateKey, publicKey } = keys();
    const invalidJson = Buffer.from("{");
    const wrongSignature = signatureOf(bytesOf(validManifest), privateKey);

    expectCode(
      () => verifyReleaseManifest(invalidJson, wrongSignature, publicPem(publicKey)),
      "RELEASE_SIGNATURE_INVALID",
    );
    expectCode(
      () =>
        verifyReleaseManifest(
          invalidJson,
          signatureOf(invalidJson, privateKey),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_JSON_INVALID",
    );
  });

  it.each([
    ["short signature", new Uint8Array(63), publicPem(keys().publicKey)],
    ["long signature", new Uint8Array(65), publicPem(keys().publicKey)],
  ])("stably rejects an invalid %s", (_label, signature, pem) => {
    expectCode(
      () => verifyReleaseManifest(bytesOf(validManifest), signature, pem),
      "RELEASE_SIGNATURE_INVALID",
    );
  });

  it.each([
    "",
    "not a key",
    publicPem(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey),
  ])(
    "stably rejects an invalid Ed25519 public key",
    (pem) => {
      expectCode(
        () =>
          verifyReleaseManifest(
            bytesOf(validManifest),
            new Uint8Array(64),
            pem,
          ),
        "RELEASE_PUBLIC_KEY_INVALID",
      );
    },
  );

  it("rejects manifests over the finite input size bound", () => {
    const { publicKey } = keys();
    expectCode(
      () =>
        verifyReleaseManifest(
          new Uint8Array(MAX_RELEASE_MANIFEST_BYTES + 1),
          new Uint8Array(64),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_TOO_LARGE",
    );
  });

  it.each([
    ["unknown root field", { ...validManifest, surprise: true }],
    ["unknown nested field", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: { ...validManifest.assets.wrapper, surprise: true },
      },
    }],
    ["unsupported schema", { ...validManifest, schemaVersion: 2 }],
    ["unsupported minimum state schema", {
      ...validManifest,
      minimumStateSchema: 2,
    }],
    ["non-normalized version", { ...validManifest, version: "v1.2.3" }],
    ["leading-zero version", { ...validManifest, version: "01.2.3" }],
    ["leading-zero prerelease identifier", {
      ...validManifest,
      version: "1.2.3-alpha.01",
    }],
    ["empty build identifier", { ...validManifest, version: "1.2.3+build..1" }],
    ["impossible timestamp", {
      ...validManifest,
      publishedAt: "2026-02-30T10:30:00.000Z",
    }],
    ["non-canonical timestamp", {
      ...validManifest,
      publishedAt: "2026-08-01T10:30:00Z",
    }],
    ["impossible compatibility date", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        fxembed: {
          ...validManifest.assets.fxembed,
          compatibilityDate: "2026-02-30",
        },
      },
    }],
    ["non-HTTPS asset URL", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: { ...validManifest.assets.wrapper, url: "http://example.com/argus" },
      },
    }],
    ["asset URL userinfo", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://user:secret@example.com/argus",
        },
      },
    }],
    ["asset URL query credential", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus?token=secret",
        },
      },
    }],
    ["asset URL access_token", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus?access_token=secret",
        },
      },
    }],
    ["asset URL client_secret", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus?client_secret=secret",
        },
      },
    }],
    ["asset URL private_token", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus?private_token=secret",
        },
      },
    }],
    ["asset URL AWS signature", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus?X-Amz-Signature=secret",
        },
      },
    }],
    ["asset URL innocuous query", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus?download=1",
        },
      },
    }],
    ["asset URL fragment", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus#download",
        },
      },
    }],
    ["asset URL empty query", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus?",
        },
      },
    }],
    ["asset URL empty fragment", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: {
          ...validManifest.assets.wrapper,
          url: "https://example.com/argus#",
        },
      },
    }],
    ["uppercase asset digest", {
      ...validManifest,
      assets: {
        ...validManifest.assets,
        wrapper: { ...validManifest.assets.wrapper, sha256: sha("A") },
      },
    }],
    ["short image digest", {
      ...validManifest,
      images: {
        ...validManifest.images,
        app: { ...validManifest.images.app, digest: "sha256:abc" },
      },
    }],
    ["tagged image reference", {
      ...validManifest,
      images: {
        ...validManifest.images,
        app: {
          ...validManifest.images.app,
          reference: "ghcr.io/gpsxtreme/argus:1.2.3",
        },
      },
    }],
    ["credentialed image reference", {
      ...validManifest,
      images: {
        ...validManifest.images,
        app: {
          ...validManifest.images.app,
          reference: `user:secret@ghcr.io/gpsxtreme/argus@sha256:${sha("a")}`,
        },
      },
    }],
    ["mismatched reference and digest", {
      ...validManifest,
      images: {
        ...validManifest.images,
        app: {
          ...validManifest.images.app,
          digest: `sha256:${sha("b")}`,
        },
      },
    }],
  ])("rejects invalid schema: %s", (_label, manifest) => {
    const { privateKey, publicKey } = keys();
    const bytes = bytesOf(manifest);
    expectCode(
      () =>
        verifyReleaseManifest(
          bytes,
          signatureOf(bytes, privateKey),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_SCHEMA_INVALID",
    );
  });

  it("exposes the exact signed-byte SHA-256 identity", () => {
    const { privateKey, publicKey } = keys();
    const bytes = serializeReleaseManifestCanonical(validManifest);
    const expected = createHash("sha256").update(bytes).digest("hex");

    expect(releaseManifestSha256(bytes)).toBe(expected);
    expect(
      verifyReleaseManifestWithIdentity(
        bytes,
        signatureOf(bytes, privateKey),
        publicPem(publicKey),
      ),
    ).toEqual({
      manifest: validManifest,
      manifestSha256: expected,
    });
  });

  it.each([
    [
      "duplicate root key",
      `{"schemaVersion":1,"schemaVersion":1}`,
    ],
    [
      "duplicate nested key",
      `{"schemaVersion":1,"nested":{"value":1,"value":2}}`,
    ],
    [
      "escaped-equivalent key",
      `{"schemaVersion":1,"nested":{"a":1,"\\u0061":2}}`,
    ],
  ])("rejects %s before JSON.parse can overwrite data", (_label, json) => {
    const { privateKey, publicKey } = keys();
    const bytes = Buffer.from(json);

    expectCode(
      () =>
        verifyReleaseManifest(
          bytes,
          signatureOf(bytes, privateKey),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_INVALID",
    );
  });

  it("allows the same key in different JSON objects", () => {
    const { privateKey, publicKey } = keys();
    const manifest = {
      ...validManifest,
      images: {
        ...validManifest.images,
        app: { ...validManifest.images.app },
        cli: { ...validManifest.images.cli },
      },
    };
    const bytes = bytesOf(manifest);

    expect(
      verifyReleaseManifest(bytes, signatureOf(bytes, privateKey), publicPem(publicKey)),
    ).toEqual(manifest);
  });

  it("accepts complete JSON string, number, literal, object, and array grammar before schema validation", () => {
    const { privateKey, publicKey } = keys();
    const json =
      String.raw`{"strings":["quote:\"","slash:\\","solidus:\/","unicode:\u0061"],` +
      `"numbers":[0,-0,12,-12,1.5,1e3,-2.5E-2],` +
      `"values":[true,false,null,{},[]]}`;
    const bytes = Buffer.from(json);

    expectCode(
      () =>
        verifyReleaseManifest(
          bytes,
          signatureOf(bytes, privateKey),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_SCHEMA_INVALID",
    );
  });

  it.each([
    `{"value":01}`,
    `{"value":1.}`,
    `{"value":1e}`,
    `{"value":NaN}`,
    `{"value":"\\x20"}`,
    `{"value":[1,]}`,
    `{"value":true} trailing`,
  ])("rejects malformed signed JSON grammar: %s", (json) => {
    const { privateKey, publicKey } = keys();
    const bytes = Buffer.from(json);

    expectCode(
      () =>
        verifyReleaseManifest(
          bytes,
          signatureOf(bytes, privateKey),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_JSON_INVALID",
    );
  });

  it("fatally rejects signed invalid UTF-8", () => {
    const { privateKey, publicKey } = keys();
    const bytes = Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);

    expectCode(
      () =>
        verifyReleaseManifest(
          bytes,
          signatureOf(bytes, privateKey),
          publicPem(publicKey),
        ),
      "RELEASE_MANIFEST_JSON_INVALID",
    );
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "strictly rejects prototype-like key %s without mutating prototypes",
    (key) => {
      const { privateKey, publicKey } = keys();
      const json = JSON.stringify({ ...validManifest, [key]: { polluted: true } });
      const bytes = Buffer.from(json);

      expectCode(
        () =>
          verifyReleaseManifest(
            bytes,
            signatureOf(bytes, privateKey),
            publicPem(publicKey),
          ),
        "RELEASE_MANIFEST_SCHEMA_INVALID",
      );
      expect(Object.prototype).not.toHaveProperty("polluted");
    },
  );
});
