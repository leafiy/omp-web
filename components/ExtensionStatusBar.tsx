"use client";

import { useEffect, useState } from "react";
import { parseAnsiLine, stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem } from "@/lib/types";

/**
 * A status that appears must last this long before the row is shown. Claude
 * Code hooks (PreToolUse/PostToolUse on every tool call) set and clear a status
 * within milliseconds; mounting the 36px row for each one made the chat jump.
 */
export const EXTENSION_STATUS_SHOW_DELAY_MS = 1000;

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function ExtensionStatusBar({ statuses }: { statuses: ExtensionStatusItem[] }) {
  const hasStatuses = statuses.length > 0;
  // Statuses already present at mount (reload, reconnect) show at once; while
  // shown, text changes apply immediately and the row hides when they all clear.
  const [shown, setShown] = useState(hasStatuses);
  if (!hasStatuses && shown) setShown(false);
  useEffect(() => {
    if (!hasStatuses || shown) return;
    const timer = setTimeout(() => setShown(true), EXTENSION_STATUS_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasStatuses, shown]);

  if (!hasStatuses || !shown) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  return (
    <div
      role="status"
      aria-label={plainStatusLine}
      title={plainStatusLine}
      style={{
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        minWidth: 0,
        height: 36,
        padding: "0 12px",
        borderTop: "1px solid var(--border)",
        background: "transparent",
      }}
    >
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {parseAnsiLine(statusLine).map((segment, index) => (
          <span key={index} style={segment.style}>{segment.text}</span>
        ))}
      </span>
    </div>
  );
}
