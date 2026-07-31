import type { SourceItem } from "@argus/contracts";
import { XMLParser } from "fast-xml-parser";

const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const stripHtml = (value: string): string =>
  value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();

export const parseFeed = (feedUrl: string, xml: string): SourceItem[] => {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
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
  fetcher: typeof fetch = fetch,
): Promise<SourceItem[]> => {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Feed request failed (${response.status})`);
  return parseFeed(response.url || url, await response.text());
};
