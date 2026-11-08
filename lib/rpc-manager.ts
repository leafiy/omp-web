import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { AgentRpcClient, type AgentFrame, type AgentProcessOptions } from "./agent-rpc-client";
import { engineForSession, nativeSessionId, parseEngine, sessionKey, type AgentEngine } from "./engine";
import { piWebEvent, piWireCommand } from "./pi-rpc-adapter";
import { AgentTasks } from "./agent-tasks";
import { taskTranscript } from "./agent-task-messages";
import { ClaudeCodeSession } from "./claude-code-session";
import { CodexSession } from "./codex-session";
import { FollowUpSession } from "./follow-up-session";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { cacheSessionPath, invalidateSessionListCache, readSessionHeader } from "./session-reader";
import { generateRpcSessionTitle } from "./rpc-session-title";

export type AgentEvent = AgentFrame;
type EventListener = (event: AgentEvent) => void;

export interface RpcSessionStartOptions {
  engine?: AgentEngine;
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

interface NativeState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  model?: { id: string; provider: string; contextWindow?: number };
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  isSettled?: boolean;
  hasPendingAsyncWork?: boolean;
  queuedMessageCount?: number;
  pendingMessageCount?: number;
  queuedMessages?: { steering: string[]; followUp: string[] };
  systemPrompt?: string | string[];
  dumpTools?: Array<{ name: string; description: string }>;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  [key: string]: unknown;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const FORWARDED_COMMANDS = new Set([
  "abort", "steer", "follow_up", "set_model", "set_thinking_level", "compact",
  "set_session_name", "get_last_assistant_text", "set_auto_compaction", "set_auto_retry",
  "abort_bash", "get_available_models", "get_available_thinking_levels", "get_entries",
  "get_tree", "get_messages", "get_subagents", "get_subagent_messages", "cancel_subagent",
  "steer_subagent", "remove_queued_message", "export_html",
]);

/** Web command/event adapter. Agent execution belongs to the pinned native child. */
export class AgentSessionWrapper {
  readonly engine: AgentEngine;
  private client: AgentRpcClient;
  private state: NativeState = { sessionId: "" };
  private listeners = new Set<EventListener>();
  private pendingUi = new Map<string, AgentEvent>();
  private uiTimers = new Map<string, NodeJS.Timeout>();
  private statuses = new Map<string, string>();
  private widgets = new Map<string, { key: string; lines: string[]; placement: string }>();
  private prompts = new Set<string>();
  private acceptedPiPrompts = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private onDestroyCallback?: () => void;
  private initializing = true;
  private shuttingDown = false;
  private transitioning = false;
  private busy = false;
  private bashRunning = false;
  private compactionRunning = false;
  private startupNotices: AgentEvent[] = [];
  private activeLeafId: string | null | undefined;
  private activityRevision = 0;
  private sessionNameRevision = 0;
  private readonly tasks: AgentTasks;
  private tasksSupported = false;

  constructor(private readonly options: AgentProcessOptions, client: AgentRpcClient = new AgentRpcClient(options)) {
    this.engine = parseEngine(options.engine);
    this.tasks = new AgentTasks(this.engine, event => { this.emit(event); notifyRunningChange(); });
    this.client = client;
    this.client.onFrame((frame) => this.handleFrame(frame));
    this.client.onClose((error) => {
      clearTimeout(this.idleTimer);
      if (!this.shuttingDown) this.emit({ type: "prompt_error", errorMessage: error.message });
      this.tasks.disconnected();
      this.prompts.clear();
      this.acceptedPiPrompts.clear();
      this.busy = false;
      this.emit({ type: "prompt_done" });
      this.emit({ type: "agent_settled" });
      this.cancelUiRequests();
      this.onDestroyCallback?.();
      notifyRunningChange();
    });
  }

