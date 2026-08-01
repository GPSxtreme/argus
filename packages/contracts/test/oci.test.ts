import { describe, expect, it } from "vitest";
import { isPinnedImageReference } from "../src/index.js";

describe("OCI image contracts", () => {
  it.each([
    `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
    `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
    `localhost:5000/argus/service@sha256:${"c".repeat(64)}`,
  ])("accepts a credential-free digest-pinned reference: %s", (reference) => {
    expect(isPinnedImageReference(reference)).toBe(true);
  });

  it.each([
    `ghcr.io/gpsxtreme/argus:1.2.3`,
    `user:secret@ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
    `ghcr.io/gpsxtreme/argus@sha256:${"A".repeat(64)}`,
    `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}?token=value`,
  ])("rejects mutable or credentialed reference: %s", (reference) => {
    expect(isPinnedImageReference(reference)).toBe(false);
  });
});
