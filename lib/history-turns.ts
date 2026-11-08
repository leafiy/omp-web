import type { AgentMessage, CustomMessage, ImageContent, TextContent } from "./types";

/**
 * A history turn is one prompt the user sent plus everything the engine did
 * for it, up to the next prompt. Compaction summaries also start a turn
 * because compaction can replace the prompt that began the running turn.
 * Messages before the first anchor form a "preamble" turn.
 */
export type HistoryTurnKind = "user" | "compaction" | "preamble";

export interface HistoryTurnSummary {
  /** Entry ID of the first message in the turn. */
  id: string;
  /** Entry ID of the last message in the turn. */
  lastId: string;
  count: number;
  kind: HistoryTurnKind;
  /** Whitespace-collapsed prompt preview; empty for non-user turns. */
  text: string;
  images: number;
  toolCalls: number;
  timestamp?: number;
  /** The last message is an assistant message, so `lastId` is the next prompt's edit-from-here target. */
  endsWithAssistant: boolean;
}

export const TURN_PREVIEW_CHARS = 280;

export function isTurnAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

/** Contiguous [start, end) ranges covering every message exactly once. */
export function turnRanges(messages: AgentMessage[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 1; i < messages.length; i++) {
    if (!isTurnAnchor(messages[i])) continue;
    ranges.push({ start, end: i });
    start = i;
  }
  if (messages.length > 0) ranges.push({ start, end: messages.length });
  return ranges;
}

/** Truncate without splitting a UTF-16 surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + "…";
}

export function summarizeTurn(messages: AgentMessage[], entryIds: string[], start: number, end: number): HistoryTurnSummary {
  const first = messages[start];
  const kind: HistoryTurnKind = first.role === "user" ? "user" : isTurnAnchor(first) ? "compaction" : "preamble";
  let text = "", images = 0, toolCalls = 0;
  if (first.role === "user") {
    const blocks: (TextContent | ImageContent)[] = typeof first.content === "string" ? [{ type: "text", text: first.content }] : first.content;
    text = clipText(blocks.map((block) => block.type === "text" ? block.text : "").join(" ").replace(/\s+/g, " ").trim(), TURN_PREVIEW_CHARS);
    images = blocks.filter((block) => block.type === "image").length;
  }
  for (let i = start; i < end; i++) {
    const message = messages[i];
    if (message.role === "assistant") toolCalls += message.content.filter((block) => block.type === "toolCall").length;
  }
  return {
    id: entryIds[start],
    lastId: entryIds[end - 1],
    count: end - start,
    kind,
    text,
    images,
    toolCalls,
    ...(typeof first.timestamp === "number" ? { timestamp: first.timestamp } : {}),
    endsWithAssistant: messages[end - 1].role === "assistant",
  };
}

/** First and last entry IDs pin the exact path, so equal keys mean equal turn content. */
export function historyTurnKey(turn: Pick<HistoryTurnSummary, "id" | "lastId" | "count">): string {
  return `${turn.id}\u0000${turn.lastId}\u0000${turn.count}`;
}
