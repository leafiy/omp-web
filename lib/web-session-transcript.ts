import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage, SessionEntry, SessionHeader } from "./types";

/** Display projection only. The native CLI, not this JSONL, owns model context. */
export class WebSessionTranscript {
  readonly path: string;
  private leaf: string | null = null;
  private title?: string;
  private selectedModel?: string;
  private messages: AgentMessage[] = [];
  constructor(readonly nativeId: string, readonly cwd: string, stateDir: string, private readonly provider: "claude-code" | "codex-cli", existingPath?: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId)) throw new Error("Invalid native session UUID");
    const dir = join(stateDir, "sessions");
    this.path = join(dir, `${nativeId}.jsonl`);
    if (existingPath) {
      if (resolve(existingPath) !== this.path) throw new Error("Web projection path does not match session identity");
      const records = readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const header = records[0] as SessionHeader & { projection?: string };
      if (header.id !== nativeId || header.cwd !== cwd || header.projection !== provider) throw new Error(`Not a ${provider} web projection`);
      for (const entry of records.slice(1) as SessionEntry[]) {
        this.leaf = entry.id;
        if (entry.type === "message") this.messages.push(entry.message);
        if (entry.type === "session_info") this.title = entry.name;
        if (entry.type === "model_change") this.selectedModel = entry.modelId;
      }
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify({ type: "session", version: 3, id: nativeId, cwd, timestamp: new Date().toISOString(), projection: provider }) + "\n", { flag: "wx", mode: 0o600 });
    }
  }
  append(message: AgentMessage): void { this.record({ type: "message", message }); this.messages.push(message); }
  rename(name: string): void { this.record({ type: "session_info", name }); this.title = name; }
  setModel(model: string): void { this.record({ type: "model_change", provider: this.provider, modelId: model }); this.selectedModel = model; }
  private record(payload: Record<string, unknown>): void {
    const id = randomUUID();
    appendFileSync(this.path, JSON.stringify({ ...payload, id, parentId: this.leaf, timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 });
    this.leaf = id;
  }
  get name(): string | undefined { return this.title; }
  get model(): string | undefined { return this.selectedModel; }
  getMessages(): AgentMessage[] { return [...this.messages]; }
}
