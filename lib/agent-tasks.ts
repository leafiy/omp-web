import { randomUUID } from "node:crypto";
import type { AgentEngine } from "./engine";
import type { AgentFrame } from "./agent-rpc-client";
import type { AgentTask, AgentTaskSnapshot, AgentTaskStatus, AgentTaskDetail, AgentTaskTranscript } from "./agent-task-types";
import { taskTranscript } from "./agent-task-messages";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | undefined => typeof v === "string" ? v.slice(0, 500) : undefined;
const status = (v: unknown): AgentTaskStatus => {
  if (["running", "started", "pending", "pendingInit", "inProgress", "spawning", "active"].includes(String(v))) return "running";
  if (["completed", "done", "success", "idle"].includes(String(v))) return "completed";
  if (["failed", "error", "errored", "systemError"].includes(String(v))) return "failed";
  if (["cancelled", "canceled", "stopped", "shutdown", "interrupted", "aborted"].includes(String(v))) return "stopped";
  return "unknown";
};

/** Process-scoped task projection. No transcripts, prompts or filesystem paths leave this seam. */
export class AgentTasks {
  private readonly epoch = randomUUID();
  private revision = 0;
  private tasks = new Map<string, AgentTask>();
  private transcripts = new Map<string, AgentTaskTranscript>();
  private coverage: AgentTaskSnapshot["coverage"] = "partial";
  private claudeBackground?: Set<string>;
  constructor(private readonly engine: AgentEngine, private readonly changed: (frame: AgentFrame) => void) {}
  snapshot(): AgentTaskSnapshot { return { epoch: this.epoch, revision: this.revision, coverage: this.coverage, tasks: [...this.tasks.values()].map(t => ({ ...t })) }; }
  get active(): boolean { return [...this.tasks.values()].some(t => t.active && !t.ambient); }
  get version(): number { return this.revision; }
  ids(): string[] { return [...this.tasks.values()].filter(t => t.active).map(t => t.id); }
  has(id: string): boolean { return this.tasks.has(id); }
  detail(id: string, transcript = this.transcripts.get(id)): AgentTaskDetail {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task in this session");
    return { task: { ...task }, available: transcript !== undefined, messages: transcript?.messages.map(message => ({ ...message })) ?? [], truncated: transcript?.truncated ?? false };
  }
  private publish(): void {
    // Keep all live tasks, but only a bounded tail of completed tasks.
    const ended = [...this.tasks.values()].filter(t => !t.active);
    for (const t of ended.slice(0, Math.max(0, ended.length - 100))) { this.tasks.delete(t.id); this.transcripts.delete(t.id); }
    this.revision++;
    this.changed({ type: "task_snapshot", snapshot: this.snapshot() });
  }
  private put(id: string, patch: Partial<AgentTask>): void {
    const old = this.tasks.get(id);
    if (old?.runId && patch.runId && patch.runId < old.runId) return;
    const base = old && (!patch.runId || patch.runId === old.runId) ? old : undefined;
    this.tasks.set(id, { id, title: id, kind: "subagent", status: "unknown", active: false, ...base, ...patch, updatedAt: Date.now() });
  }
  unavailable(): void { this.coverage = "unavailable"; this.publish(); }
  disconnected(): void {
    for (const t of this.tasks.values()) if (t.active) this.put(t.id, { active: false, status: "unknown" });
    this.coverage = "unavailable"; this.publish();
  }

  claude(raw: Record<string, unknown>): void {
    if (raw.type !== "system") return;
    if (raw.subtype === "background_tasks_changed" && Array.isArray(raw.tasks)) {
      const next = new Set<string>();
      for (const value of raw.tasks) {
        const t = obj(value), id = text(t.task_id);
        if (!id) continue;
        next.add(id);
        this.put(id, { title: text(t.description) || id, kind: text(t.task_type) || "task", runId: text(t.run_id), parentId: text(t.parent_task_id), ambient: t.ambient === true, active: true, status: "running" });
      }
      // Membership is authoritative only for background tasks, not foreground agents.
      for (const id of this.claudeBackground ?? []) if (!next.has(id)) {
        const t = this.tasks.get(id);
        if (t?.active) this.put(id, { active: false, status: "unknown" });
      }
      this.claudeBackground = next;
      this.coverage = "native"; this.publish(); return;
    }
    if (!["task_started", "task_updated", "task_progress", "task_notification"].includes(String(raw.subtype))) return;
    const id = text(raw.task_id);
    if (!id) return;
    const old = this.tasks.get(id), runId = text(raw.run_id);
    if (old?.runId && runId && runId < old.runId) return;
    const terminal = raw.subtype === "task_notification";
    const patch = obj(raw.patch);
    const nextStatus = terminal ? status(raw.status) : patch.status ? status(patch.status) : "running";
    // A delayed progress edge cannot resurrect an already finished run.
    if (!terminal && old && !old.active && old.status !== "unknown" && (!runId || runId === old.runId)) return;
    this.put(id, {
      ...(runId ? { runId } : {}),
      title: text(raw.description) || text(patch.description) || old?.title || id,
      kind: text(raw.task_type) || old?.kind || "task",
      ...(typeof raw.ambient === "boolean" ? { ambient: raw.ambient } : {}),
      ...(text(raw.parent_task_id) ? { parentId: text(raw.parent_task_id) } : {}),
      status: nextStatus, active: nextStatus === "running",
      ...(text(raw.last_tool_name) ? { detail: text(raw.last_tool_name) } : {}),
      ...(text(raw.summary) ? { detail: text(raw.summary) } : {}),
    });
    this.publish();
  }

