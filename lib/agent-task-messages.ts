import type { AgentTaskMessage, AgentTaskTranscript } from "./agent-task-types";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const limit = 64_000;

function contentText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  return content.slice(0, 200).map(raw => {
    const b = record(raw);
    if ((b.type === "text" || b.type === "inputText") && typeof b.text === "string") return b.text.slice(0, limit);
    if (b.type === "tool_use" || b.type === "toolCall") {
      return `${String(b.name ?? b.toolName ?? "tool")}\n${JSON.stringify(b.input ?? b.arguments ?? {}).slice(0, limit)}`;
    }
    if (b.type === "tool_result") {
      if (typeof b.content === "string") return b.content.slice(0, limit);
      if (Array.isArray(b.content)) return b.content.slice(0, 100).map(v => typeof record(v).text === "string" ? String(record(v).text).slice(0, limit) : "").join("\n").slice(0, limit);
    }
    return ""; // Never include hidden reasoning, images or arbitrary SDK metadata.
  }).filter(Boolean).join("\n\n").slice(0, limit);
}

/** Normalizes native/SDK/Pi messages into a bounded, read-only child conversation. */
export function taskTranscript(raw: unknown): AgentTaskTranscript {
  if (!Array.isArray(raw)) return { messages: [], truncated: false };
  let remaining = limit, truncated = raw.length > 100;
  const messages: AgentTaskMessage[] = [];
  for (const value of raw.slice(-100).reverse()) {
    const frame = record(value), m = frame.message ? record(frame.message) : frame;
    const role = m.role ?? frame.type;
    if (!["user", "assistant", "tool", "toolResult"].includes(String(role))) continue;
    const full = contentText(m.content);
    if (!full) continue;
    if (!remaining) { truncated = true; break; }
    const text = full.slice(-remaining);
    if (text.length < full.length || full.length === limit) truncated = true;
    remaining -= text.length;
    const toolResult = Array.isArray(m.content) && m.content.length > 0 && m.content.every(block => record(block).type === "tool_result");
    messages.push({ role: toolResult ? "tool" : role === "user" ? "user" : role === "assistant" ? "assistant" : "tool", text });
  }
  return { messages: messages.reverse(), truncated };
}

export function codexTaskTranscript(thread: Record<string, unknown>): AgentTaskTranscript {
  const messages: unknown[] = [];
  for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
    const items = record(turn).items;
    for (const raw of Array.isArray(items) ? items : []) {
      const item = record(raw);
      if (item.type === "userMessage") messages.push({ role: "user", content: item.content });
      else if (item.type === "agentMessage" || item.type === "plan") messages.push({ role: "assistant", content: item.text });
      else if (item.type === "commandExecution") messages.push({ role: "tool", content: `${String(item.command ?? "")}\n${String(item.aggregatedOutput ?? "")}` });
      else if (["fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(String(item.type))) messages.push({ role: "tool", content: String(item.type) });
    }
  }
  return taskTranscript(messages);
}
