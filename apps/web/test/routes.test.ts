import { describe, expect, it } from "vitest";
import { source } from "../lib/source";
import { GET as getIndex } from "../app/llms.txt/route";
import { GET as getFull } from "../app/llms-full.txt/route";
import { GET as getMarkdown } from "../app/llms.mdx/docs/[[...slug]]/route";

describe("LLM documentation routes", () => {
  it("lists every document with its title, description, and canonical URL", async () => {
    const text = await (await getIndex()).text();
    for (const page of source.getPages()) {
      expect(text).toContain(page.data.title);
      expect(text).toContain(page.data.description);
      expect(text).toContain(`https://argus.gpsxtre.me${page.url}`);
    }
  });

  it("renders every documentation heading once in the full guide", async () => {
    const text = await (await getFull()).text();
    for (const page of source.getPages()) {
      expect(text.split(`# ${page.data.title}`).length - 1).toBe(1);
    }
  });

  it("serves processed Markdown with an explicit media type", async () => {
    const response = await getMarkdown(new Request("https://argus.gpsxtre.me/docs/getting-started.md"), {
      params: Promise.resolve({ slug: ["getting-started"] }),
    });
    const text = await response.text();
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(text).toContain("# Getting started");
    expect(text).not.toContain("<nav");
    expect(text).not.toContain("<html");
  });

  it("returns not found for a missing Markdown page", async () => {
    const response = await getMarkdown(new Request("https://argus.gpsxtre.me/docs/missing.md"), {
      params: Promise.resolve({ slug: ["missing"] }),
    });
    expect(response.status).toBe(404);
  });
});
