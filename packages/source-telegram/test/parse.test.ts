import { describe, expect, it } from "vitest";
import { parseTelegramPreview } from "../src/index.js";

describe("Telegram public preview parser", () => {
  it("extracts public announcement messages and skips service blocks", () => {
    const html = `
      <div class="tgme_widget_message" data-post="argus_news/41">
        <a class="tgme_widget_message_date" href="https://t.me/argus_news/41">
          <time datetime="2026-07-31T00:00:00+00:00"></time>
        </a>
        <div class="tgme_widget_message_text">Argus <b>ships</b></div>
      </div>
      <div class="tgme_widget_message_service">Pinned message</div>
    `;
    expect(parseTelegramPreview(html, "argus_news")).toEqual([
      expect.objectContaining({
        externalId: "41",
        text: "Argus ships",
        url: "https://t.me/argus_news/41",
      }),
    ]);
  });
});
