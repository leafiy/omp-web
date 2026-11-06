import type { AgentFrame } from "./agent-rpc-client";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, TextContent, ImageContent } from "./types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mediaContent(value: unknown): (TextContent | ImageContent)[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): (TextContent | ImageContent)[] => {
    const b = record(raw);
    if (b.type === "text" && typeof b.text === "string") return [{ type: "text", text: b.text }];
    const source = record(b.source);
    if (b.type === "image" && source.type === "base64" && typeof source.data === "string") {
      return [{ type: "image", source: { type: "base64", data: source.data, media_type: String(source.media_type ?? "image/png") } }];
    }
    return [];
  });
}

function assistantBlock(value: unknown): AssistantContentBlock | undefined {
  const b = record(value);
  if (b.type === "text" && typeof b.text === "string") return { type: "text", text: b.text };
  if (b.type === "thinking" && typeof b.thinking === "string") return { type: "thinking", thinking: b.thinking };
  if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
    return { type: "toolCall", toolCallId: b.id, toolName: b.name, input: record(b.input) };
  }
  return undefined;
}

/** Converts SDK messages; partial snapshots are never committed as final messages. */
export class ClaudeEventProjector {
  private partial?: AssistantMessage;
  private seen = new Set<string>();
  private tools = new Map<string, string>();

  constructor(private model: string) {}
  setModel(model: string): void { this.model = model; }

  private assistant(content: AssistantContentBlock[], model = this.model): AssistantMessage {
    return { role: "assistant", content, model, provider: "claude-code", timestamp: Date.now() };
  }

  consume(raw: unknown): AgentFrame[] {
    const frame = record(raw);
    // Subagents' private transcripts must not be appended as main-chat replies.
    if (frame.parent_tool_use_id) return [];
    if (frame.type === "stream_event") {
      const event = record(frame.event);
      if (event.type === "message_start") this.partial = this.assistant([]);
      if (!this.partial) this.partial = this.assistant([]);
      const index = typeof event.index === "number" ? event.index : -1;
      if (index >= 0 && event.type === "content_block_start") {
        const block = assistantBlock(event.content_block);
        if (block) this.partial.content[index] = block;
      }
      if (index >= 0 && event.type === "content_block_delta") {
        const delta = record(event.delta);
        const block = this.partial.content[index];
        if (block?.type === "text" && delta.type === "text_delta") block.text += String(delta.text ?? "");
        if (block?.type === "thinking" && delta.type === "thinking_delta") block.thinking += String(delta.thinking ?? "");
      }
      const snapshot = { ...this.partial, content: this.partial.content.filter(Boolean).map((b) => ({ ...b })) };
      return snapshot.content.length ? [{ type: "message_update", message: snapshot }] : [];
    }
    const localOutput = frame.type === "system" && frame.subtype === "local_command_output" && typeof frame.content === "string";
    if (frame.type !== "assistant" && frame.type !== "user" && !localOutput) return [];
    if (typeof frame.uuid === "string") {
      if (this.seen.has(frame.uuid)) return [];
      this.seen.add(frame.uuid);
    }
    if (localOutput) {
      return frame.content ? [{ type: "message_end", message: this.assistant([{ type: "text", text: frame.content as string }]) }] : [];
    }
    const message = record(frame.message);
    const blocks = Array.isArray(message.content) ? message.content : [];
    const events: AgentFrame[] = [];
    if (frame.type === "assistant") {
      this.partial = undefined;
      const content = blocks.map(assistantBlock).filter((b): b is AssistantContentBlock => Boolean(b));
      const result = this.assistant(content, typeof message.model === "string" ? message.model : this.model);
      if (typeof message.stop_reason === "string") result.stopReason = message.stop_reason;
      const usage = record(message.usage);
      if (Object.keys(usage).length) result.usage = {
        input: Number(usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cache_read_input_tokens) || 0, cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
        // Proxy prices need not match Anthropic prices. Do not invent a monetary estimate.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      if (content.length) events.push({ type: "message_end", message: result });
      for (const block of content) {
        if (block.type !== "toolCall" || this.tools.has(block.toolCallId)) continue;
        this.tools.set(block.toolCallId, block.toolName);
        events.push({ type: "tool_execution_start", toolCallId: block.toolCallId, toolName: block.toolName });
      }
    } else {
      // Input messages are emitted by the sender; SDK user messages contain tool results.
      for (const rawBlock of blocks) {
        const b = record(rawBlock);
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const result: AgentMessage = {
          role: "toolResult", toolCallId: b.tool_use_id, toolName: this.tools.get(b.tool_use_id),
          content: mediaContent(b.content), isError: b.is_error === true, timestamp: Date.now(),
        };
        events.push({ type: "tool_execution_end", toolCallId: b.tool_use_id, toolName: result.toolName });
        events.push({ type: "message_end", message: result });
      }
    }
    return events;
  }

  resetTurn(): void {
    this.partial = undefined;
    this.seen.clear();
    this.tools.clear();
  }
}
