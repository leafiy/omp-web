import type { AgentMessage, SessionContext, SessionTreeNode } from "./types";
import { summarizeTurn, turnRanges, type HistoryTurnSummary } from "./history-turns";

export interface HistoryTotals {
  userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number;
}
/**
 * `turns` outlines every turn before the loaded window, oldest first; each one
 * is fetched whole through the turn route. `before` is the first loaded entry.
 */
export interface HistoryPage { version: string; before: string | null; total: number; prefix: HistoryTotals; turns: HistoryTurnSummary[]; }
export function historyTotals(messages: AgentMessage[]): HistoryTotals {
  const totals: HistoryTotals = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: messages.length, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  for (const m of messages) {
    if (m.role === "user") totals.userMessages++;
    if (m.role === "toolResult") totals.toolResults++;
    if (m.role !== "assistant") continue;
    totals.assistantMessages++;
    totals.toolCalls += m.content.filter(b => b.type === "toolCall").length;
    totals.tokens.input += m.usage?.input ?? 0; totals.tokens.output += m.usage?.output ?? 0;
    totals.tokens.cacheRead += m.usage?.cacheRead ?? 0; totals.tokens.cacheWrite += m.usage?.cacheWrite ?? 0;
    totals.cost += m.usage?.cost?.total ?? 0;
  }
  totals.tokens.total = totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  return totals;
}

/** Initial window bounds. The newest turn is always sent whole, whatever its size. */
export const HISTORY_WINDOW_MAX_TURNS = 10;
export const HISTORY_WINDOW_MAX_CHARS = 1_000_000;

/**
 * Whole recent turns plus a light outline of older ones. A turn is never split:
 * the browser expands older turns individually instead of paging messages.
 */
export function windowHistory(context: SessionContext, version: string, limits: { maxTurns?: number; maxChars?: number } = {}) {
  const maxTurns = limits.maxTurns ?? HISTORY_WINDOW_MAX_TURNS, maxChars = limits.maxChars ?? HISTORY_WINDOW_MAX_CHARS;
  const ranges = turnRanges(context.messages);
  let start = context.messages.length, chars = 0, included = 0;
  for (let r = ranges.length - 1; r >= 0; r--) {
    if (included >= maxTurns) break;
    let size = 0;
    for (let i = ranges[r].start; i < ranges[r].end; i++) size += JSON.stringify(context.messages[i]).length;
    if (included > 0 && chars + size > maxChars) break;
    start = ranges[r].start; chars += size; included++;
  }
  const turns = ranges.filter(range => range.end <= start).map(range => summarizeTurn(context.messages, context.entryIds, range.start, range.end));
  return {
    context: { ...context, messages: context.messages.slice(start), entryIds: context.entryIds.slice(start) },
    page: { version, before: start > 0 ? context.entryIds[start] : null, total: context.messages.length, prefix: historyTotals(context.messages.slice(0, start)), turns } satisfies HistoryPage,
  };
}

/** One complete turn starting at `anchorId` on this branch, or null when it no longer starts a turn there. */
export function historyTurn(context: SessionContext, anchorId: string): { turn: HistoryTurnSummary; messages: AgentMessage[]; entryIds: string[] } | null {
  const index = context.entryIds.indexOf(anchorId);
  if (index < 0) return null;
  const range = turnRanges(context.messages).find(item => item.start === index);
  if (!range) return null;
  return {
    turn: summarizeTurn(context.messages, context.entryIds, range.start, range.end),
    messages: context.messages.slice(range.start, range.end),
    entryIds: context.entryIds.slice(range.start, range.end),
  };
}

/** Navigation metadata must not duplicate full text/images already in context. */
export function lightHistoryTree(tree: SessionTreeNode[]): SessionTreeNode[] {
  const copy = (node: SessionTreeNode): SessionTreeNode => {
    const e = node.entry;
    const base = { id: e.id, parentId: e.parentId, timestamp: e.timestamp, type: e.type };
    let entry = base as typeof e;
    if (e.type === "message") {
      const m = e.message;
      const content = "content" in m ? m.content : "";
      const preview = typeof content === "string" ? content.slice(0, 120) : content.filter(b => b.type === "text").map(b => b.text.slice(0, 120)).join(" ").slice(0, 120);
      entry = { ...base, type: "message", message: { role: m.role, content: preview } } as typeof e;
    }
    return { entry, children: [], ...(node.label ? { label: node.label.slice(0, 160) } : {}), ...(node.compressedEntryIds ? { compressedEntryIds: node.compressedEntryIds } : {}) };
  };
  const roots = tree.map(copy), work = tree.map((node, i) => ({ node, output: roots[i] }));
  while (work.length) { const { node, output } = work.pop()!; for (const child of node.children) { const next = copy(child); output.children.push(next); work.push({ node: child, output: next }); } }
  return roots;
}
