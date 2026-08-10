import type { SourceItem } from "@argus/contracts";
import { XMLParser } from "fast-xml-parser";
import { safeHttpGet, type SafeHttpOptions } from "./safe-http.js";

const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const unescapeEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
const text = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") {
    return unescapeEntities(String(value));
  }
  if (typeof value === "object" && value !== null) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return "";
};
const stripHtml = (value: string): string =>
  unescapeEntities(value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim());

export const parseFeed = (feedUrl: string, xml: string): SourceItem[] => {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
  }).parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  const feed = parsed.feed as Record<string, unknown> | undefined;
  const entries = channel
    ? array(channel.item as Record<string, unknown> | Record<string, unknown>[])
    : array(feed?.entry as Record<string, unknown> | Record<string, unknown>[]);
  return entries
    .map((entry): SourceItem | undefined => {
      const linkValue = entry.link;
      const link =
        typeof linkValue === "object" && linkValue
          ? text((linkValue as Record<string, unknown>)["@_href"])
          : text(linkValue);
      const id = text(entry.guid ?? entry.id ?? link);
      if (!id) return undefined;
      const description = text(
        entry.description ?? entry.summary ?? entry.content,
      );
      return {
        externalId: id,
        url: link || feedUrl,
        ...(text(entry.title) ? { title: text(entry.title) } : {}),
        text: stripHtml(description),
        ...(text(entry.pubDate ?? entry.published ?? entry.updated)
          ? { publishedAt: text(entry.pubDate ?? entry.published ?? entry.updated) }
          : {}),
        raw: entry,
      };
    })
    .filter((item): item is SourceItem => item !== undefined);
};

export const fetchFeed = async (
  url: string,
  options: SafeHttpOptions = {},
): Promise<SourceItem[]> => {
  const response = await safeHttpGet(url, options);
  if (!response.ok) throw new Error(`Feed request failed (${response.status})`);
  return parseFeed(response.finalUrl, response.body);
};
