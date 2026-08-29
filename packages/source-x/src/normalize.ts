import type { Engagement, MediaKind, SourceItem, SourceMedia, SourceRelation } from "@argus/contracts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" || typeof value === "number" ? String(value) : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : undefined;

const mediaKind = (value: unknown): MediaKind | undefined => {
  const kind = string(value)?.toLowerCase();
  if (kind === "photo" || kind === "image") return "image";
  if (kind === "video" || kind === "gif" || kind === "animated_gif") return "video";
  if (kind === "audio") return "audio";
  if (kind === "document" || kind === "file") return "document";
  return undefined;
};

const normalizeMedia = (status: ObjectValue): SourceMedia[] => {
  const container = object(status.media);
  const values = array(
    container?.all ??
      (Array.isArray(status.media)
        ? status.media
        : object(status.extended_entities)?.media),
  );
  return values.flatMap((value): SourceMedia[] => {
    const item = object(value); if (!item) return [];
    const kind = mediaKind(item.type ?? item.kind);
    const url = string(item.url ?? item.media_url_https ?? item.media_url ?? item.video_url);
    if (!kind || !url) return [];
    return [{ kind, url,
      ...(string(item.id ?? item.media_key) ? { sourceMediaId: string(item.id ?? item.media_key) } : {}),
      ...(string(item.thumbnail_url ?? item.preview_url) ? { previewUrl: string(item.thumbnail_url ?? item.preview_url) } : {}),
      ...(string(item.mime_type) ? { mimeType: string(item.mime_type) } : {}),
      ...(number(item.width) === undefined ? {} : { width: number(item.width) }),
      ...(number(item.height) === undefined ? {} : { height: number(item.height) }),
      ...(number(item.duration_millis ?? item.duration_ms) === undefined ? {} : { durationMs: number(item.duration_millis ?? item.duration_ms) }),
      ...(string(item.alt_text) ? { altText: string(item.alt_text) } : {}),
    } as SourceMedia];
  });
};

const relatedId = (value: unknown): string | undefined => string(object(value)?.id ?? object(value)?.rest_id ?? value);
const normalizeRelations = (status: ObjectValue): SourceRelation[] => {
  const candidates: Array<[SourceRelation["kind"], unknown]> = [
    ["reply_to", status.replying_to ?? status.in_reply_to_status_id],
    ["quote_of", status.quote ?? status.quoted_tweet ?? status.quoted_status],
    ["repost_of", status.retweet ?? status.retweeted_tweet ?? status.retweeted_status],
  ];
  return candidates.flatMap(([kind, value]) => {
    const id = relatedId(value); if (!id) return [];
    return [{ kind, objectSource: "x", objectExternalId: id }];
  });
};

export const normalizeXStatus = (value: unknown): SourceItem | undefined => {
  const status = object(value); if (!status) return undefined;
  const id = string(status.id ?? status.rest_id); if (!id) return undefined;
  const text = string(status.text ?? status.full_text) ?? "";
  const media = normalizeMedia(status); if (!text.trim() && !media.length) return undefined;
  const authorObject = object(status.author) ?? {};
  const author = string(authorObject.screen_name ?? authorObject.username ?? status.screen_name ?? status.username);
  const engagement: Engagement = {
    ...(number(status.likes ?? status.favorite_count) === undefined ? {} : { likes: number(status.likes ?? status.favorite_count) }),
    ...(number(status.replies ?? status.reply_count) === undefined ? {} : { replies: number(status.replies ?? status.reply_count) }),
    ...(number(status.retweets ?? status.retweet_count) === undefined ? {} : { reposts: number(status.retweets ?? status.retweet_count) }),
    ...(number(status.quotes ?? status.quote_count) === undefined ? {} : { quotes: number(status.quotes ?? status.quote_count) }),
    ...(number(status.views ?? status.view_count) === undefined ? {} : { views: number(status.views ?? status.view_count) }),
    ...(number(status.bookmarks ?? status.bookmark_count) === undefined ? {} : { bookmarks: number(status.bookmarks ?? status.bookmark_count) }),
  } as Engagement;
  const relations = normalizeRelations(status);
  const publishedAt = string(status.created_at);
  return { externalId: id, url: author ? `https://x.com/${author}/status/${id}` : `https://x.com/i/status/${id}`, text,
    ...(author ? { author } : {}), ...(publishedAt ? { publishedAt } : {}),
    ...(media.length ? { media } : {}), ...(relations.length ? { relations } : {}),
    ...(Object.keys(engagement).length ? { engagement } : {}), raw: status };
};
