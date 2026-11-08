import { randomUUID } from "node:crypto";
import type { AgentFrame } from "./agent-rpc-client";
import type { AgentEngine } from "./engine";
import { buildSessionTitlePrompt, parseGeneratedSessionTitle } from "./session-title";
import { rememberContextUsage } from "./context-usage-cache";

export interface FollowUpNativeSession {
  readonly engine: AgentEngine;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  start(): Promise<void>;
  send(command: Record<string, unknown>): Promise<unknown>;
  generateSessionTitle(prompt: string, signal: AbortSignal): Promise<string>;
  isAlive(): boolean;
  isRunning(): boolean;
  /** A dialog (question/approval) is waiting for the browser user. */
  hasPendingDialog?(): boolean;
  getActiveLeafId(): string | null | undefined;
  waitUntilReady(): Promise<void>;
  onEvent(listener: (event: AgentFrame) => void): () => void;
  onDestroy(callback: () => void): void;
  destroy(): void;
  shutdown(): Promise<void>;
}

type Pending = { id: string; kind: "follow_up"; text: string; state: "queued" | "sending" | "unconfirmed"; source: "web" };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const PREFIX = "web-follow-up:";

/** A host-owned waiting queue, NOT a pretend native cancellation protocol.
 * Until claim, messages have never reached an engine. After claim, cancellation
 * fails closed. Ambiguous delivery is never retried automatically.
 */
export class FollowUpSession implements FollowUpNativeSession {
  private pending: Pending[] = [];
  private nativeQueue: { steering: string[]; followUp: string[]; items: unknown[] } = { steering: [], followUp: [], items: [] };
  private nativeRevision = 0;
  private readonly queueEpoch = randomUUID();
  private queueRevision = 0;
  private listeners = new Set<(event: AgentFrame) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private manualRequests = 0;
  private paused = false;
  private closed = false;
  private destroyed?: () => void;
  private detach: () => void;
  private titleInput?: string;
  private titleReply = "";
  private titleAttempted = false;
  private titleSuppressed = false;
  private titleController?: AbortController;
  private titleWork?: Promise<void>;
  private titleEvent?: AgentFrame;

