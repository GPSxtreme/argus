import { describe, expect, it } from "vitest";
import { contentHash, normalizeError, recordIdentity } from "../src/index.js";

describe("canonical contracts", () => {
  it("builds a source-global stable record identity", () => {
    expect(recordIdentity("x", "42")).toBe(
      "1d6fc8095003910a3a02247f053a796c45f88cfe61ed120b42fcd21484cafa09",
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
