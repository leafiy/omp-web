import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage, SessionHeader } from "./types";

/** A native rewind marker: the projection branches before the rewound user entry. */
const REWIND_MARKER = "native_rewind";
const PERMISSION_MODE = "web_permission_mode";

interface ProjectedEntry {
  id: string;
  parentId: string | null;
  type: string;
  message?: AgentMessage;
  nativeUuid?: string;
  customType?: string;
  data?: Record<string, unknown>;
}

/** One message on the active projection branch, with the native entry UUID when known. */
export interface ProjectedMessage {
  entryId: string;
  message: AgentMessage;
  nativeUuid?: string;
}

/** Display projection only. The native CLI, not this JSONL, owns model context. */
export class WebSessionTranscript {
  readonly path: string;
  private leaf: string | null = null;
  private entries = new Map<string, ProjectedEntry>();
  private title?: string;
  private selectedModel?: string;
  private selectedEffort?: string;
  private selectedPermissionMode?: string;
  private active: ProjectedMessage[] = [];
  private pendingResume?: string;
  constructor(
    readonly nativeId: string,
    readonly cwd: string,
    stateDir: string,
    private readonly provider: "claude-code" | "codex-cli",
    existingPath?: string,
    init: { parentSession?: string } = {},
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId)) throw new Error("Invalid native session UUID");
    const dir = join(stateDir, "sessions");
    this.path = join(dir, `${nativeId}.jsonl`);
    if (existingPath) {
      if (resolve(existingPath) !== this.path) throw new Error("Web projection path does not match session identity");
      const records = readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const header = records[0] as SessionHeader & { projection?: string };
      if (header.id !== nativeId || header.cwd !== cwd || header.projection !== provider) throw new Error(`Not a ${provider} web projection`);
      for (const raw of records.slice(1) as Array<Record<string, unknown>>) {
        if (typeof raw.id !== "string") continue;
        this.remember(raw);
        this.leaf = raw.id;
        if (raw.type === "session_info") this.title = raw.name as string | undefined;
        if (raw.type === "model_change") this.selectedModel = raw.modelId as string | undefined;
        if (raw.type === "thinking_level_change") this.selectedEffort = raw.thinkingLevel as string | undefined;
        const data = raw.data as Record<string, unknown> | undefined;
        if (raw.type === "custom" && raw.customType === PERMISSION_MODE && typeof data?.mode === "string") this.selectedPermissionMode = data.mode;
      }
      this.rebuild();
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify({
        type: "session", version: 3, id: nativeId, cwd, timestamp: new Date().toISOString(), projection: provider,
        ...(init.parentSession ? { parentSession: init.parentSession } : {}),
      }) + "\n", { flag: "wx", mode: 0o600 });
    }
  }
  private remember(raw: Record<string, unknown>): ProjectedEntry {
    const entry: ProjectedEntry = {
      id: raw.id as string,
      parentId: typeof raw.parentId === "string" ? raw.parentId : null,
      type: String(raw.type),
      ...(raw.type === "message" && raw.message ? { message: raw.message as AgentMessage } : {}),
      ...(typeof raw.nativeUuid === "string" ? { nativeUuid: raw.nativeUuid } : {}),
      ...(typeof raw.customType === "string" ? { customType: raw.customType } : {}),
      ...(raw.data && typeof raw.data === "object" ? { data: raw.data as Record<string, unknown> } : {}),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }
  /** Follow parent links from the leaf (iteratively: histories can be long). */
  private rebuild(): void {
    const chain: ProjectedEntry[] = [];
    const seen = new Set<string>();
    for (let id = this.leaf; id && !seen.has(id);) {
      seen.add(id);
      const entry = this.entries.get(id);
      if (!entry) break;
      chain.push(entry);
      id = entry.parentId;
    }
    chain.reverse();
    this.active = chain.flatMap((entry) => entry.type === "message" && entry.message
      ? [{ entryId: entry.id, message: entry.message, ...(entry.nativeUuid ? { nativeUuid: entry.nativeUuid } : {}) }]
      : []);
    // A rewind stays pending until the native engine has answered on the new branch.
    this.pendingResume = undefined;
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i];
      if (entry.type === "message" && entry.message?.role === "assistant") break;
      if (entry.type === "custom" && entry.customType === REWIND_MARKER && typeof entry.data?.resumeSessionAt === "string") {
        this.pendingResume = entry.data.resumeSessionAt;
        break;
      }
    }
  }
  append(message: AgentMessage, nativeUuid?: string): void {
    const id = this.record({ type: "message", message, ...(nativeUuid ? { nativeUuid } : {}) });
    this.active.push({ entryId: id, message, ...(nativeUuid ? { nativeUuid } : {}) });
    if (message.role === "assistant") this.pendingResume = undefined;
  }
  rename(name: string): void { this.record({ type: "session_info", name }); this.title = name; }
  setModel(model: string): void { this.record({ type: "model_change", provider: this.provider, modelId: model }); this.selectedModel = model; }
  setEffort(level: string): void { this.record({ type: "thinking_level_change", thinkingLevel: level }); this.selectedEffort = level; }
  setPermissionMode(mode: string): void {
    if (mode === this.selectedPermissionMode) return;
    this.record({ type: "custom", customType: PERMISSION_MODE, data: { mode } });
    this.selectedPermissionMode = mode;
  }
  /**
   * Branch the display projection before `entryId` (a user message on the active
   * branch). The previous branch stays in the file; the native resume point is
   * recorded until the engine answers on the new branch.
   */
  rewindBefore(entryId: string, data: { resumeSessionAt: string; nativeUuid: string }): void {
    const target = this.entries.get(entryId);
    if (!target || target.type !== "message" || target.message?.role !== "user" || !this.active.some((item) => item.entryId === entryId)) {
      throw new Error("Rewind target is not a user message on the active branch");
    }
    this.record({ type: "custom", customType: REWIND_MARKER, data }, target.parentId);
    this.rebuild();
  }
  get effort(): string | undefined { return this.selectedEffort; }
  get permissionMode(): string | undefined { return this.selectedPermissionMode; }
  /** Native chain entry to resume at after an unanswered conversation rewind. */
  get pendingResumeAt(): string | undefined { return this.pendingResume; }
  private record(payload: Record<string, unknown>, parentId: string | null = this.leaf): string {
    const id = randomUUID();
    const raw = { ...payload, id, parentId, timestamp: new Date().toISOString() };
    appendFileSync(this.path, JSON.stringify(raw) + "\n", { mode: 0o600 });
    this.remember(raw);
    this.leaf = id;
    return id;
  }
  get name(): string | undefined { return this.title; }
  get model(): string | undefined { return this.selectedModel; }
  getMessages(): AgentMessage[] { return this.active.map((item) => item.message); }
  getProjectedMessages(): ProjectedMessage[] { return this.active.map((item) => ({ ...item })); }
}
