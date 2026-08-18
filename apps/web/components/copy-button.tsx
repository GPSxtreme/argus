"use client";

import { useState } from "react";

export function CopyButton({ text }: Readonly<{ text: string }>) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    setTimeout(() => setStatus("idle"), 1500);
  };
  return (
    <button type="button" className="copy-button" onClick={copy}>
      {status === "idle" ? "⧉ copy" : status}
    </button>
  );
}
