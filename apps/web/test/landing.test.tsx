import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../app/page";

describe("Argus landing page", () => {
  const html = renderToStaticMarkup(<Home />);

  it("keeps the installation path and primary navigation visible", () => {
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain("curl -fsSL https://argus.gpsxtre.me/install.sh | sh");
    expect(html).toContain("verifies the manifest signature");
    expect(html).toContain('href="/docs/quick-start"');
    expect(html).toContain('href="/docs"');
    expect(html).not.toContain("Copy install command");
  });

  it("explains the supported sources and the signal flow", () => {
    for (const label of [
      "Signals in. Receipts out.",
      "X",
      "Telegram",
      "Web",
      "ARGUS",
      "Your agent",
      "Revisioned records and deterministic queries keep every result traceable to its source.",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('href="/skill"');
  });

  it("links documentation, source, license, and the current version without third-party embeds", () => {
    for (const label of ["Docs", "Source", "License", "v0.2.4"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/<script[^>]+(?:analytics|chat|video)/iu);
  });
});
