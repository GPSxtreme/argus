"use client";

import { useState } from "react";

export function CopyButton({ text }: Readonly<{ text: string }>) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="copy-button" onClick={copy}>
      {copied ? "copied" : "⧉ copy"}
    </button>
  );
}