  omp(frame: AgentFrame): void {
    if (frame.type !== "subagent_lifecycle" && frame.type !== "subagent_progress") return;
    const p = obj(frame.payload), progress = obj(p.progress), id = text(p.id) || text(progress.id);
    if (!id) return;
    const s = status(progress.status ?? p.status);
    const old = this.tasks.get(id);
    if (frame.type === "subagent_progress" && old && !old.active && old.status !== "unknown") return;
    this.put(id, { title: text(progress.description) || text(p.description) || text(p.agent) || old?.title || id, status: s, active: s === "running" });
    this.publish();
  }
  ompSnapshot(value: unknown, requestedAt: number): void {
    if (requestedAt !== this.revision || !Array.isArray(value)) return; // An event overtook this query.
    const seen = new Set<string>();
    for (const raw of value) {
      const t = obj(raw), id = text(t.id);
      if (!id) continue;
      seen.add(id); const s = status(t.status);
      this.put(id, { title: text(t.description) || text(t.agent) || id, status: s, active: s === "running" });
    }
    for (const t of this.tasks.values()) if (t.active && !seen.has(t.id)) this.put(t.id, { active: false, status: "unknown" });
    this.coverage = "native"; this.publish();
  }

  /** Only called for a validated parent turn. Child IDs are never learned from arbitrary notifications. */
  codexItem(value: unknown, parentId?: string): void {
    const item = obj(value);
    if (item.type !== "collabAgentToolCall" || !Array.isArray(item.receiverThreadIds)) return;
    const states = obj(item.agentsStates);
    for (const value of item.receiverThreadIds) {
      const id = text(value); if (!id || id === parentId) continue;
      // A send/wait targeting an unrelated existing thread is not proof of parentage.
      if (!this.tasks.has(id) && item.tool !== "spawnAgent") continue;
      const state = obj(states[id]);
      const s = status(state.status);
      const old = this.tasks.get(id);
      // Tool completion alone is NOT child completion. Preserve known child state.
      this.put(id, { title: text(state.agentNickname) || old?.title || `Agent ${id.slice(0, 8)}`, status: s === "unknown" ? old?.status || "running" : s, active: s === "unknown" ? old?.active ?? true : s === "running" });
    }
    this.publish();
  }
  codexUnavailable(id: string): void {
    if (!this.tasks.has(id)) return;
    this.put(id, { status: "unknown" }); this.publish();
  }
  codexStatus(id: string, value: unknown): void {
    if (!this.tasks.has(id)) return;
    const s = status(obj(value).type ?? value);
    this.put(id, { status: s, active: s === "running" }); this.publish();
  }

  pi(frame: AgentFrame): void {
    const call = text(frame.toolCallId);
    if (!call) return;
    if (frame.type === "tool_execution_start" && frame.toolName === "subagent") {
      this.put(call, { title: "subagent", status: "running", active: true, detail: "details_unavailable" }); this.publish(); return;
    }
    if (!["tool_execution_update", "tool_execution_end"].includes(frame.type) || !this.tasks.has(call)) return;
    const result = obj(frame.partialResult ?? frame.result), details = obj(result.details);
    const ended = frame.type === "tool_execution_end";
    // Known official extension contract only. Do not forward its messages/stderr/task prompts.
    if (["single", "parallel", "chain"].includes(String(details.mode)) && Array.isArray(details.results)
      && details.results.length > 0 && details.results.every(raw => typeof obj(raw).agent === "string" && typeof obj(raw).exitCode === "number")) {
      this.put(call, { active: false, status: "unknown", hidden: true });
      details.results.forEach((raw, index) => {
        const t = obj(raw);
        if (typeof t.agent !== "string" || typeof t.exitCode !== "number") return;
        const id = `${call}:${typeof t.step === "number" ? t.step : index}`;
        // The example initializes exitCode to 0 before spawning: only the final tool result proves completion.
        const s = !ended ? "running" : t.stopReason === "aborted" ? "stopped" : t.stopReason === "error" ? "failed" : t.exitCode === 0 ? "completed" : t.exitCode === -1 ? "unknown" : "failed";
        this.put(id, { parentId: call, title: text(t.agent) || id, status: s, active: s === "running" });
        if (Array.isArray(t.messages)) this.transcripts.set(id, taskTranscript(t.messages));
      });
    } else if (ended) this.put(call, { active: false, status: frame.isError === true ? "failed" : "unknown" });
    if (ended) for (const t of this.tasks.values()) if (t.parentId === call && t.active) this.put(t.id, { active: false, status: "unknown" });
    this.publish();
  }
}
