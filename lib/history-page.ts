import type { AgentMessage, AssistantContentBlock, SessionContext, SessionTreeNode } from "./types";

export interface HistoryTotals {
  userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number;
}
export interface HistoryPage { version: string; before: string | null; total: number; prefix: HistoryTotals; }
export function historyTotals(messages: AgentMessage[]): HistoryTotals {
  const totals: HistoryTotals = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: messages.length, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  for (const m of messages) {
    if (m.role === "user") totals.userMessages++;
    if (m.role === "toolResult") totals.toolResults++;
    if (m.role !== "assistant") continue;
    totals.assistantMessages++;
    totals.toolCalls += m.historyToolCalls ?? m.content.filter(b => b.type === "toolCall").length;
    totals.tokens.input += m.usage?.input ?? 0; totals.tokens.output += m.usage?.output ?? 0;
    totals.tokens.cacheRead += m.usage?.cacheRead ?? 0; totals.tokens.cacheWrite += m.usage?.cacheWrite ?? 0;
    totals.cost += m.usage?.cost?.total ?? 0;
  }
  totals.tokens.total = totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  return totals;
}

function deferMessage(m: AgentMessage, sessionId: string, entryId: string, version: string): AgentMessage {
  if (JSON.stringify(m).length <= 24_000) return m;
  const fields = { historyDeferred: true, historyEntryId: entryId, historySessionId: sessionId, historyVersion: version, timestamp: m.timestamp };
  if (m.role === "bashExecution") return { ...fields, role: m.role, command: m.command.slice(0, 160), output: "", exitCode: m.exitCode };
  if (m.role === "assistant") return { ...fields, role: m.role, model: m.model, provider: m.provider, usage: m.usage, historyToolCalls: m.content.filter(b => b.type === "toolCall").length,
    content: m.content.slice(0, 100).flatMap((b): AssistantContentBlock[] => b.type === "toolCall" ? [{ ...b, input: {} }] : b.type === "text" ? [{ type: "text" as const, text: b.text.slice(0, 160) }] : []) };
  if (m.role === "toolResult") return { ...fields, role: m.role, toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, content: [] };
  if (m.role === "custom") return { ...fields, role: m.role, customType: m.customType, display: m.display, content: "" };
  return { ...fields, role: "user", content: "" };
}

export function pageHistory(context: SessionContext, sessionId: string, version: string, limit: number, before?: string) {
  const end = before ? context.entryIds.indexOf(before) : context.messages.length;
  if (end < 0) throw new Error("History cursor is no longer on this branch");
  const start = Math.max(0, end - limit);
  return {
    context: { ...context, messages: context.messages.slice(start, end).map((m, i) => deferMessage(m, sessionId, context.entryIds[start + i], version)), entryIds: context.entryIds.slice(start, end) },
    page: { version, before: start > 0 ? context.entryIds[start] : null, total: context.messages.length, prefix: historyTotals(context.messages.slice(0, start)) } satisfies HistoryPage,
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
