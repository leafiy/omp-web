import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { AgentFrame, AgentProcessOptions } from "./agent-rpc-client";
import { sessionKey } from "./engine";
import { getCodexHome, getCodexWebDir } from "./codex-config";
import { CodexRpcClient, denyCodexRequest, listCodexModels, object, type CodexFrame, type CodexObject, type CodexTransport } from "./codex-rpc-client";
import { CodexEventProjector } from "./codex-events";
import { generateCodexSessionTitle } from "./codex-session-title";
import { AgentTasks } from "./agent-tasks";
import { codexTaskTranscript } from "./agent-task-messages";
import { WebSessionTranscript } from "./web-session-transcript";
import { validateAgentImages, type Base64ImageAttachment } from "./image-attachments";
import { codexContextUsage } from "./context-usage";
import type { ContextUsage } from "./pi-types";
import type { AgentMessage, ExtensionUiRequest, UserMessage } from "./types";

type Dialog = Extract<ExtensionUiRequest, { method: "select" | "input" }>;
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** WebAgentSession adapter for a single native Codex thread. No terminal takeover. */
export class CodexSession {
  readonly engine = "codex" as const;
  readonly cwd: string;
  private nativeId: string;
  private client: CodexTransport;
  private transcript?: WebSessionTranscript;
  private projector = new CodexEventProjector("");
  private model = "";
  private modelProvider = "";
  private permissionProfile?: string;
  private readonly titleRequests = new Set<AbortController>();
  private readonly tasks = new AgentTasks("codex", event => { this.emit(event); this.changed(); });
  private taskPoll?: ReturnType<typeof setInterval>;
  private taskPolling = false;
  private ready = false;
  private closed = false;
  private busy = false;
  private changingModel = false;
  private turnId?: string;
  private startingTurn = false;
  private stopRequested = false;
  private buffered: CodexFrame[] = [];
  private listeners = new Set<(event: AgentFrame) => void>();
  private dialogs = new Map<string, { event: Dialog; finish: (answer: CodexObject) => void }>();
  private requests = new Map<string, { controller: AbortController; resolved: boolean }>();
  private answered = new Set<string>();
  private resolvedRequests = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private destroyed?: () => void;
  private lastError?: string;
  /** Latest native `thread/tokenUsage/updated` for this thread; unknown until Codex reports it. */
  private contextUsage: ContextUsage | null = null;

