"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { iconButtonClasses } from "@/lib/ui";

/** Copies `text` to the clipboard and shows a brief confirmation — the only client-side interaction a diff snippet needs. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`${iconButtonClasses()} h-6 w-6`}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );
}
