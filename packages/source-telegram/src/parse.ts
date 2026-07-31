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
    if (!id || !text) return;
    const href =
      block.find(".tgme_widget_message_date").attr("href") ??
      `https://t.me/${channel}/${id}`;
    const publishedAt = block.find("time").attr("datetime");
    items.push({
      externalId: id,
      url: href,
      text,
      author: channel,
      ...(publishedAt ? { publishedAt } : {}),
      raw: { channel, id, html: block.html() },
    });
  });
  return items;
};
