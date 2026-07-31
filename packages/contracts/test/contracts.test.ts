import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentHash, normalizeError } from "../src/index.js";

describe("canonical contracts", () => {
  it("builds a stable source identity", () => {
    expect(canonicalIdentity("x", "target-1", "post-9")).toBe(
      "x:target-1:post-9",
    );
  });

  it("hashes equal content identically", () => {
    expect(contentHash({ text: "hello", title: "A" })).toBe(
      contentHash({ title: "A", text: "hello" }),
    );
  });

  it("redacts secrets from normalized errors", () => {
    const error = normalizeError(new Error("Bearer secret-token"), [
      "secret-token",
    ]);
    expect(error.message).toBe("Bearer [REDACTED]");
    expect(error.kind).toBe("retryable");
  });
});