  get sessionId(): string { return this.state.sessionId; }
  private get label(): string { return this.engine === "pi" ? "Pi" : "OMP"; }
  get sessionFile(): string { return this.state.sessionFile ?? ""; }
  get cwd(): string { return this.options.cwd; }
  generateSessionTitle(prompt: string, signal: AbortSignal): Promise<string> {
    return generateRpcSessionTitle({
      engine: this.engine, cwd: this.cwd,
      ...(this.state.model ? { initialModel: { provider: this.state.model.provider, modelId: this.state.model.id } } : {}),
    }, prompt, signal);
  }
  getActiveLeafId(): string | null | undefined { return this.activeLeafId; }
  isAlive(): boolean { return this.client.isAlive() && !this.shuttingDown; }
  isRunning(): boolean {
    return this.isAlive() && (this.busy || this.tasks.active || this.bashRunning || this.compactionRunning || this.prompts.size > 0 || this.transitioning);
  }

  async start(): Promise<void> {
    try {
      await this.client.start();
      await this.refreshState();
      if (!this.sessionId || !this.sessionFile || !this.isAlive()) throw new Error(`${this.label} did not return a live persistent session identity`);
      if (this.engine === "omp") {
        try {
          await this.client.request({ type: "set_subagent_subscription", level: "progress" }, 10_000);
          this.tasksSupported = true;
          await this.refreshTasks();
        } catch { this.tasks.unavailable(); }
      }
      this.initializing = false;
      this.resetIdleTimer();
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  async waitUntilReady(): Promise<void> {
    if (this.initializing || !this.isAlive()) throw new Error(`Local ${this.label} session is not ready`);
  }

  onDestroy(callback: () => void): void { this.onDestroyCallback = callback; }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    listener({ type: "task_snapshot", snapshot: this.tasks.snapshot() });
    if (this.sessionId && (this.sessionNameRevision > 0 || this.state.sessionName !== undefined)) {
      listener({ type: "session_info_update", sessionId: this.sessionId, title: this.state.sessionName ?? "" });
    }
    for (const event of this.pendingUi.values()) listener(event);
    for (const event of this.startupNotices.splice(0)) listener(event);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* disconnected SSE clients must not break transport */ }
    }
  }

  private completePrompt(id: string, error?: string): void {
    if (!this.prompts.delete(id)) return;
    this.acceptedPiPrompts.delete(id);
    if (error) this.emit({ type: "prompt_error", errorMessage: error });
    if (this.prompts.size === 0) this.emit({ type: "prompt_done" });
    invalidateSessionListCache();
    this.resetIdleTimer();
    notifyRunningChange();
  }

