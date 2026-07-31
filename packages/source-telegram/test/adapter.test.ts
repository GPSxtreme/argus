import type { SourceItem } from "@argus/contracts";
import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../src/index.js";

const message = (id: string): SourceItem => ({
  externalId: id,
  url: `https://t.me/argus/${id}`,
  text: `Message ${id}`,
  raw: {},
});

describe("Telegram adapter checkpoints", () => {
  it("yields only messages after the last chronological message", async () => {
    const adapter = new TelegramAdapter({
      channel: async () => [message("39"), message("40"), message("41")],
    });
    const items: SourceItem[] = [];
    for await (const item of adapter.pull({
      targetId: "argus",
      config: { channel: "argus" },
      checkpoint: { lastId: "40" },
    })) {
      items.push(item);
    }
    expect(items.map((item) => item.externalId)).toEqual(["41"]);
  });
});
