import type { SourceItem } from "@argus/contracts";
import { load } from "cheerio";

export const parseTelegramPreview = (
  html: string,
  channel: string,
): SourceItem[] => {
  const $ = load(html);
  const items: SourceItem[] = [];
  $(".tgme_widget_message[data-post]").each((_index, element) => {
    const block = $(element);
    const post = block.attr("data-post");
    const id = post?.split("/").at(-1);
    const text = block.find(".tgme_widget_message_text").text().trim();
    const absolute = (value?: string): string | undefined => {
      if (!value) return undefined;
      try { const url = new URL(value, "https://t.me"); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
    };
    const media: NonNullable<SourceItem["media"]> = [];
    const photo = block.find(".tgme_widget_message_photo_wrap").first();
    const styleUrl = photo.attr("style")?.match(/url\(['"]?([^'")]+)['"]?\)/u)?.[1];
    const photoUrl = absolute(photo.attr("href") ?? styleUrl);
    if (photoUrl) media.push({ kind: "image", url: photoUrl });
    block.find("video").each((_videoIndex, video) => {
      const node = $(video);
      const url = absolute(node.attr("src"));
      const previewUrl = absolute(node.attr("poster"));
      if (url)
        media.push({
          kind: "video",
          url,
          ...(previewUrl ? { previewUrl } : {}),
        });
    });
    block.find("audio").each((_audioIndex, audio) => { const url = absolute($(audio).attr("src")); if (url) media.push({ kind: "audio", url }); });
    block.find("a.tgme_widget_message_document").each((_documentIndex, document) => { const url = absolute($(document).attr("href")); if (url) media.push({ kind: "document", url }); });
    const uniqueMedia = media.filter((item, index) => media.findIndex((candidate) => candidate.kind === item.kind && candidate.url === item.url) === index);
    if (!id || (!text && !uniqueMedia.length)) return;
    const href =
      block.find(".tgme_widget_message_date").attr("href") ??
      `https://t.me/${channel}/${id}`;
    const publishedAt = block.find("time").attr("datetime");
    items.push({
      externalId: id,
      url: href,
      text,
      ...(uniqueMedia.length ? { media: uniqueMedia } : {}),
      author: channel,
      ...(publishedAt ? { publishedAt } : {}),
      raw: { channel, id, html: block.html() },
    });
  });
  return items;
};