  private handleFrame(frame: AgentFrame): void {
    if (frame.type === "response") {
      if (frame.command === "prompt" && typeof frame.id === "string") {
        const data = frame.data as { agentInvoked?: boolean } | undefined;
        if (frame.success === false) this.completePrompt(frame.id, String(frame.error ?? `${this.label} prompt failed`));
        else if (this.engine === "omp" && data?.agentInvoked === false) this.completePrompt(frame.id);
        else if (this.engine === "pi" && this.prompts.has(frame.id)) this.acceptedPiPrompts.add(frame.id);
      }
      return;
    }
    this.activityRevision++;
    if (this.engine === "omp") this.tasks.omp(frame);
    else this.tasks.pi(frame);
    if (this.engine === "omp" && frame.type === "prompt_result") {
      // Late completion of an older prompt must not settle a newer prompt.
      if (typeof frame.id !== "string" || !this.prompts.has(frame.id)) return;
      if (frame.sessionSettled === true && this.prompts.size === 1) this.busy = false;
      const error = frame.error as { message?: string } | undefined;
      if (typeof frame.id === "string") this.completePrompt(frame.id, frame.status === "error" ? error?.message ?? "OMP prompt failed" : undefined);
      return;
    }
    if (frame.type === (this.engine === "pi" ? "agent_settled" : "session_settled")) {
      this.busy = false;
      if (this.engine === "pi") {
        // Native Pi emits this only after retry, compaction and queued continuations.
        // An unacknowledged prompt may still be in preflight; it owns its own completion.
        for (const id of this.acceptedPiPrompts) this.completePrompt(id);
        this.acceptedPiPrompts.clear();
      }
      if (this.engine === "omp" || this.prompts.size === 0) this.emit({ type: "agent_settled" });
    } else if (frame.type === "session_info_update" || this.engine === "pi" && frame.type === "session_info_changed") {
      if (frame.type === "session_info_update" && frame.sessionId !== nativeSessionId(this.sessionId)) return;
      const title = frame.type === "session_info_changed" ? frame.name : frame.title;
      if (title !== undefined && typeof title !== "string") return;
      this.sessionNameRevision++;
      this.state.sessionName = title;
      invalidateSessionListCache();
      this.emit({ type: "session_info_update", sessionId: this.sessionId, title: title ?? "" });
    } else if (frame.type === "queue_update") {
      this.state.queuedMessages = {
        steering: Array.isArray(frame.steering) ? frame.steering as string[] : [],
        followUp: Array.isArray(frame.followUp) ? frame.followUp as string[] : [],
      };
      this.state.queuedMessageCount = this.state.queuedMessages.steering.length + this.state.queuedMessages.followUp.length;
      this.emit(frame);
    } else if (frame.type === "extension_ui_request") {
      this.handleUiRequest(frame);
    } else if (frame.type === "command_output" || frame.type === "notice") {
      this.emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message: frame.text ?? frame.message, notifyType: frame.level ?? "info" });
    } else if (frame.type === "rpc_frame_error") {
      this.emit({ type: "prompt_error", errorMessage: "OMP could not transmit an oversized event. The full transcript remains in the local session file." });
    } else {
      if (frame.type === "agent_start") this.busy = true;
      if (frame.type === "message_end" || frame.type === "entry_appended") this.activeLeafId = undefined;
      // agent_end is a yield, not quiescence: async task/bash results can resume it.
      if (frame.type === "agent_end" || frame.type === "message_end") invalidateSessionListCache();
      if (["auto_compaction_start", "manual_compaction_start", "compaction_start"].includes(frame.type)) this.compactionRunning = true;
      if (["auto_compaction_end", "manual_compaction_end", "compaction_end"].includes(frame.type)) this.compactionRunning = false;
      const type = frame.type === "manual_compaction_start" ? "compaction_start"
        : frame.type === "manual_compaction_end" ? "compaction_end" : frame.type;
      this.emit(this.engine === "pi" ? piWebEvent(frame) : { ...frame, type });
    }
    this.resetIdleTimer();
    notifyRunningChange();
  }

  private handleUiRequest(frame: AgentFrame): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    if (frame.method === "cancel" && typeof frame.targetId === "string") {
      clearTimeout(this.uiTimers.get(frame.targetId));
      this.uiTimers.delete(frame.targetId);
      this.pendingUi.delete(frame.targetId);
    } else if (DIALOG_METHODS.has(String(frame.method))) {
      if (this.initializing) {
        // No session id has reached the browser yet. Never approve a startup dialog blindly.
        this.client.write({ type: "extension_ui_response", id, cancelled: true });
        this.startupNotices.push({ type: "extension_ui_request", id: randomUUID(), method: "notify", notifyType: "warning", message: `${this.label} startup dialog was cancelled before the browser connected: ${String(frame.title ?? frame.method)}. Run the relevant command again in this chat or in the local ${this.label} terminal.` });
        return;
      }
      frame = { ...frame, ...(typeof frame.timeout === "number" ? { expiresAt: Date.now() + frame.timeout } : {}) };
      this.pendingUi.set(id, frame);
      // Pi resolves timeout/signal cancellation without emitting a cancel frame.
      if (this.engine === "pi" && typeof frame.timeout === "number" && frame.timeout > 0) {
        const timer = setTimeout(() => {
          this.uiTimers.delete(id);
          if (!this.pendingUi.delete(id)) return;
          this.emit({ type: "extension_ui_request", id: randomUUID(), method: "cancel", targetId: id });
        }, frame.timeout);
        timer.unref();
        this.uiTimers.set(id, timer);
      }
    } else if (frame.method === "setStatus" && typeof frame.statusKey === "string") {
      if (typeof frame.statusText === "string") this.statuses.set(frame.statusKey, frame.statusText);
      else this.statuses.delete(frame.statusKey);
    } else if (frame.method === "setWidget" && typeof frame.widgetKey === "string") {
      if (Array.isArray(frame.widgetLines)) this.widgets.set(frame.widgetKey, { key: frame.widgetKey, lines: frame.widgetLines as string[], placement: String(frame.widgetPlacement ?? "aboveEditor") });
      else this.widgets.delete(frame.widgetKey);
    }
    this.emit(frame);
  }

  private cancelUiRequests(respond = false): void {
    for (const targetId of this.pendingUi.keys()) {
      if (respond && this.client.isAlive()) this.client.write({ type: "extension_ui_response", id: targetId, cancelled: true });
      this.emit({ type: "extension_ui_request", id: randomUUID(), method: "cancel", targetId });
    }
    this.pendingUi.clear();
    for (const timer of this.uiTimers.values()) clearTimeout(timer);
    this.uiTimers.clear();
  }

  private async refreshState(): Promise<NativeState> {
    const revision = this.activityRevision;
    const nameRevision = this.sessionNameRevision;
    const native = await this.client.request<NativeState>({ type: "get_state" });
    if (!native || typeof native.sessionId !== "string" || !native.sessionId) throw new Error(`Invalid local ${this.label} session state`);
    const state = {
      ...native,
      sessionId: sessionKey(this.engine, native.sessionId),
      sessionName: nameRevision === this.sessionNameRevision ? native.sessionName : this.state.sessionName,
      ...(this.engine === "pi" ? {
        queuedMessageCount: native.pendingMessageCount ?? 0,
        queuedMessages: this.state.queuedMessages ?? { steering: [], followUp: [] },
      } : {}),
    };
    // Unexpected extension-driven session switches must not leave a stale registry key.
    if (this.state.sessionId && state.sessionId !== this.state.sessionId && !this.transitioning) {
      this.destroy();
      throw new Error(`${this.label} changed sessions outside the web controls. Reopen the new session from the sidebar.`);
    }
    const nameChanged = this.state.sessionId === state.sessionId
      && (this.state.sessionName ?? "") !== (state.sessionName ?? "");
    this.state = state;
    if (nameChanged) {
      this.sessionNameRevision++;
      invalidateSessionListCache();
      this.emit({ type: "session_info_update", sessionId: state.sessionId, title: state.sessionName ?? "" });
    }
    // Events can arrive in the same stdout read AFTER the response but BEFORE
    // this await resumes. Never let that older snapshot overwrite live activity.
    if (revision === this.activityRevision) {
      this.busy = state.isSettled === undefined ? Boolean(state.isStreaming || state.hasPendingAsyncWork) : !state.isSettled;
      this.compactionRunning = Boolean(state.isCompacting);
      if (this.engine === "pi" && !state.isStreaming && !state.isCompacting && this.acceptedPiPrompts.size) {
        // Pi's isStreaming includes retries/post-run continuations, not just token output.
        // Local extension commands can finish without emitting an agent lifecycle.
        for (const id of this.acceptedPiPrompts) this.completePrompt(id);
        if (!this.isRunning()) this.emit({ type: "agent_settled" });
      }
    }
    if (state.sessionFile) cacheSessionPath(state.sessionId, state.sessionFile);
    notifyRunningChange();
    return state;
  }

  private async refreshTasks(): Promise<void> {
    if (!this.tasksSupported) return;
    const revision = this.tasks.version;
    const result = await this.client.request<{ subagents: unknown[] }>({ type: "get_subagents" }, 10_000);
    this.tasks.ompSnapshot(result.subagents, revision);
  }

  private webState(): Record<string, unknown> {
    return {
      ...this.state,
      engine: this.engine,
      tasks: this.tasks.snapshot(),
      model: this.state.model ? { id: this.state.model.id, provider: this.state.model.provider } : undefined,
      isPromptRunning: this.busy || this.prompts.size > 0,
      isBashRunning: this.bashRunning,
      isCompacting: this.compactionRunning,
      pendingMessageCount: this.state.queuedMessageCount ?? 0,
      systemPrompt: Array.isArray(this.state.systemPrompt) ? this.state.systemPrompt.join("\n\n") : this.state.systemPrompt ?? "",
      extensionStatuses: [...this.statuses].map(([key, text]) => ({ key, text })),
      extensionWidgets: [...this.widgets.values()],
    };
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.isAlive()) throw new Error(`Local ${this.label} session is not running`);
    this.resetIdleTimer();
    const type = String(command.type);
    if (type === "extension_ui_response") {
      if (typeof command.id !== "string" || !this.pendingUi.has(command.id)) return null;
      this.client.write(command);
      this.pendingUi.delete(command.id);
      clearTimeout(this.uiTimers.get(command.id));
      this.uiTimers.delete(command.id);
      return null;
    }
    if (this.transitioning) throw new Error(`${this.label} session transition is in progress`);
    if (["prompt", "steer", "follow_up"].includes(type)) {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
      if (typeof command.message !== "string") throw new Error("message must be a string");
    }
    if (type === "get_task_detail") {
      const id = String(command.taskId ?? "");
      const detail = this.tasks.detail(id);
      if (this.engine === "pi") return detail;
      const result = await this.client.request<{ messages: unknown[] }>({ type: "get_subagent_messages", subagentId: id }, 10_000);
      return this.tasks.detail(id, taskTranscript(result.messages));
    }
    // Reject absent Pi capabilities before an OMP-only branch can translate them.
    const piCommand = this.engine === "pi" ? piWireCommand(command) : undefined;
    if (type === "get_state") {
      // A compact command holds OMP's serial command queue until completion.
      if (!this.compactionRunning) {
        await this.refreshState();
        try { await this.refreshTasks(); } catch { /* Keep last known tasks; query failure is not completion. */ }
      }
      return this.webState();
    }
    if (type === "get_tools") {
      const state = await this.refreshState();
      return (state.dumpTools ?? []).map((tool) => ({ ...tool, active: true }));
    }
    if (type === "get_commands") {
      const result = await this.client.request<{ commands: Array<{ name: string; description?: string; source: string }> }>({ type: this.engine === "pi" ? "get_commands" : "get_available_commands" });
      return { commands: result.commands.map((item) => ({ ...item, nativeSource: item.source, source: this.engine })) };
    }
    if (type === "set_tools") throw new Error("Tool selection is owned by local OMP configuration; Pi tool presets are not supported.");
    if (type === "extension_ui_input") throw new Error("Raw terminal UI is not available over OMP RPC. Use the embedded terminal for TUI-only commands.");
    if (type === "abort_compaction") throw new Error("This OMP RPC interface does not expose abort_compaction. Wait for compaction to finish.");
    if (type === "reload") return this.send({ type: "prompt", message: "/reload-plugins" });
    if (type === "prompt") {
      if (this.bashRunning) throw new Error("Cannot prompt while a shell command is running");
      const id = randomUUID();
      this.prompts.add(id);
      notifyRunningChange();
      try {
        const message = this.engine === "omp" && command.message === "/reload" ? "/reload-plugins" : command.message;
        const result = await this.client.request({ ...command, message }, 0, id);
        if (this.engine === "pi" && this.prompts.has(id)) {
          // Acceptance is not completion; native state also handles local-only commands.
          // A failed snapshot must not turn an accepted/running prompt into a rejection.
          try { await this.refreshState(); }
          catch (error) {
            if (this.isAlive()) this.emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", notifyType: "warning", message: `Pi accepted the prompt, but its state could not be refreshed: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
        return result;
      } catch (error) {
        this.completePrompt(id, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    if (type === "clear_queue") {
      // Remove only items still pending; never abort or clear+requeue a live run.
      const state = await this.refreshState();
      const removed = { steering: [] as string[], followUp: [] as string[] };
      for (const queue of ["steering", "followUp"] as const) {
        for (const message of state.queuedMessages?.[queue] ?? []) {
          const result = await this.client.request<{ removed: boolean }>({ type: "remove_queued_message", queue, message });
          if (result.removed) removed[queue].push(message);
        }
      }
      return removed;
    }
    if (type === "fork") {
      if (this.isRunning()) throw new Error(`Cannot fork a busy ${this.label} session`);
      this.transitioning = true;
      try {
        // The message's Fork button means 'before this user message'. OMP calls that branch.
        const wireCommand = piCommand ?? (command.entryId && command.includeEntry !== true
          ? { type: "branch", entryId: command.entryId }
          : { type: "fork", ...(command.entryId ? { entryId: command.entryId } : {}) });
        const result = await this.client.request<{ cancelled: boolean }>(wireCommand, 0);
        if (result.cancelled) return result;
        const state = await this.refreshState();
        const newSessionId = state.sessionId;
        invalidateSessionListCache();
        // The native process mutated its identity. Release it and the OLD registry key.
        await this.shutdown();
        return { cancelled: false, newSessionId, sessionId: newSessionId };
      } finally { this.transitioning = false; }
    }
    if (type === "navigate_tree") {
      if (this.isRunning()) throw new Error("Cannot navigate a busy OMP session");
      this.transitioning = true;
      try {
        const result = await this.client.request<{ cancelled: boolean }>({ type: "navigate_tree", entryId: command.targetId, summarize: false }, 0);
        if (!result.cancelled) {
          // OMP can move the leaf in memory before the next durable append.
          const snapshot = await this.client.request<{ leafId: string | null }>({ type: "get_entries" });
          this.activeLeafId = snapshot.leafId;
        }
        invalidateSessionListCache();
        return result;
      } finally { this.transitioning = false; }
    }
    if (type === "get_session_stats") {
      const stats = await this.client.request<Record<string, unknown>>(command);
      const state = await this.refreshState();
      return { ...stats, sessionId: this.sessionId, sessionName: state.sessionName, contextUsage: state.contextUsage };
    }
    if (type === "bash") {
      if (this.engine === "omp" && command.excludeFromContext === true) throw new Error("OMP RPC does not support !! (exclude from context). Use the embedded terminal instead.");
      if (this.isRunning()) throw new Error(`Cannot run a shell command while ${this.label} is busy`);
      this.bashRunning = true;
      notifyRunningChange();
      try {
        return await this.client.request({ type: "bash", command: command.command, ...(this.engine === "pi" ? { excludeFromContext: command.excludeFromContext } : {}) }, 0);
      }
      finally { this.bashRunning = false; invalidateSessionListCache(); this.resetIdleTimer(); notifyRunningChange(); }
    }
    if (this.engine === "omp" && !FORWARDED_COMMANDS.has(type)) throw new Error(`Unsupported OMP web command: ${type}`);
    if (type === "compact") this.compactionRunning = true;
    notifyRunningChange();
    try {
      const result = await this.client.request(piCommand ?? command, type === "compact" ? 0 : 60_000);
      if (this.engine === "pi" && type === "abort") this.cancelUiRequests(true);
      if (type === "set_model") invalidateModelsCache();
      invalidateSessionListCache();
      return result;
    } finally {
      if (type === "compact") this.compactionRunning = false;
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private resetIdleTimer(): void {
    clearTimeout(this.idleTimer);
    if (this.shuttingDown) return;
    this.idleTimer = setTimeout(() => {
      if (this.isRunning() || this.pendingUi.size) this.resetIdleTimer();
      else void this.shutdown();
    }, 10 * 60 * 1000);
    this.idleTimer.unref();
  }

  destroy(): void {
    this.shuttingDown = true;
    clearTimeout(this.idleTimer);
    this.cancelUiRequests(true);
    this.client.destroy();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearTimeout(this.idleTimer);
    this.cancelUiRequests(true);
    await this.client.shutdown();
  }
}

type WebAgentSession = FollowUpSession;
type StartedSession = { session: WebAgentSession; realSessionId: string };
declare global {
  var __ompWebSessions: Map<string, WebAgentSession> | undefined;
  var __ompWebStartLocks: Map<string, Promise<StartedSession>> | undefined;
  var __ompWebStartingCwds: Map<string, number> | undefined;
  var __ompWebRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRegistry(): Map<string, WebAgentSession> {
  if (!globalThis.__ompWebSessions) {
    globalThis.__ompWebSessions = new Map();
    const cleanup = () => globalThis.__ompWebSessions?.forEach((session) => session.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompWebSessions;
}

function normalizeCwd(cwd: string): string {
  try { return realpathSync(resolve(cwd)); } catch { return resolve(cwd); }
}

export function getRpcSession(id: string): WebAgentSession | undefined { return getRegistry().get(id); }

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const target = normalizeCwd(cwd);
  if (globalThis.__ompWebStartingCwds?.has(target)) return true;
  return [...getRegistry().values()].some((session) => normalizeCwd(session.cwd) === target && session.isRunning());
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const target = normalizeCwd(cwd);
  const sessions = [...getRegistry().values()].filter((session) => normalizeCwd(session.cwd) === target);
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  return [...getRegistry()].filter(([, session]) => session.isRunning()).map(([id]) => id);
}

export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = globalThis.__ompWebRunningListeners ??= new Set();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";
export function notifyRunningChange(): void {
  const listeners = globalThis.__ompWebRunningListeners;
  if (!listeners?.size) { lastRunningSnapshot = ""; return; }
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) { try { listener(ids); } catch { /* disconnected subscriber */ } }
}

export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<StartedSession> {
  const registry = getRegistry();
  const existing = registry.get(sessionId);
  const identityEngine = engineForSession(sessionId);
  const engine = sessionFile || existing || identityEngine !== "omp" ? identityEngine : parseEngine(options.engine);
  if (options.engine !== undefined && parseEngine(options.engine) !== engine) {
    throw new Error("Requested engine does not match the session's native engine");
  }
  if (existing?.isAlive()) return { session: existing, realSessionId: existing.sessionId };
  const locks = globalThis.__ompWebStartLocks ??= new Map();
  const lockKey = `${engine}:${sessionId}`;
  const inflight = locks.get(lockKey);
  if (inflight) return inflight;
  // A stale browser must not silently turn an explicitly tool-free request into a fully capable agent.
  if (options.toolNames !== undefined) throw new Error("Web tool presets are not supported. Configure tools in the selected local engine.");
  const header = sessionFile ? readSessionHeader(sessionFile) : null;
  if (sessionFile && (!header?.id || !header.cwd)) throw new Error(`Cannot read the ${engine} session header`);
  if (sessionFile && header?.id !== nativeSessionId(sessionId)) throw new Error("Session file identity does not match the requested session");
  const sessionCwd = sessionFile ? header!.cwd : cwd;
  if (!sessionCwd) throw new Error(`cwd is required for a new ${engine} session`);
  const startingCwds = globalThis.__ompWebStartingCwds ??= new Map();
  const cwdKey = normalizeCwd(sessionCwd);
  startingCwds.set(cwdKey, (startingCwds.get(cwdKey) ?? 0) + 1);
  const starting = (async () => {
    const processOptions = { engine, cwd: sessionCwd, sessionFile: sessionFile || undefined, initialModel: options.initialModel, thinkingLevel: options.thinkingLevel };
    const changed = () => { invalidateSessionListCache(); notifyRunningChange(); };
    const native = engine === "codex"
      ? new CodexSession({ ...processOptions, nativeId: header?.id }, changed)
      : engine === "claude"
        ? new ClaudeCodeSession({ ...processOptions, nativeId: header?.id }, changed)
        : new AgentSessionWrapper(processOptions);
    const session = new FollowUpSession(native, changed, !sessionFile);
    await session.start();
    const realSessionId = session.sessionId;
    if (sessionFile && realSessionId !== sessionId) {
      await session.shutdown();
      throw new Error(`${engine} resumed a different session; refusing to attach it to this conversation`);
    }
    session.onDestroy(() => { if (registry.get(realSessionId) === session) registry.delete(realSessionId); });
    registry.set(realSessionId, session);
    notifyRunningChange();
    return { session, realSessionId };
  })().finally(() => {
    locks.delete(lockKey);
    const remaining = (startingCwds.get(cwdKey) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(cwdKey, remaining);
    else startingCwds.delete(cwdKey);
  });
  locks.set(lockKey, starting);
  return starting;
}
