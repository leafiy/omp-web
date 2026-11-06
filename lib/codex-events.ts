import type { AgentFrame } from "./agent-rpc-client";
import type { AssistantMessage, AgentMessage } from "./types";
import { object, type CodexObject } from "./codex-rpc-client";

/** Only the owner session calls this after matching BOTH thread and turn IDs. */
export class CodexEventProjector {
  private items = new Map<string, CodexObject>();
  private completed = new Set<string>();
  private toolCalls = new Set<string>();
  private partial = new Map<string, { type: string; text: string; summaries: Map<number, string> }>();
  constructor(private model: string) {}
  reset(model: string): void { this.model = model; this.items.clear(); this.completed.clear(); this.toolCalls.clear(); this.partial.clear(); }
  getItem(id: string): CodexObject | undefined { return this.items.get(id); }
  private assistant(content: AssistantMessage["content"]): AssistantMessage {
    return { role: "assistant", content, model: this.model, provider: "codex-cli", timestamp: Date.now() };
  }
  private name(item: CodexObject): string {
    return item.type === "commandExecution" ? "bash" : item.type === "fileChange" ? "apply_patch"
      : item.type === "mcpToolCall" ? `mcp:${item.server}:${item.tool}` : String(item.type);
  }
  private isTool(item: CodexObject): boolean {
    return ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "imageGeneration", "collabAgentToolCall"].includes(String(item.type));
  }
  private call(item: CodexObject): AgentFrame[] {
    const id = String(item.id);
    if (this.toolCalls.has(id)) return [];
    this.toolCalls.add(id);
    const name = this.name(item);
    const input = item.type === "commandExecution" ? { command: item.command, cwd: item.cwd }
      : item.type === "fileChange" ? { changes: item.changes } : item;
    return [{ type: "message_end", message: this.assistant([{ type: "toolCall", toolCallId: id, toolName: name, input }]) },
      { type: "tool_execution_start", toolCallId: id, toolName: name }];
  }
  consume(method: string, params: CodexObject): AgentFrame[] {
    const id = typeof params.itemId === "string" ? params.itemId : undefined;
    if (id && !this.completed.has(id) && ["item/agentMessage/delta", "item/reasoning/summaryTextDelta"].includes(method)) {
      const p = this.partial.get(id) ?? { type: method.includes("reasoning") ? "reasoning" : "agentMessage", text: "", summaries: new Map<number, string>() };
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (p.type === "reasoning") {
        const index = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        p.summaries.set(index, (p.summaries.get(index) || "") + delta);
      } else p.text += delta;
      this.partial.set(id, p);
      const text = p.type === "reasoning" ? [...p.summaries].sort(([a], [b]) => a - b).map(([, s]) => s).join("\n") : p.text;
      return [{ type: "message_update", message: this.assistant(p.type === "reasoning" ? [{ type: "thinking", thinking: text }] : [{ type: "text", text }]) }];
    }
    if (method !== "item/started" && method !== "item/completed") return [];
    const item = object(params.item);
    if (typeof item.id !== "string" || this.completed.has(item.id)) return [];
    this.items.set(item.id, item);
    const events = this.isTool(item) ? this.call(item) : [];
    if (method === "item/started") return events;
    this.completed.add(item.id); this.partial.delete(item.id);
    let message: AgentMessage | undefined;
    if (item.type === "agentMessage" && typeof item.text === "string") message = this.assistant([{ type: "text", text: item.text }]);
    else if (item.type === "reasoning" && Array.isArray(item.summary)) message = this.assistant([{ type: "thinking", thinking: item.summary.filter((s) => typeof s === "string").join("\n") }]);
    else if (item.type === "plan" && typeof item.text === "string") message = this.assistant([{ type: "text", text: item.text }]);
    else if (this.isTool(item)) {
      const output = item.type === "commandExecution" ? String(item.aggregatedOutput || "") : JSON.stringify(item.result ?? item.error ?? item);
      message = { role: "toolResult", toolCallId: item.id, toolName: this.name(item),
        content: [{ type: "text", text: output.length > 64_000 ? "[Output truncated]\n" + output.slice(-64_000) : output }],
        isError: ["failed", "declined", "cancelled"].includes(String(item.status)) || Boolean(item.error) || (typeof item.exitCode === "number" && item.exitCode !== 0), timestamp: Date.now() };
      events.push({ type: "tool_execution_end", toolCallId: item.id, toolName: this.name(item) });
    }
    if (message) events.push({ type: "message_end", message });
    return events;
  }
  finish(): AgentFrame[] {
    const events: AgentFrame[] = [];
    for (const [id, p] of this.partial) {
      const text = p.type === "reasoning" ? [...p.summaries].sort(([a], [b]) => a - b).map(([, s]) => s).join("\n") : p.text;
      if (text) events.push(...this.consume("item/completed", { item: { id, type: p.type, text, summary: [text] } }));
    }
    for (const id of this.toolCalls) {
      if (this.completed.has(id)) continue;
      const name = this.name(this.items.get(id) || {});
      events.push({ type: "tool_execution_end", toolCallId: id, toolName: name }, { type: "message_end", message: {
        role: "toolResult", toolCallId: id, toolName: name, isError: true, timestamp: Date.now(),
        content: [{ type: "text", text: "Codex turn ended before a final tool result was received." }],
      } });
      this.completed.add(id);
    }
    return events;
  }
}
