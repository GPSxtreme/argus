import { Readability } from "@mozilla/readability";
import type { SourceItem } from "@argus/contracts";
import { JSDOM } from "jsdom";

export const extractPage = (url: string, html: string): SourceItem => {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const title =
    dom.window.document.querySelector("article h1, main h1, h1")?.textContent?.trim() ||
    article?.title?.trim() ||
    dom.window.document.querySelector("title")?.textContent?.trim() ||
    url;
  const text =
    article?.textContent?.replace(/\s+/gu, " ").trim() ||
    dom.window.document.body?.textContent?.replace(/\s+/gu, " ").trim() ||
    "";
  return {
    externalId: url,
    url,
    title,
    text,
    raw: { html, byline: article?.byline ?? null },
  };
};

export const fetchPage = async (
  url: string,
  fetcher: typeof fetch = fetch,
  userAgent = "Argus/0.1",
): Promise<SourceItem> => {
  const response = await fetcher(url, { headers: { "user-agent": userAgent } });
  if (!response.ok) throw new Error(`Web request failed (${response.status})`);
  return extractPage(response.url || url, await response.text());
};
