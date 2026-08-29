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

  it("keeps media-only announcements as pointer records", () => {
    const html = `<div class="tgme_widget_message" data-post="argus_news/42">
      <a class="tgme_widget_message_photo_wrap" style="background-image:url('/file/photo.jpg')"></a>
      <video src="https://cdn.example/video.mp4" poster="/file/poster.jpg"></video>
      <audio src="https://cdn.example/audio.mp3"></audio>
      <a class="tgme_widget_message_document" href="/file/report.pdf">report</a>
    </div>`;
    expect(parseTelegramPreview(html, "argus_news")[0]).toMatchObject({
      externalId: "42", text: "", media: [
        { kind: "image", url: "https://t.me/file/photo.jpg" },
        { kind: "video", url: "https://cdn.example/video.mp4", previewUrl: "https://t.me/file/poster.jpg" },
        { kind: "audio", url: "https://cdn.example/audio.mp3" },
        { kind: "document", url: "https://t.me/file/report.pdf" },
      ],
    });
  });
});