  constructor(private readonly options: AgentProcessOptions & { nativeId?: string }, private readonly changed: () => void, client?: CodexTransport, private readonly createTitleClient?: () => CodexTransport) {
    this.cwd = options.cwd; this.nativeId = options.nativeId || "";
    this.client = client ?? new CodexRpcClient(this.cwd);
    this.client.onFrame((frame) => { try { this.receive(frame); } catch (error) { this.fail(error); } });
    this.client.onClose((error) => { if (!this.closed) this.fail(error); });
  }
  get sessionId(): string { return sessionKey("codex", this.nativeId); }
  get sessionFile(): string { return this.transcript?.path || ""; }
  getActiveLeafId(): undefined { return undefined; }
  isAlive(): boolean { return this.ready && !this.closed; }
  isRunning(): boolean { return this.isAlive() && (this.busy || this.tasks.active); }
  onDestroy(callback: () => void): void { this.destroyed = callback; }
  async waitUntilReady(): Promise<void> { if (!this.isAlive()) throw new Error(this.lastError || "Codex CLI is not ready"); }
  onEvent(listener: (event: AgentFrame) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "task_snapshot", snapshot: this.tasks.snapshot() });
    for (const { event } of this.dialogs.values()) listener(event);
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: AgentFrame): void { for (const listener of this.listeners) { try { listener(event); } catch { /* Disconnected browser. */ } } }
  private forward(events: AgentFrame[]): void {
    for (const event of events) {
      if (event.type === "message_end") this.transcript!.append(event.message as AgentMessage);
      this.emit(event);
    }
  }

  async start(): Promise<void> {
    try {
      if (this.options.thinkingLevel) throw new Error("Codex thinking overrides are not enabled in this version");
      if (this.options.initialModel && this.options.initialModel.provider !== "codex-cli") throw new Error("Codex requires a Codex CLI model");
      if (this.options.sessionFile) this.transcript = new WebSessionTranscript(this.nativeId, this.cwd, getCodexWebDir(), "codex-cli", this.options.sessionFile);
      await this.client.start();
      const model = this.options.initialModel?.modelId;
      const result = await this.client.request(this.options.sessionFile ? "thread/resume" : "thread/start", {
        ...(this.options.sessionFile ? { threadId: this.nativeId, excludeTurns: true } : { ephemeral: false }),
        cwd: this.cwd, ...(model ? { model } : {}),
      });
      const thread = object(result.thread);
      if (!uuid(thread.id) || (this.nativeId && thread.id !== this.nativeId)) throw new Error("Codex returned a different or invalid thread ID");
      if (typeof result.cwd !== "string" || canonical(result.cwd) !== canonical(this.cwd)) throw new Error("Codex resumed a different working directory");
      if (object(thread.status).type === "active") throw new Error("Codex thread is already active; terminal takeover is not supported");
      if (typeof result.model !== "string" || !result.model) throw new Error("Codex did not return a model");
      if (this.closed) throw new Error(this.lastError || "Codex exited during initialization");
      this.nativeId = thread.id; this.model = result.model;
      this.modelProvider = typeof result.modelProvider === "string" ? result.modelProvider : "";
      const profile = object(result.activePermissionProfile).id;
      this.permissionProfile = typeof profile === "string" ? profile : undefined;
      if (!this.options.sessionFile) await this.materializeEmptyThread(thread);
      if (this.closed) throw new Error(this.lastError || "Codex exited while persisting the thread");
      this.transcript ??= new WebSessionTranscript(this.nativeId, this.cwd, getCodexWebDir(), "codex-cli");
      this.transcript.setModel(this.model);
      this.ready = true; this.resetIdle();
      this.taskPoll = setInterval(() => void this.refreshTasks(), 5000);
      this.taskPoll.unref();
    } catch (error) { this.destroy(); throw error; }
  }

  /** Isolated native inference, without main-thread projection or name persistence. */
  async generateSessionTitle(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!this.isAlive() || this.changingModel || !this.model || !this.modelProvider) throw new Error("Codex title generation requires a ready native model and provider");
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    this.titleRequests.add(controller);
    try {
      controller.signal.throwIfAborted();
      const client = this.createTitleClient?.() ?? (this.client instanceof CodexRpcClient ? this.client.createTitleClient() : undefined);
      if (!client || client === this.client) throw new Error("Codex title generation requires a separate native transport");
      return await generateCodexSessionTitle(client, {
        cwd: this.cwd, model: this.model, modelProvider: this.modelProvider, permissionProfile: this.permissionProfile,
      }, prompt, controller.signal);
    } finally {
      signal.removeEventListener("abort", cancel);
      this.titleRequests.delete(controller);
    }
  }

  private async materializeEmptyThread(thread: CodexObject): Promise<void> {
    // Codex defers a new thread's rollout until the first turn. Its native read
    // with history explicitly persists paginated threads, without a model call.
    try {
      const result = await this.client.request("thread/read", { threadId: this.nativeId, includeTurns: true });
      if (object(result.thread).id !== this.nativeId) throw new Error("Codex persisted a different thread");
    } catch (error) {
      // 0.155.1 may persist successfully, then fail to list an empty paginated
      // history. Accept only this exact diagnostic AND a durable, nonempty file
      // belonging to our newly-created UUID, inside this Codex home's sessions.
      // Never inspect auth files, write native records, or substitute a new ID.
      if (!(error instanceof Error) || error.message !== "list_turns is not supported yet" || typeof thread.path !== "string") throw error;
      const path = realpathSync(thread.path), root = realpathSync(join(getCodexHome(), "sessions"));
      if (!path.startsWith(root + sep) || !basename(path).endsWith(`${this.nativeId}.jsonl`)) throw error;
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0) throw error;
    }
  }

  private async refreshTasks(): Promise<void> {
    if (this.closed || this.taskPolling || !this.tasks.active) return;
    this.taskPolling = true;
    try {
      for (const id of this.tasks.ids()) {
        const revision = this.tasks.version;
        try {
          const reply = await this.client.request("thread/read", { threadId: id, includeTurns: false });
          if (this.closed) return;
          const thread = object(reply.thread);
          if (thread.id === id && revision === this.tasks.version) this.tasks.codexStatus(id, thread.status);
        } catch {
          // Retain monitoring, but never present an unverified stale status as current.
          if (!this.closed && revision === this.tasks.version) this.tasks.codexUnavailable(id);
        }
      }
    } finally { this.taskPolling = false; }
  }

  private receive(frame: CodexFrame): void {
    const params = object(frame.params);
    // Read-only child activity has a separate route. Never feed child messages or approvals to the parent projector.
    if (!this.closed && this.ready && typeof params.threadId === "string" && this.tasks.has(params.threadId)
      && frame.id === undefined && frame.method === "thread/status/changed") {
      this.tasks.codexStatus(params.threadId, params.status);
      return;
    }
    // Thread-scoped metadata, not a turn event: it may follow turn/completed.
    if (frame.id === undefined && frame.method === "thread/tokenUsage/updated" && params.threadId === this.nativeId) {
      const usage = codexContextUsage(params.tokenUsage);
      if (!this.closed && usage) {
        this.contextUsage = usage;
        this.emit({ type: "context_usage", sessionId: this.sessionId, contextUsage: usage });
      }
      return;
    }
    if (frame.method === "serverRequest/resolved" && params.threadId === this.nativeId) {
      const key = JSON.stringify(params.requestId);
      this.resolvedRequests.add(key);
      if (this.resolvedRequests.size > 4096) throw new Error("Too many resolved Codex requests in one turn");
      const request = this.requests.get(key);
      if (request) { request.resolved = true; request.controller.abort(); }
      return;
    }
    if (this.closed || !this.ready || params.threadId !== this.nativeId || !this.busy) {
      if (frame.id !== undefined) denyCodexRequest(this.client, frame);
      return;
    }
    // app-server may notify, or request approval, before turn/start responds.
    if (this.startingTurn) {
      if (this.buffered.length >= 1024) throw new Error("Too many Codex events before turn identity was acknowledged");
      this.buffered.push(frame); return;
    }
    const eventTurn = ["turn/started", "turn/completed"].includes(frame.method || "") ? object(params.turn).id : params.turnId;
    if (eventTurn !== this.turnId) {
      if (frame.id !== undefined) denyCodexRequest(this.client, frame);
      return; // Child threads and late turns cannot settle or contaminate this turn.
    }
    if (frame.id !== undefined) {
      if (this.stopRequested) denyCodexRequest(this.client, frame);
      else void this.handleRequest(frame).catch((error) => this.fail(error));
      return;
    }
    if (frame.method === "item/started" || frame.method === "item/completed") this.tasks.codexItem(params.item, this.nativeId);
    this.forward(this.projector.consume(frame.method || "", params));
    if (frame.method === "turn/completed") {
      const turn = object(params.turn);
      if (Array.isArray(turn.items)) for (const item of turn.items) {
        this.tasks.codexItem(item, this.nativeId);
        this.forward(this.projector.consume("item/completed", { item }));
      }
      if (turn.status === "failed") this.emit({ type: "prompt_error", errorMessage: String(object(turn.error).message || "Codex turn failed") });
      this.finishTurn();
    }
  }

  private async ask(event: Dialog, signal: AbortSignal): Promise<CodexObject> {
    if (this.closed || !this.busy || signal.aborted) return { cancelled: true };
    return new Promise((resolveAnswer) => {
      let done = false;
      const finish = (answer: CodexObject) => {
        if (done) return; done = true;
        clearTimeout(timer); signal.removeEventListener("abort", cancel);
        this.dialogs.delete(event.id);
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "cancel", targetId: event.id });
        resolveAnswer(answer);
      };
      const cancel = () => finish({ cancelled: true });
      const timer = setTimeout(cancel, 5 * 60_000); timer.unref();
      event = { ...event, timeout: 5 * 60_000, expiresAt: Date.now() + 5 * 60_000 };
      this.dialogs.set(event.id, { event, finish }); signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel(); else this.emit(event);
    });
  }

  private async handleRequest(frame: CodexFrame): Promise<void> {
    const key = JSON.stringify(frame.id);
    if (this.requests.has(key) || this.answered.has(key) || this.resolvedRequests.has(key)) return;
    if (this.requests.size >= 32) { denyCodexRequest(this.client, frame); return; }
    const pending = { controller: new AbortController(), resolved: false };
    this.requests.set(key, pending);
    const { signal } = pending.controller, params = object(frame.params);
    let reply: CodexObject | undefined;
    try {
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(frame.method || "")) {
        const item = typeof params.itemId === "string" ? this.projector.getItem(params.itemId) : undefined;
        const file = frame.method === "item/fileChange/requestApproval";
        // No blind write approvals or session-wide writable-root grants.
        if ((file && (params.grantRoot || !Array.isArray(item?.changes) || !item.changes.length))
          || (!file && (typeof params.command !== "string" || !params.command.trim()))) reply = { decision: "cancel" };
        else {
          const details = JSON.stringify({ ...params, ...(file ? { changes: item!.changes } : {}) }, null, 2);
          if (details.length > 24_000) reply = { decision: "cancel" };
          else {
            const answer = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "select", title: `Codex CLI · ${file ? "修改文件 / File change" : "执行操作 / Execute"}\n${details}`, options: ["拒绝 / Deny", "仅允许这一次 / Allow once"] }, signal);
            reply = { decision: !answer.cancelled && !signal.aborted && answer.value === "仅允许这一次 / Allow once" ? "accept" : "cancel" };
          }
        }
      } else if (frame.method === "item/tool/requestUserInput") {
        const answers: Record<string, { answers: string[] }> = {};
        let cancelled = false;
        if (!Array.isArray(params.questions) || !params.questions.length) cancelled = true;
        else for (const value of params.questions) {
          const q = object(value);
          if (typeof q.id !== "string" || typeof q.question !== "string" || q.isSecret || signal.aborted) { cancelled = true; break; }
          const choices = Array.isArray(q.options) ? q.options.map(object).map((o) => `${o.label || ""}: ${o.description || ""}`).join("\n") : "";
          const title = `${q.question}\n${choices}`;
          if (title.length > 24_000) { cancelled = true; break; }
          const answer = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "input", title, placeholder: "请输入回答 / Your answer" }, signal);
          if (answer.cancelled || signal.aborted || typeof answer.value !== "string" || !answer.value.trim()) { cancelled = true; break; }
          answers[q.id] = { answers: [answer.value] };
        }
        reply = { answers: cancelled ? {} : answers };
      }
      if (!pending.resolved) {
        if (reply) this.client.respond(frame.id!, reply);
        else denyCodexRequest(this.client, frame);
      }
    } finally { this.requests.delete(key); this.answered.add(key); }
  }

  private cancelDialogs(): void {
    for (const pending of this.requests.values()) pending.controller.abort();
    for (const dialog of [...this.dialogs.values()]) dialog.finish({ cancelled: true });
  }
  private finishTurn(): void {
    if (!this.busy) return;
    this.cancelDialogs();
    try { this.forward(this.projector.finish()); }
    catch (error) { this.emit({ type: "prompt_error", errorMessage: `Unable to save Codex history: ${String(error)}` }); }
    this.busy = false; this.startingTurn = false; this.turnId = undefined; this.stopRequested = false;
    for (const frame of this.buffered) if (frame.id !== undefined) denyCodexRequest(this.client, frame);
    this.buffered = [];
    this.emit({ type: "agent_end" }); this.emit({ type: "prompt_done" }); this.emit({ type: "agent_settled" });
    this.changed(); this.resetIdle();
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.emit({ type: "prompt_error", errorMessage: this.lastError }); this.destroy();
  }

  async send(command: CodexObject): Promise<unknown> {
    await this.waitUntilReady(); this.resetIdle();
    switch (command.type) {
      case "get_state": return { sessionId: this.sessionId, sessionFile: this.sessionFile, sessionName: this.transcript!.name, engine: this.engine,
        model: { id: this.model, provider: "codex-cli" }, isPromptRunning: this.busy, isStreaming: this.busy, isSettled: !this.busy && !this.tasks.active, tasks: this.tasks.snapshot(),
        isBashRunning: false, isCompacting: false, pendingMessageCount: 0, queuedMessages: { steering: [], followUp: [] },
        extensionStatuses: [], extensionWidgets: [], systemPrompt: "", contextUsage: this.contextUsage };
      case "get_task_detail": {
        const id = String(command.taskId ?? "");
        this.tasks.detail(id); // Never read an arbitrary or unrelated thread.
        const result = await this.client.request("thread/read", { threadId: id, includeTurns: true });
        const thread = object(result.thread);
        if (thread.id !== id) throw new Error("Codex returned a different child thread");
        return this.tasks.detail(id, codexTaskTranscript(thread));
      }
      case "get_commands": return { commands: [] };
      case "get_tools": return []; // Do not invent a native tool inventory.
      case "get_available_thinking_levels": return { levels: [] };
      case "get_messages": return { messages: this.transcript!.getMessages() };
      case "get_last_assistant_text": {
        const last = this.transcript!.getMessages().findLast((m) => m.role === "assistant");
        return { text: last?.role === "assistant" ? last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "" };
      }
      case "get_session_stats": return { sessionId: this.sessionId, sessionName: this.transcript!.name, contextUsage: this.contextUsage };
      case "extension_ui_response": if (typeof command.id === "string") this.dialogs.get(command.id)?.finish(command); return null;
      case "abort":
        this.stopRequested = this.busy; this.cancelDialogs();
        if (this.turnId) await this.client.request("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId });
        return null; // Only matching turn/completed settles a turn.
      case "set_session_name":
        if (typeof command.name !== "string") throw new Error("name must be a string");
        this.transcript!.rename(command.name.trim()); this.changed(); return null;
      case "set_model": {
        if (this.busy || this.changingModel) throw new Error("Wait for Codex to finish before switching models");
        if (command.provider !== "codex-cli" || typeof command.modelId !== "string") throw new Error("Select a Codex CLI model");
        this.changingModel = true;
        try {
          if (!(await listCodexModels(this.client)).some((m) => m.model === command.modelId)) throw new Error("Model is not in the Codex catalog");
          await this.waitUntilReady();
          if (command.modelId !== this.model) this.contextUsage = null; // The next turn reports the new window.
          this.model = command.modelId; this.transcript!.setModel(this.model);
          return { id: this.model, provider: "codex-cli" }; // Applied to the next native turn.
        } finally { this.changingModel = false; }
      }
      case "prompt": {
        if (this.busy || this.changingModel) throw new Error("Codex is busy; wait or stop before sending another message");
        if (typeof command.message !== "string") throw new Error("message must be a string");
        if (command.message.trimStart().startsWith("/")) throw new Error("Native Codex slash commands are not enabled in this web adapter");
        const imageError = validateAgentImages(command.images); if (imageError) throw new Error(imageError);
        const images = (command.images || []) as Base64ImageAttachment[];
        if (images.some((i) => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(i.mimeType))) throw new Error("Unsupported Codex image type");
        const message: UserMessage = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: command.message }, ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, data: i.data, media_type: i.mimeType } }))] };
        this.transcript!.append(message); this.projector.reset(this.model); this.answered.clear(); this.resolvedRequests.clear();
        this.busy = true; this.startingTurn = true; this.stopRequested = false;
        this.emit({ type: "agent_start" }); this.emit({ type: "message_end", message }); this.changed();
        try {
          const result = await this.client.request("turn/start", { threadId: this.nativeId, model: this.model, clientUserMessageId: randomUUID(),
            input: [{ type: "text", text: command.message, text_elements: [] }, ...images.map((i) => ({ type: "image", url: `data:${i.mimeType};base64,${i.data}` }))] });
          if (this.closed) throw new Error(this.lastError || "Codex exited while starting the turn");
          const turn = object(result.turn);
          if (typeof turn.id !== "string" || !turn.id) {
            this.fail(new Error("Codex did not acknowledge the turn identity"));
            throw new Error(this.lastError);
          }
          this.turnId = turn.id; this.startingTurn = false;
          const buffered = this.buffered; this.buffered = [];
          for (const frame of buffered) this.receive(frame);
          if (this.stopRequested && this.turnId) await this.client.request("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId });
          return null;
        } catch (error) { this.cancelDialogs(); this.finishTurn(); throw error; }
      }
      default: throw new Error(`Codex CLI web adapter does not support ${String(command.type)} yet`);
    }
  }
  private resetIdle(): void {
    clearTimeout(this.idleTimer); if (this.closed) return;
    this.idleTimer = setTimeout(() => { if (this.busy || this.tasks.active || this.changingModel || this.dialogs.size) this.resetIdle(); else this.destroy(); }, 10 * 60_000);
    this.idleTimer.unref();
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.idleTimer); clearInterval(this.taskPoll);
    for (const request of this.titleRequests) request.abort(new Error("Codex session closed"));
    this.tasks.disconnected(); this.cancelDialogs(); this.finishTurn();
    this.client.destroy(); this.destroyed?.(); this.changed();
  }
  async shutdown(): Promise<void> { this.destroy(); }
}
