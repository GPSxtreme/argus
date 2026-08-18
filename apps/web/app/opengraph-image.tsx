import { ImageResponse } from "next/og";
import { site } from "../lib/site";

export const alt = `${site.name} — ${site.description}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "80px",
        background: "#07090d",
        backgroundImage: "radial-gradient(circle at 25% 20%, rgba(110,231,183,.10), transparent 60%)",
        color: "#eef2f6",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <svg width="44" height="44" viewBox="0 0 64 64" role="img" aria-label="Argus logo">
          <circle cx="32" cy="32" r="17" fill="none" stroke="#6ee7b7" strokeWidth="4" />
          <circle cx="32" cy="32" r="7" fill="#6ee7b7" />
        </svg>
        <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "0.18em", color: "#6ee7b7" }}>
          ARGUS
        </div>
      </div>
      <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.05, marginTop: 42 }}>
        Know what changed. Keep the proof.
      </div>
      <div style={{ fontSize: 34, color: "#8b98a5", marginTop: 34 }}>
        {site.description}
      </div>
    </div>,
    size,
  );
}
