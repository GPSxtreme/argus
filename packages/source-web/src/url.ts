import { Readability } from "@mozilla/readability";
import type { MediaKind, SourceItem, SourceMedia } from "@argus/contracts";
import { JSDOM } from "jsdom";
import { safeHttpGet, type SafeHttpOptions } from "./safe-http.js";

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
  const absolute = (value: string | null): string | undefined => {
    if (!value) return undefined;
    try { const resolved = new URL(value, url); return ["http:", "https:"].includes(resolved.protocol) ? resolved.href : undefined; } catch { return undefined; }
  };
  const media: SourceMedia[] = [];
  const add = (kind: MediaKind, value: string | null, extras: Omit<SourceMedia, "kind" | "url"> = {}) => { const resolved = absolute(value); if (resolved && !media.some((item) => item.kind === kind && item.url === resolved)) media.push({ kind, url: resolved, ...extras }); };
  add("image", dom.window.document.querySelector('meta[property="og:image"],meta[name="twitter:image"]')?.getAttribute("content") ?? null);
  for (const image of dom.window.document.querySelectorAll("article img,main img")) add("image", image.getAttribute("src"));
  for (const video of dom.window.document.querySelectorAll("article video,main video")) {
    const previewUrl = absolute(video.getAttribute("poster"));
    add(
      "video",
      video.getAttribute("src") ??
        video.querySelector("source")?.getAttribute("src") ??
        null,
      previewUrl ? { previewUrl } : {},
    );
  }
  for (const audio of dom.window.document.querySelectorAll("article audio,main audio")) add("audio", audio.getAttribute("src") ?? audio.querySelector("source")?.getAttribute("src") ?? null);
  for (const link of dom.window.document.querySelectorAll("article a[href],main a[href]")) if (/\.(?:pdf|docx?|xlsx?|pptx?|zip)(?:$|[?#])/iu.test(link.getAttribute("href") ?? "")) add("document", link.getAttribute("href"));
  return {
    externalId: url,
    url,
    title,
    text,
    ...(media.length ? { media } : {}),
    raw: { html, byline: article?.byline ?? null },
  };
};

export const fetchPage = async (
  url: string,
  options: SafeHttpOptions = {},
  userAgent = "Argus/0.1",
): Promise<SourceItem> => {
  const response = await safeHttpGet(url, {
    ...options,
    headers: { ...options.headers, "user-agent": userAgent },
  });
  if (!response.ok) throw new Error(`Web request failed (${response.status})`);
  return extractPage(response.finalUrl, response.body);
};
