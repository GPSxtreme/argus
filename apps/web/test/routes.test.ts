import { describe, expect, it } from "vitest";
import { GET as getMarkdown } from "../app/llms.mdx/docs/[[...slug]]/route";
import { GET as getIndex } from "../app/llms.txt/route";
import { GET as getFull } from "../app/llms-full.txt/route";
import { getLLMText } from "../lib/get-llm-text";
import { source } from "../lib/source";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function bodyMarker(markdown: string, title: string): string {
  const marker = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && line !== `# ${title}`);
  if (marker === undefined) throw new Error("Documentation page has no processed body marker");
  return marker;
}

describe("LLM documentation routes", () => {
  it("lists every document with its title, description, and canonical URL", async () => {
    const text = await (await getIndex()).text();
    for (const page of source.getPages()) {
      expect(text).toContain(page.data.title);
      expect(text).toContain(page.data.description);
      expect(text).toContain(`https://argus.gpsxtre.me${page.url}`);
    }
  });

  it("keeps every page title and processed body marker in its Markdown and the full guide", async () => {
    const full = await (await getFull()).text();

    for (const page of source.getPages()) {
      const processed = await getLLMText(page);
      const pageMarkdown = await (
        await getMarkdown(new Request(`https://argus.gpsxtre.me${page.url}.md`), {
          params: Promise.resolve({ slug: page.slugs }),
        })
      ).text();

      for (const output of [pageMarkdown, full]) {
        expect(output).toContain(`# ${page.data.title}`);
        expect(output).toContain(bodyMarker(processed, page.data.title));
      }
    }
  });

  it("lists every canonical URL exactly once", async () => {
    const text = await (await getIndex()).text();

    for (const page of source.getPages()) {
      const url = `https://argus.gpsxtre.me${page.url}`;
      expect(text.match(new RegExp(`${escapeRegExp(url)}(?=[)\\s]|$)`, "gu"))).toHaveLength(1);
    }
  });

  it("renders every documentation heading once in the full guide", async () => {
    const text = await (await getFull()).text();
    for (const page of source.getPages()) {
      expect(text.match(new RegExp(`(?<!#)# ${page.data.title}`, "gu"))).toHaveLength(1);
    }
  });

  it("serves processed Markdown with an explicit media type", async () => {
    const response = await getMarkdown(new Request("https://argus.gpsxtre.me/docs/quick-start.md"), {
      params: Promise.resolve({ slug: ["quick-start"] }),
    });
    const text = await response.text();
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(text).toContain("# Quick start");
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
