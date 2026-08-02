import { describe, expect, it } from "vitest";
import { safeDiagnosticWebTarget } from "../src/web-safety.js";

describe("diagnostic web safety", () => {
  it("allows only public DNS answers", async () => {
    expect(await safeDiagnosticWebTarget("https://public.example", async () => [{ address: "8.8.8.8" }])).toBe(true);
  });
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0", "::1", "fc00::1", "fe80::1"])("rejects non-public DNS answer %s", async (address) => {
    expect(await safeDiagnosticWebTarget("https://public.example", async () => [{ address }])).toBe(false);
  });
  it("rejects credentials and non-http URLs", async () => {
    expect(await safeDiagnosticWebTarget("https://user:pass@example.com", async () => [{ address: "8.8.8.8" }])).toBe(false);
    expect(await safeDiagnosticWebTarget("file:///tmp/x", async () => [])).toBe(false);
  });
});
