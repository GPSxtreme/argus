import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../app/page";

describe("Argus landing page", () => {
  const html = renderToStaticMarkup(<Home />);

  it("keeps the installation path and primary navigation visible", () => {
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain("curl -fsSL https://argus.gpsxtre.me/install.sh | sh");
    expect(html).toContain('href="/docs/getting-started"');
    expect(html).toContain('href="/docs"');
  });

  it("explains the supported sources and processing pipeline", () => {
    for (const label of ["X", "Telegram", "Web", "Collect", "Normalize", "Store", "Query"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('href="/skill"');
  });

  it("links documentation, source, license, and the current version without third-party embeds", () => {
    for (const label of ["Docs", "Source", "License", "v0.1.2"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/<script[^>]+(?:analytics|chat|video)/iu);
  });
});
