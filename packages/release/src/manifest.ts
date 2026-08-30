import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import { isPinnedImageReference } from "@argus/contracts";
import { z } from "zod";
import {
  assertJsonObjectKeysUnique,
  DuplicateJsonKeyError,
  UnsafeJsonKeyError,
} from "./json.js";

export const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_PUBLIC_KEY_PEM_BYTES = 16 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const normalizedVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type ReleaseManifestErrorCode =
  | "RELEASE_MANIFEST_TOO_LARGE"
  | "RELEASE_PUBLIC_KEY_INVALID"
  | "RELEASE_SIGNATURE_INVALID"
  | "RELEASE_MANIFEST_INVALID"
  | "RELEASE_MANIFEST_JSON_INVALID"
  | "RELEASE_MANIFEST_SCHEMA_INVALID"
  | "RELEASE_MANIFEST_NON_CANONICAL";

export class ReleaseManifestError extends Error {
  readonly code: ReleaseManifestErrorCode;

  constructor(code: ReleaseManifestErrorCode, message: string) {
    super(message);
    this.name = "ReleaseManifestError";
    this.code = code;
  }
}

const isCanonicalTimestamp = (value: string): boolean => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
};

const releaseAssetUrlPattern =
  /^https:\/\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/([A-Za-z0-9._~%+-][A-Za-z0-9._~/%+-]*)$/;

/** Exact ASCII URL grammar shared with the dependency-free V1 installer. */
export const isSafeReleaseAssetUrl = (value: string): boolean => {
  if (!/^[\x20-\x7E]+$/.test(value)) return false;
  const match = releaseAssetUrlPattern.exec(value);
  if (match === null) return false;
  const labels = (match[1] ?? "").split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  ) {
    return false;
  }
  const port = match[2];
  return (
    port === undefined ||
    (/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65_535)
  );
};

const imageSchema = z
  .object({
    reference: z
      .string()
      .refine(
        isPinnedImageReference,
        "Expected a credential-free digest-pinned OCI image reference",
      ),
    digest: z.string().regex(digestPattern),
  })
  .strict()
  .superRefine((image, context) => {
    if (!image.reference.endsWith(`@${image.digest}`)) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "Image reference and digest must identify the same OCI manifest",
      });
    }
  });

const assetUrlSchema = z
  .string()
  .refine(
    isSafeReleaseAssetUrl,
    "Expected a shell-safe HTTPS release asset URL",
  );
const sha256Schema = z.string().regex(sha256Pattern);

const releaseManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(normalizedVersionPattern),
    publishedAt: z
      .string()
      .refine(isCanonicalTimestamp, "Expected a canonical, real ISO timestamp"),
    images: z
      .object({
        app: imageSchema,
        cli: imageSchema,
        searxng: imageSchema,
        postgres: imageSchema,
        fxembed: imageSchema,
      })
      .strict(),
    assets: z
      .object({
        fxembed: z
          .object({
            url: assetUrlSchema,
            sha256: sha256Schema,
            compatibilityDate: z
              .string()
              .refine(isCalendarDate, "Expected a real ISO calendar date"),
          })
          .strict(),
        wrapper: z
          .object({
            url: assetUrlSchema,
            sha256: sha256Schema,
          })
          .strict(),
        installer: z.object({ url: assetUrlSchema, sha256: sha256Schema }).strict(),
        publicKey: z.object({ url: assetUrlSchema, sha256: sha256Schema }).strict(),
        fxembedLicense: z.object({ url: assetUrlSchema, sha256: sha256Schema }).strict(),
        fxembedProvenance: z.object({ url: assetUrlSchema, sha256: sha256Schema }).strict(),
      })
      .strict(),
    minimumStateSchema: z.literal(1),
  })
  .strict();

export interface ReleaseManifestV1 {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  images: {
    app: { reference: string; digest: `sha256:${string}` };
    cli: { reference: string; digest: `sha256:${string}` };
    searxng: { reference: string; digest: `sha256:${string}` };
    postgres: { reference: string; digest: `sha256:${string}` };
    fxembed: { reference: string; digest: `sha256:${string}` };
  };
  assets: {
    fxembed: { url: string; sha256: string; compatibilityDate: string };
    wrapper: { url: string; sha256: string };
    installer: { url: string; sha256: string };
    publicKey: { url: string; sha256: string };
    fxembedLicense: { url: string; sha256: string };
    fxembedProvenance: { url: string; sha256: string };
  };
  minimumStateSchema: 1;
}

export interface VerifiedReleaseManifest {
  manifest: ReleaseManifestV1;
  /** Lowercase SHA-256 of the exact bytes that passed signature verification. */
  manifestSha256: string;
}

