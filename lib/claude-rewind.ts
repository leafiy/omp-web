import type { ProjectedMessage } from "./web-session-transcript";
import type { UserMessage } from "./types";

/** One entry of Claude Code's native conversation chain (user/assistant only). */
export interface NativeChainEntry {
  type: string;
  uuid: string;
  message: unknown;
}

export interface NativeRewindTarget {
  /** Index of the target user entry in the native chain. */
  index: number;
  /** Native UUID of the target user entry. */
  uuid: string;
  /** Index of the target in the projected (displayed) branch. */
  position: number;
}

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
    && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []).join("\n");
}

export function projectedUserText(message: UserMessage): string {
  return blocksText(message.content);
}

function nativeUserText(message: unknown): string {
  return message && typeof message === "object" ? blocksText((message as { content?: unknown }).content) : "";
}

function isToolResultOnly(message: unknown): boolean {
  const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  return Array.isArray(content) && content.length > 0
    && content.every((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "tool_result");
}

/**
 * Map a displayed user message to its native entry. Messages sent since native
 * UUIDs were recorded match exactly; older projections fall back to matching
 * text by occurrence, and anything ambiguous fails instead of guessing.
 */
export function resolveNativeTarget(projected: readonly ProjectedMessage[], entryId: string, chain: readonly NativeChainEntry[]): NativeRewindTarget {
  const position = projected.findIndex((item) => item.entryId === entryId);
  const target = projected[position];
  if (!target || target.message.role !== "user") throw new Error("Choose a user message on the current branch");
  if (target.nativeUuid) {
    const index = chain.findIndex((entry) => entry.uuid === target.nativeUuid);
    if (index >= 0) return { index, uuid: target.nativeUuid, position };
  }
  const text = projectedUserText(target.message).trim();
  if (!text) throw new Error("Claude Code's native history does not identify this message");
  const sameText = (item: ProjectedMessage) => item.message.role === "user" && projectedUserText(item.message).trim() === text;
  const occurrence = projected.slice(0, position).filter(sameText).length;
  const total = projected.filter(sameText).length;
  const candidates = chain.flatMap((entry, index) => entry.type === "user" && !isToolResultOnly(entry.message) && nativeUserText(entry.message).trim() === text ? [index] : []);
  const index = candidates.length === 1 && total === 1 ? candidates[0] : candidates.length === total ? candidates[occurrence] : undefined;
  if (index === undefined) {
    throw new Error(candidates.length
      ? "This message appears more than once in Claude Code's history and cannot be matched safely"
      : "This message is not in Claude Code's active native history (it may precede a compaction)");
  }
  return { index, uuid: chain[index].uuid, position };
}