  constructor(private readonly native: FollowUpNativeSession, private readonly changed: () => void, private readonly autoTitle = false) {
    this.detach = native.onEvent(event => {
      if (this.autoTitle && !this.titleAttempted && event.type === "message_end") {
        const message = object(event.message);
        if (message.role === "assistant") {
          this.titleReply = message.stopReason === "error" || message.stopReason === "aborted" ? ""
            : (typeof message.content === "string" ? message.content
              : Array.isArray(message.content) ? message.content.map(object).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "").slice(0, 3000);
        }
      }
      if (event.type === "session_info_update" || event.type === "session_info_changed") this.suppressTitle();
      if (event.type === "context_usage" && event.sessionId === this.sessionId) rememberContextUsage(this.sessionId, event.contextUsage);
      if (event.type === "prompt_error" && this.pending.length && !this.paused) {
        this.paused = true; this.queueChanged();
      }
      if (event.type === "queue_update") {
        this.nativeRevision++;
        this.nativeQueue = { steering: strings(event.steering), followUp: strings(event.followUp), items: Array.isArray(event.items) ? event.items : [] };
        this.queueChanged();
      } else this.emit(event);
      if (["agent_settled", "prompt_done", "task_snapshot", "compaction_end"].includes(event.type)) {
        this.schedule();
        this.maybeNameSession();
      }
    });
    native.onDestroy(() => {
      this.closed = true; clearTimeout(this.timer);
      this.suppressTitle();
      if (this.pending.length) {
        // Preserve a visible copy, but do not promise cancellation after process loss.
        this.pending = this.pending.map(item => ({ ...item, state: "unconfirmed" }));
        this.queueChanged();
      }
      this.detach(); this.destroyed?.(); this.changed();
    });
  }
  get engine() { return this.native.engine; }
  get sessionId() { return this.native.sessionId; }
  get sessionFile() { return this.native.sessionFile; }
  get cwd() { return this.native.cwd; }
  getActiveLeafId() { return this.native.getActiveLeafId(); }
  isAlive() { return !this.closed && this.native.isAlive(); }
  isRunning() { return this.isAlive() && (this.native.isRunning() || this.pending.length > 0 || this.manualRequests > 0 || Boolean(this.titleController)); }
  hasPendingDialog() { return this.isAlive() && (this.native.hasPendingDialog?.() ?? false); }
  waitUntilReady() { return this.native.waitUntilReady(); }
  generateSessionTitle(prompt: string, signal: AbortSignal) { return this.native.generateSessionTitle(prompt, signal); }
  async start() { try { await this.native.start(); } catch (error) { this.destroy(); throw error; } }
  onDestroy(callback: () => void) { this.destroyed = callback; }
  private mergedQueue() {
    return { steering: [...this.nativeQueue.steering], followUp: [...this.nativeQueue.followUp, ...this.pending.map(item => item.text)], items: [...this.nativeQueue.items, ...this.pending.map(item => ({ ...item }))], queueEpoch: this.queueEpoch, queueRevision: this.queueRevision, followUpPaused: this.paused };
  }
  private emit(event: AgentFrame) {
    for (const listener of this.listeners) { try { listener(event); } catch { /* Disconnected browser. */ } }
  }
  private queueChanged() { this.queueRevision++; this.emit({ type: "queue_update", ...this.mergedQueue(), webFollowUpPending: this.pending.length }); this.changed(); }
  onEvent(listener: (event: AgentFrame) => void): () => void {
    this.listeners.add(listener);
    // Replay native dialogs/statuses through the adapter that owns them; do not
    // consume startup notices early or retain private native transcript events.
    const stopReplay = this.native.onEvent(event => { if (event.type !== "queue_update") listener(event); });
    stopReplay();
    if (this.titleEvent) listener(this.titleEvent);
    listener({ type: "queue_update", ...this.mergedQueue(), webFollowUpPending: this.pending.length });
    return () => { this.listeners.delete(listener); };
  }
  private async state() {
    const revision = this.nativeRevision;
    const state = object(await this.native.send({ type: "get_state" }));
    if (!this.native.isAlive() || state.sessionId !== this.sessionId || (typeof state.isStreaming !== "boolean" && typeof state.isPromptRunning !== "boolean")) throw new Error("Native session state is unavailable");
    rememberContextUsage(this.sessionId, state.contextUsage);
    if (revision === this.nativeRevision) {
      const queue = object(state.queuedMessages);
      const next = { steering: strings(queue.steering), followUp: strings(queue.followUp), items: Array.isArray(state.queuedItems) ? state.queuedItems : [] };
      if (JSON.stringify(next) !== JSON.stringify(this.nativeQueue)) { this.nativeQueue = next; this.queueChanged(); }
    }
    return state;
  }
  private captureTitleInput(message: unknown) {
    if (!this.autoTitle || this.titleInput || this.titleSuppressed || typeof message !== "string") return;
    const text = message.trim();
    if (text && !text.startsWith("/") && !text.startsWith("!")) this.titleInput = text.slice(0, 3000);
  }
  private suppressTitle() {
    this.titleSuppressed = true;
    this.titleEvent = undefined;
    this.titleController?.abort();
  }
  private maybeNameSession() {
    if (!this.autoTitle || this.titleAttempted || this.titleSuppressed || !this.titleInput || !this.titleReply
      || !this.isAlive() || this.native.isRunning() || this.manualRequests || this.pending.length) return;
    this.titleAttempted = true;
    const controller = new AbortController();
    this.titleController = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Session title generation timed out")), 90_000);
    timeout.unref();
    this.changed();
    this.titleWork = this.nameSession(controller).catch(() => {
      if (this.isAlive() && !this.titleSuppressed) this.emit({
        type: "extension_ui_request", id: randomUUID(), method: "notify", notifyType: "warning",
        message: "Automatic session naming failed. You can set a title with Rename.",
      });
    }).finally(() => {
      clearTimeout(timeout);
      this.titleController = undefined;
      this.titleInput = undefined;
      this.titleReply = "";
      this.changed();
    });
  }
  private async nameSession(controller: AbortController) {
    const sessionId = this.sessionId;
    const mayWrite = () => !controller.signal.aborted && !this.titleSuppressed && this.isAlive() && this.sessionId === sessionId;
    const before = object(await this.native.send({ type: "get_state" }));
    if (!mayWrite() || before.sessionId !== sessionId || typeof before.sessionName === "string" && before.sessionName.trim()) return;
    const prompt = buildSessionTitlePrompt(this.titleInput!, this.titleReply);
    const title = parseGeneratedSessionTitle(await this.native.generateSessionTitle(prompt, controller.signal));
    if (!mayWrite()) return;
    const after = object(await this.native.send({ type: "get_state" }));
    if (!mayWrite() || after.sessionId !== sessionId || typeof after.sessionName === "string" && after.sessionName.trim()) return;
    await this.native.send({ type: "set_session_name", name: title });
    if (!this.isAlive() || this.sessionId !== sessionId) return;
    this.titleEvent = { type: "session_info_update", sessionId, title };
    this.emit(this.titleEvent);
    this.changed();
  }
  private schedule(delay = 30) {
    if (this.closed || !this.pending.length || this.pumping) return;
    if (this.timer) {
      if (delay !== 30) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, delay);
    this.timer.unref();
  }
  private async pump() {
    if (this.pumping || this.closed || !this.pending.length) return;
    this.pumping = true;
    try {
      const state = await this.state();
      if (this.closed || this.manualRequests || this.native.isRunning() || this.paused || Number(state.pendingMessageCount ?? 0) > 0 || state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting || state.isSettled === false) return;
      const item = this.pending[0];
      if (!item || item.state !== "queued") return;
      // No await between claim and native send. A concurrent recall sees sending
      // and cannot report a cancellation that did not happen.
      item.state = "sending"; this.queueChanged();
      try {
        this.captureTitleInput(item.text);
        await this.native.send({ type: "prompt", message: item.text });
        this.pending = this.pending.filter(candidate => candidate !== item);
        this.queueChanged();
      } catch {
        if (!this.closed && this.pending.includes(item)) {
          item.state = "unconfirmed";
          this.paused = true;
          this.queueChanged();
          this.emit({ type: "prompt_error", errorMessage: "Follow-up delivery was not confirmed. Automatic sending is paused; recover the draft and check history before resending." });
        }
      }
    } catch { /* An unavailable state never authorizes sending. Retry state only. */ }
    finally { this.pumping = false; this.schedule(2000); this.maybeNameSession(); }
  }
  async send(command: Record<string, unknown>): Promise<unknown> {
    await this.waitUntilReady();
    if (!this.isAlive()) throw new Error("Session is closed");
    const type = String(command.type);
    if (type === "follow_up" || type === "prompt" && command.streamingBehavior === "followUp") {
      if (typeof command.message !== "string" || !command.message.trim()) throw new Error("Follow-up text is required");
      if (command.message.trimStart().startsWith("/") || command.images !== undefined && (!Array.isArray(command.images) || command.images.length)) throw new Error("Follow-up queue supports plain text only, not commands or attachments");
      if (this.pending.length >= 32 || Buffer.byteLength(command.message) > 64 * 1024) throw new Error("Follow-up queue limit reached (32 messages / 64 KiB per message)");
      const item: Pending = { id: PREFIX + randomUUID(), kind: "follow_up", text: command.message, state: "queued", source: "web" };
      if (!this.pending.length) this.paused = false;
      this.pending.push(item); this.queueChanged(); this.schedule();
      return { queued: true, id: item.id };
    }
    if (type === "recall_queued_message" && typeof command.id === "string" && command.id.startsWith(PREFIX)) {
      const item = this.pending.find(candidate => candidate.id === command.id);
      if (!item || item.state === "sending") return { removed: false };
      if (item.state === "unconfirmed") {
        if (command.recover !== true) return { removed: false, uncertain: true };
        this.pending = this.pending.filter(candidate => candidate !== item); this.queueChanged();
        // This is recovery of a COPY, not withdrawal. Keep later sends paused
        // until the user explicitly submits a normal prompt.
        return { removed: false, uncertain: true, text: item.text };
      }
      this.pending = this.pending.filter(candidate => candidate !== item); this.queueChanged();
      return { removed: true, text: item.text, kind: item.kind };
    }
    if (type === "get_state") {
      const state = await this.state(), queue = this.mergedQueue();
      const isNamingSession = Boolean(this.titleController);
      return { ...state, supportsFollowUp: true, webFollowUpPending: this.pending.length, isNamingSession,
        queuedMessages: { steering: queue.steering, followUp: queue.followUp, queueEpoch: queue.queueEpoch, queueRevision: queue.queueRevision, followUpPaused: queue.followUpPaused }, queuedItems: queue.items,
        pendingMessageCount: Number(state.pendingMessageCount ?? 0) + this.pending.length,
        isSettled: state.isSettled !== false && !state.isStreaming && !state.isPromptRunning && !state.isBashRunning && !state.isCompacting && !this.pending.length && !isNamingSession };
    }
    if (type === "clear_queue") {
      this.manualRequests++;
      const candidates = this.pending.filter(item => item.state === "queued");
      try {
        const nativeRemoved = this.nativeQueue.steering.length || this.nativeQueue.followUp.length
          ? object(await this.native.send(command)) : {};
        const removed = candidates.filter(item => this.pending.includes(item) && item.state === "queued");
        this.pending = this.pending.filter(item => !removed.includes(item));
        try { await this.state(); } catch { /* Native acknowledgement, not refresh, owns removal. */ }
        this.queueChanged();
        return { steering: strings(nativeRemoved.steering), followUp: [...strings(nativeRemoved.followUp), ...removed.map(item => item.text)] };
      } finally { this.manualRequests--; this.schedule(); }
    }
    if (this.pending.length && (["fork", "navigate_tree"].includes(type) || type === "prompt" && typeof command.message === "string" && command.message.trimStart().startsWith("/"))) throw new Error("Withdraw pending follow-ups before changing the session or running commands");
    if (type === "abort") {
      // Stop means no automatic follow-up may start after the interruption.
      this.pending = this.pending.filter(item => item.state === "sending"); this.paused = true; this.queueChanged();
    }
    if (type === "prompt" && this.pending.some(item => item.state === "sending")) throw new Error("A follow-up is being handed to the agent; retry shortly");
    const mutation = ["prompt", "steer", "abort", "bash", "compact", "set_model", "fork", "navigate_tree"].includes(type);
    if (mutation) this.manualRequests++;
    if (["set_session_name", "fork", "navigate_tree", "abort"].includes(type)
      || type === "prompt" && typeof command.message === "string" && /^\s*\/name(?:\s|$)/.test(command.message)) this.suppressTitle();
    if (type === "prompt") this.captureTitleInput(command.message);
    try {
      const result = await this.native.send(command);
      if (type === "prompt" && this.paused) { this.paused = false; this.queueChanged(); }
      if (type === "get_session_stats") rememberContextUsage(this.sessionId, object(result).contextUsage);
      return result;
    } finally { if (mutation) this.manualRequests--; this.schedule(); this.maybeNameSession(); }
  }
  destroy() { this.closed = true; this.suppressTitle(); clearTimeout(this.timer); this.native.destroy(); }
  async shutdown() { this.closed = true; this.suppressTitle(); clearTimeout(this.timer); await this.native.shutdown(); await this.titleWork; }
}
