import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import { pinnedImageReferenceSchema } from "@argus/deployment";
import { z } from "zod";

export const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_PUBLIC_KEY_PEM_BYTES = 16 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const normalizedVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const credentialQueryKeyPattern =
  /^(?:access[_-]?key|api[_-]?key|auth|authorization|credential|key|password|secret|sig|signature|token)$/i;

export type ReleaseManifestErrorCode =
  | "RELEASE_MANIFEST_TOO_LARGE"
  | "RELEASE_PUBLIC_KEY_INVALID"
  | "RELEASE_SIGNATURE_INVALID"
  | "RELEASE_MANIFEST_JSON_INVALID"
  | "RELEASE_MANIFEST_SCHEMA_INVALID";

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

const isSafeHttpsAssetUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return false;
  }

  for (const key of url.searchParams.keys()) {
    if (credentialQueryKeyPattern.test(key)) return false;
  }
  return true;
};

const imageSchema = z
  .object({
    reference: pinnedImageReferenceSchema,
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
  .refine(isSafeHttpsAssetUrl, "Expected an HTTPS URL without credentials");
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
  };
  assets: {
    fxembed: { url: string; sha256: string; compatibilityDate: string };
    wrapper: { url: string; sha256: string };
  };
  minimumStateSchema: 1;
}

export interface VerifiedReleaseManifest {
  manifest: ReleaseManifestV1;
  /** Lowercase SHA-256 of the exact bytes that passed signature verification. */
  manifestSha256: string;
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

  let untrustedManifest: unknown;
  try {
    untrustedManifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    );
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

  return {
    manifest: parsed.data as ReleaseManifestV1,
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
