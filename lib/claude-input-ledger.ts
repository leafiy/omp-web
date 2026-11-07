import type { UserMessage } from "./types";

export type ClaudeInputKind = "prompt" | "steer" | "follow_up";
interface Entry { message: UserMessage; kind: ClaudeInputKind; started: boolean; displayed: boolean; }

/** Track web sends by native UUID, not text, counters or the latest send alone. */
export class ClaudeInputLedger {
  private entries = new Map<string, Entry>();
  get size(): number { return this.entries.size; }
  has(id: string): boolean { return this.entries.has(id); }
  ids(): string[] { return [...this.entries.keys()]; }
  add(id: string, message: UserMessage, kind: ClaudeInputKind): void {
    this.entries.set(id, { message, kind, started: false, displayed: kind === "prompt" });
  }
  started(ids: string[]): UserMessage[] {
    const delivered: UserMessage[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.started = true;
      if (!entry.displayed) { entry.displayed = true; delivered.push(entry.message); }
    }
    return delivered;
  }
  complete(ids: string[]): UserMessage[] {
    const delivered = this.started(ids);
    for (const id of ids) this.entries.delete(id);
    return delivered;
  }
  cancel(ids: string[], onlyUnstarted = false): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry && (!onlyUnstarted || !entry.started)) this.entries.delete(id);
    }
  }
  resultIds(frame: { user_message_uuid?: unknown; user_message_uuids?: unknown }): string[] {
    const ids = [...new Set([...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : []), frame.user_message_uuid])].filter((id): id is string => typeof id === "string");
    if (ids.length) return ids.filter((id) => this.entries.has(id));
    // Legacy one-prompt replies have no join key. Never guess for queued sends.
    const single = [...this.entries.entries()];
    return single.length === 1 && single[0][1].kind === "prompt" ? [single[0][0]] : [];
  }
  queued() {
    const steering: string[] = [], followUp: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.started || entry.kind === "prompt") continue;
      const text = typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      (entry.kind === "steer" ? steering : followUp).push(text);
    }
    return { steering, followUp };
  }
  unstartedIds(): string[] { return [...this.entries].filter(([, entry]) => !entry.started).map(([id]) => id); }
  clear(): void { this.entries.clear(); }
}
