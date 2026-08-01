import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { isPinnedImageReference } from "@argus/contracts";
import {
  type ReleaseManifestV1,
  serializeReleaseManifestCanonical,
} from "./manifest.js";

export type ReleaseImageName = "app" | "cli" | "searxng" | "postgres";

export interface ReleaseImageInput {
  name: ReleaseImageName;
  reference: string;
}

export interface BuildReleaseArtifactsInput {
  version: string;
  sourceDateEpoch: string;
  images: ReleaseImageInput[];
  fxembed: {
    bytes: Uint8Array;
    url: string;
    compatibilityDate: string;
  };
  wrapper: {
    bytes: Uint8Array;
    url: string;
  };
  privateKeyPem: string;
}

export interface BuiltReleaseArtifacts {
  manifestBytes: Uint8Array;
  signature: Uint8Array;
  publicKeyPem: string;
}

const imageNames = ["app", "cli", "searxng", "postgres"] as const;

const digestOf = (reference: string): `sha256:${string}` =>
  reference.slice(reference.lastIndexOf("@") + 1) as `sha256:${string}`;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const publishedAt = (sourceDateEpoch: string): string => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(sourceDateEpoch)) {
    throw new TypeError("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  const epoch = Number(sourceDateEpoch);
  if (!Number.isSafeInteger(epoch)) {
    throw new TypeError("SOURCE_DATE_EPOCH must be a safe integer.");
  }
  const timestamp = new Date(epoch * 1_000);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("SOURCE_DATE_EPOCH is outside the supported date range.");
  }
  return timestamp.toISOString();
};

const releaseImages = (
  inputs: readonly ReleaseImageInput[],
): ReleaseManifestV1["images"] => {
  const selected = new Map<ReleaseImageName, string>();
  for (const input of inputs) {
    if (selected.has(input.name)) {
      throw new TypeError(`Duplicate release image tag: ${input.name}`);
    }
    if (!isPinnedImageReference(input.reference)) {
      throw new TypeError(
        `Release image ${input.name} must be a digest-pinned OCI reference.`,
      );
    }
    selected.set(input.name, input.reference);
  }
  for (const name of imageNames) {
    if (!selected.has(name)) {
      throw new TypeError(`Missing release image tag: ${name}`);
    }
  }
  if (selected.size !== imageNames.length) {
    throw new TypeError("Release image tags do not match the V1 contract.");
  }
  const entry = (name: ReleaseImageName) => {
    const reference = selected.get(name);
    if (reference === undefined) throw new TypeError(`Missing release image tag: ${name}`);
    return { reference, digest: digestOf(reference) };
  };
  return {
    app: entry("app"),
    cli: entry("cli"),
    searxng: entry("searxng"),
    postgres: entry("postgres"),
  };
};

export const buildReleaseArtifacts = (
  input: BuildReleaseArtifactsInput,
): BuiltReleaseArtifacts => {
  if (input.version.includes("+")) {
    throw new TypeError("Release versions with build metadata cannot be published as OCI tags.");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError("wrong key type");
    }
  } catch {
    throw new TypeError(
      "Release signing key must be an Ed25519 PKCS8 PEM private key.",
    );
  }

  const manifest: ReleaseManifestV1 = {
    schemaVersion: 1,
    version: input.version,
    publishedAt: publishedAt(input.sourceDateEpoch),
    images: releaseImages(input.images),
    assets: {
      fxembed: {
        url: input.fxembed.url,
        sha256: sha256(input.fxembed.bytes),
        compatibilityDate: input.fxembed.compatibilityDate,
      },
      wrapper: {
        url: input.wrapper.url,
        sha256: sha256(input.wrapper.bytes),
      },
    },
    minimumStateSchema: 1,
  };
  const manifestBytes = serializeReleaseManifestCanonical(manifest);
  const signature = sign(null, manifestBytes, privateKey);
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return { manifestBytes, signature, publicKeyPem };
};
