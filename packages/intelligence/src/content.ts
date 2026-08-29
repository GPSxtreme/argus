import type { MediaAsset, RecordDetail, RecordEnvelope } from "@argus/contracts";
import type { ModelCapabilities } from "./capabilities.js";

type IntelligenceRecord = RecordEnvelope | RecordDetail;
export type OpenRouterContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface MediaDisposition {
  mediaAssetId: string;
  disposition: "analyzed" | "omitted";
  reason?: string;
}

const assets = (record: IntelligenceRecord): MediaAsset[] =>
  "watches" in record ? record.media : [];

export const buildOpenRouterContent = (
  records: IntelligenceRecord[],
  capabilities: ModelCapabilities,
  prompt = "Give a concise, useful summary.",
  maxMedia = 20,
): { parts: OpenRouterContentPart[]; media: MediaDisposition[] } => {
  const context = records
    .map(
      (record, index) =>
        `[${index + 1}] ${record.title ?? "(untitled)"}\n${record.text}\nSource: ${record.url}`,
    )
    .join("\n\n");
  const parts: OpenRouterContentPart[] = [
    { type: "text", text: `${prompt}\n\n${context}` },
  ];
  const media: MediaDisposition[] = [];
  let attached = 0;
  for (const asset of records.flatMap(assets)) {
    if (attached >= maxMedia) {
      media.push({ mediaAssetId: asset.id, disposition: "omitted", reason: "media_limit" });
      continue;
    }
    if (asset.kind === "image" && capabilities.input.has("image")) {
      parts.push({ type: "image_url", image_url: { url: asset.url } });
    } else if (asset.kind === "video" && capabilities.input.has("video")) {
      parts.push({ type: "video_url", video_url: { url: asset.url } });
    } else if (
      asset.kind === "video" &&
      asset.previewUrl &&
      capabilities.input.has("image")
    ) {
      parts.push({ type: "image_url", image_url: { url: asset.previewUrl } });
    } else if (
      asset.kind === "document" &&
      capabilities.input.has("file") &&
      (asset.mimeType === "application/pdf" || /\.pdf(?:$|\?)/iu.test(asset.url))
    ) {
      parts.push({
        type: "file",
        file: {
          filename: asset.url.split("/").at(-1)?.split("?")[0] || "document.pdf",
          file_data: asset.url,
        },
      });
    } else {
      media.push({
        mediaAssetId: asset.id,
        disposition: "omitted",
        reason: asset.kind === "audio" ? "remote_audio_not_supported" : "model_or_format_unsupported",
      });
      continue;
    }
    attached += 1;
    media.push({ mediaAssetId: asset.id, disposition: "analyzed" });
  }
  return { parts, media };
};
