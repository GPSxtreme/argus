import { describe, expect, it } from "vitest";
import { GET as getMarkdown } from "../app/llms.mdx/docs/[[...slug]]/route";
import { GET as getIndex } from "../app/llms.txt/route";
import { GET as getFull } from "../app/llms-full.txt/route";
import { site } from "../lib/site";
import { source } from "../lib/source";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function titleHeadingPattern(title: string): RegExp {
  return new RegExp(`(?<!#)# ${escapeRegExp(title)}`, "gu");
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

  it("renders every page and the full guide as the exact processed Markdown contract", async () => {
    const pages = source.getPages();
    const expectedPages = await Promise.all(
      pages.map(async (page) =>
        `# ${page.data.title}\n\n${(await page.data.getText("processed")).trim()}`,
      ),
    );
    const full = await (await getFull()).text();

    for (const [index, page] of pages.entries()) {
      const pageMarkdown = await (
        await getMarkdown(new Request(`https://argus.gpsxtre.me${page.url}.md`), {
          params: Promise.resolve({ slug: page.slugs }),
        })
      ).text();

      expect(pageMarkdown).toBe(expectedPages[index]);
    }

    expect(full).toBe(`# ${site.name}\n\n${expectedPages.join("\n\n")}\n`);
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
      expect(text.match(titleHeadingPattern(page.data.title))).toHaveLength(1);
    }
  });

  it("matches special-character page titles literally in a full guide", () => {
    const text = "# C++ (v2)\n\nbody";

    expect(text.match(titleHeadingPattern("C++ (v2)"))).toHaveLength(1);
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
