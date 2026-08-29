import type { RecordDetail } from "@argus/contracts";
import { describe, expect, it } from "vitest";
import { buildOpenRouterContent } from "../src/index.js";

const record: RecordDetail = {
  id: "record",
  source: "x",
  externalId: "post",
  url: "https://x.com/a/status/post",
  text: "See the chart",
  raw: {},
  contentHash: "hash",
  firstSeenAt: "2026-08-29T00:00:00.000Z",
  lastSeenAt: "2026-08-29T00:00:00.000Z",
  watches: [],
  relations: [],
  media: [
    {
      id: "image",
      recordId: "record",
      position: 0,
      kind: "image",
      url: "https://cdn.example/chart.jpg",
      firstSeenAt: "2026-08-29T00:00:00.000Z",
      lastSeenAt: "2026-08-29T00:00:00.000Z",
    },
    {
      id: "audio",
      recordId: "record",
      position: 1,
      kind: "audio",
      url: "https://cdn.example/audio.mp3",
      firstSeenAt: "2026-08-29T00:00:00.000Z",
      lastSeenAt: "2026-08-29T00:00:00.000Z",
    },
  ],
};

describe("OpenRouter multimodal content", () => {
  it("passes supported pointers and records explicit omissions", () => {
    const result = buildOpenRouterContent(
      [record],
      { input: new Set(["text", "image", "audio"]), source: "openrouter" },
    );
    expect(result.parts).toContainEqual({
      type: "image_url",
      image_url: { url: "https://cdn.example/chart.jpg" },
    });
    expect(result.media).toEqual([
      { mediaAssetId: "image", disposition: "analyzed" },
      {
        mediaAssetId: "audio",
        disposition: "omitted",
        reason: "remote_audio_not_supported",
      },
    ]);
  });
});
