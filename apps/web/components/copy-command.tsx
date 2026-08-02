"use client";

import { useState } from "react";

export function CopyCommand({ command }: Readonly<{ command: string }>) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <button className="copy-command" type="button" onClick={copy} aria-label="Copy install command">
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