export function serializeReleaseManifestCanonical(
  manifest: ReleaseManifestV1,
): Uint8Array {
  const parsed = releaseManifestV1Schema.safeParse(manifest);
  if (!parsed.success) {
    throw new ReleaseManifestError(
      "RELEASE_MANIFEST_SCHEMA_INVALID",
      "Release manifest does not match the supported schema.",
    );
  }
  const value = parsed.data;
  return Buffer.from(
    JSON.stringify({
      schemaVersion: value.schemaVersion,
      version: value.version,
      publishedAt: value.publishedAt,
      images: {
        app: {
          reference: value.images.app.reference,
          digest: value.images.app.digest,
        },
        cli: {
          reference: value.images.cli.reference,
          digest: value.images.cli.digest,
        },
        searxng: {
          reference: value.images.searxng.reference,
          digest: value.images.searxng.digest,
        },
        postgres: {
          reference: value.images.postgres.reference,
          digest: value.images.postgres.digest,
        },
        fxembed: {
          reference: value.images.fxembed.reference,
          digest: value.images.fxembed.digest,
        },
      },
      assets: {
        fxembed: {
          url: value.assets.fxembed.url,
          sha256: value.assets.fxembed.sha256,
          compatibilityDate: value.assets.fxembed.compatibilityDate,
        },
        wrapper: {
          url: value.assets.wrapper.url,
          sha256: value.assets.wrapper.sha256,
        },
        installer: value.assets.installer,
        publicKey: value.assets.publicKey,
        fxembedLicense: value.assets.fxembedLicense,
        fxembedProvenance: value.assets.fxembedProvenance,
      },
      minimumStateSchema: value.minimumStateSchema,
    }),
    "utf8",
  );
}

export const releaseManifestSha256 = (manifestBytes: Uint8Array): string =>
  createHash("sha256").update(manifestBytes).digest("hex");

const parsePublicKey = (publicKeyPem: string): KeyObject => {
  if (
    publicKeyPem.length === 0 ||
    Buffer.byteLength(publicKeyPem, "utf8") > MAX_PUBLIC_KEY_PEM_BYTES
  ) {
    throw new ReleaseManifestError(
      "RELEASE_PUBLIC_KEY_INVALID",
      "Release verification public key is invalid.",
    );
  }

  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("Unexpected public key type");
    }
    return key;
  } catch {
    throw new ReleaseManifestError(
      "RELEASE_PUBLIC_KEY_INVALID",
      "Release verification public key is invalid.",
    );
  }
};

export function verifyReleaseManifestWithIdentity(
  manifestBytes: Uint8Array,
  signature: Uint8Array,
  publicKeyPem: string,
): VerifiedReleaseManifest {
  if (
    manifestBytes.byteLength === 0 ||
    manifestBytes.byteLength > MAX_RELEASE_MANIFEST_BYTES
  ) {
    throw new ReleaseManifestError(
      "RELEASE_MANIFEST_TOO_LARGE",
      "Release manifest is empty or exceeds the supported size.",
    );
  }
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new ReleaseManifestError(
      "RELEASE_SIGNATURE_INVALID",
      "Release manifest signature is invalid.",
    );
  }

  const publicKey = parsePublicKey(publicKeyPem);
  let validSignature = false;
  try {
    validSignature = verify(null, manifestBytes, publicKey, signature);
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    throw new ReleaseManifestError(
      "RELEASE_SIGNATURE_INVALID",
      "Release manifest signature is invalid.",
    );
  }

  let decodedManifest: string;
  try {
    decodedManifest = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    throw new ReleaseManifestError(
      "RELEASE_MANIFEST_JSON_INVALID",
      "Signed release manifest is not valid UTF-8 JSON.",
    );
  }

  const parseableManifest = decodedManifest.startsWith("\uFEFF")
    ? decodedManifest.slice(1)
    : decodedManifest;
  try {
    assertJsonObjectKeysUnique(parseableManifest);
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) {
      throw new ReleaseManifestError(
        "RELEASE_MANIFEST_INVALID",
        "Signed release manifest contains duplicate JSON object keys.",
      );
    }
    if (error instanceof UnsafeJsonKeyError) {
      throw new ReleaseManifestError(
        "RELEASE_MANIFEST_SCHEMA_INVALID",
        "Signed release manifest does not match the supported schema.",
      );
    }
    throw new ReleaseManifestError(
      "RELEASE_MANIFEST_JSON_INVALID",
      "Signed release manifest is not valid UTF-8 JSON.",
    );
  }

  // The scanner above validates the complete JSON grammar and duplicate-key
  // policy before this native parse can materialize an object.
  let untrustedManifest: unknown;
  try {
    untrustedManifest = JSON.parse(parseableManifest);
  } catch {
    throw new ReleaseManifestError(
      "RELEASE_MANIFEST_JSON_INVALID",
      "Signed release manifest is not valid UTF-8 JSON.",
    );
  }

  const parsed = releaseManifestV1Schema.safeParse(untrustedManifest);
  if (!parsed.success) {
    throw new ReleaseManifestError(
      "RELEASE_MANIFEST_SCHEMA_INVALID",
      "Signed release manifest does not match the supported schema.",
    );
  }

  const manifest = parsed.data as ReleaseManifestV1;
  const canonicalBytes = serializeReleaseManifestCanonical(manifest);
  if (!Buffer.from(manifestBytes).equals(Buffer.from(canonicalBytes))) {
    throw new ReleaseManifestError(
      "RELEASE_MANIFEST_NON_CANONICAL",
      "Signed release manifest is valid but not canonical.",
    );
  }

  return {
    manifest,
    manifestSha256: releaseManifestSha256(manifestBytes),
  };
}

export function verifyReleaseManifest(
  manifestBytes: Uint8Array,
  signature: Uint8Array,
  publicKeyPem: string,
): ReleaseManifestV1 {
  return verifyReleaseManifestWithIdentity(
    manifestBytes,
    signature,
    publicKeyPem,
  ).manifest;
}
