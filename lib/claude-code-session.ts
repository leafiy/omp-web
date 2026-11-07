import { randomUUID } from "node:crypto";
import type { Options, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentFrame, AgentProcessOptions } from "./agent-rpc-client";
import { sessionKey } from "./engine";
import { claudeChildEnvironment, getClaudeConfig } from "./claude-code-config";
import { ClaudeEventProjector } from "./claude-code-events";
import { ClaudeContextCache } from "./claude-context-cache";
import { claudeSlashCommands, claudeSlashCommandRestriction } from "./claude-code-commands";
import { ClaudeWebTranscript } from "./claude-code-store";
import { validateAgentImages, type Base64ImageAttachment } from "./image-attachments";
import type { AgentMessage, ExtensionUiRequest, UserMessage } from "./types";

type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
type Dialog = Extract<ExtensionUiRequest, { method: "select" | "input" }>;
type PendingDialog = { event: Dialog; finish: (response: Record<string, unknown>) => void };

class PromptInput implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed");
    this.pending.push(value);
    this.wake?.();
  }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.pending.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

/** Independent SDK adapter. No Claude frame is sent to the OMP/Pi RPC decoder. */
export class ClaudeCodeSession {
  readonly engine = "claude" as const;
  readonly sessionId: string;
  readonly cwd: string;
  private readonly input = new PromptInput();
  private readonly nativeId: string;
  private query?: Query;
  private transcript?: ClaudeWebTranscript;
  private projector?: ClaudeEventProjector;
  private model = "";
  private listeners = new Set<(event: AgentFrame) => void>();
  private dialogs = new Map<string, PendingDialog>();
  private permissionReplies = new Map<string, Promise<PermissionResult>>();
  private ready = false;
  private closed = false;
  private busy = false;
  private changingModel = false;
  private activePrompt?: ReturnType<typeof randomUUID>;
  private interruptRequested = false;
  private loop?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private onDestroyCallback?: () => void;
  private tools: string[] = [];
  private terminalCommands: string[] = [];
  private lastError?: string;
  private readonly context = new ClaudeContextCache(() => {
    if (this.closed || this.busy || this.changingModel) throw new Error("Context summary is unavailable during a transition");
    return this.query!.getContextUsage({ detail: "summary" });
  });

  constructor(
    private readonly options: AgentProcessOptions & { nativeId?: string },
    private readonly changed: () => void,
    private readonly createQuery?: QueryFactory,
  ) {
    this.nativeId = options.nativeId ?? randomUUID();
    this.sessionId = sessionKey("claude", this.nativeId);
    this.cwd = options.cwd;
  }

  get sessionFile(): string { return this.transcript?.path ?? ""; }
  getActiveLeafId(): undefined { return undefined; }
  isAlive(): boolean { return this.ready && !this.closed; }
  isRunning(): boolean { return this.isAlive() && this.busy; }
  onDestroy(callback: () => void): void { this.onDestroyCallback = callback; }
  async waitUntilReady(): Promise<void> {
    if (!this.isAlive()) throw new Error(this.lastError || "Claude Code is not ready");
  }
  onEvent(listener: (event: AgentFrame) => void): () => void {
    this.listeners.add(listener);
    for (const { event } of this.dialogs.values()) listener(event);
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: AgentFrame): void {
    for (const listener of this.listeners) { try { listener(event); } catch { /* disconnected browser */ } }
  }

  async start(): Promise<void> {
    try {
      const config = getClaudeConfig();
      if (this.options.thinkingLevel) throw new Error("Claude thinking overrides are not supported by these web controls yet");
      if (this.options.initialModel && this.options.initialModel.provider !== "claude-code") throw new Error("Select a native Claude Code model");
      const env = claudeChildEnvironment();
      this.model = this.options.initialModel?.modelId || "";
      this.projector = new ClaudeEventProjector(this.model);
      if (this.options.sessionFile) this.transcript = new ClaudeWebTranscript(this.nativeId, this.cwd, this.options.sessionFile);
      const resume = Boolean(this.options.sessionFile && this.transcript?.getMessages().some((m) => m.role === "user"));
      const factory = this.createQuery ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
      this.query = factory({
        prompt: this.input,
        options: {
          cwd: this.cwd, env, pathToClaudeCodeExecutable: config.executable,
          ...(this.model ? { model: this.model } : {}),
          ...(this.options.catalogOnly ? {} : resume ? { resume: this.nativeId } : { sessionId: this.nativeId }),
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          includePartialMessages: true, persistSession: !this.options.catalogOnly,
          canUseTool: (tool, input, context) => {
            const id = context.requestId || context.toolUseID;
            let reply = this.permissionReplies.get(id);
            if (!reply) {
              reply = this.permission(tool, input, context.signal);
              this.permissionReplies.set(id, reply);
            }
            return reply;
          },
          // Do not advertise user-dialog kinds we cannot render. SDK fails closed.
        },
      });
      this.loop = this.consume();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.query.initializationResult(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude Code initialization timed out")), 60_000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (this.closed) throw new Error(this.lastError || "Claude Code exited during initialization");
      if (!this.options.catalogOnly) {
        this.transcript ??= new ClaudeWebTranscript(this.nativeId, this.cwd);
        if (this.model) this.transcript.setModel(this.model);
      }
      this.ready = true;
      this.resetIdle();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const frame of this.query!) {
        if (this.closed) break;
        if (!this.options.catalogOnly && frame.session_id && frame.session_id !== this.nativeId) throw new Error("Claude Code returned a different session ID");
        if (frame.type === "system" && frame.subtype === "init") {
          this.context.invalidate();
          this.tools = frame.tools;
          this.terminalCommands = frame.terminal_slash_commands ?? [];
          this.model = frame.model;
          this.projector!.setModel(this.model);
          this.transcript?.setModel(this.model);
        }
        for (const event of this.projector!.consume(frame)) {
          if (event.type === "message_end") this.transcript?.append(event.message as AgentMessage);
          this.emit(event);
        }
        if (frame.type === "result") {
          // A late result for a previous send must not settle the current send.
          if (frame.user_message_uuid && this.activePrompt && frame.user_message_uuid !== this.activePrompt) continue;
          // CC 2.1.318 reports an interrupted, unfinished turn as an execution
          // diagnostic. Suppress only that known cancellation shape, not auth or
          // tool failures that happen to race a user's stop request.
          const errors = "errors" in frame ? frame.errors : [];
          const interruptedDiagnostic = this.interruptRequested && frame.subtype === "error_during_execution"
            && errors.length > 0 && errors.every((error) => error.startsWith("[ede_diagnostic] result_type=user "));
          if (frame.is_error && !interruptedDiagnostic) this.emit({ type: "prompt_error", errorMessage: errors.join("\n") || ("result" in frame && frame.result) || "Claude Code turn failed" });
          this.finishTurn();
        }
      }
      if (!this.closed) throw new Error("Claude Code stream closed; reopen the session to resume");
    } catch (error) {
      if (!this.closed) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.emit({ type: "prompt_error", errorMessage: this.lastError });
      }
    } finally { this.destroy(); }
  }

  private finishTurn(): void {
    if (!this.busy) return;
    this.cancelDialogs();
    this.busy = false;
    this.context.invalidate();
    this.activePrompt = undefined;
    this.interruptRequested = false;
    this.emit({ type: "agent_end" });
    this.emit({ type: "prompt_done" });
    this.emit({ type: "agent_settled" });
    this.changed();
    this.resetIdle();
  }

  private ask(event: Dialog, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.ready || this.closed || signal.aborted) return Promise.resolve({ cancelled: true });
    return new Promise((resolve) => {
      let done = false;
      const finish = (response: Record<string, unknown>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.dialogs.delete(event.id);
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "cancel", targetId: event.id });
        resolve(response);
      };
      const abort = () => finish({ cancelled: true });
      const timer = setTimeout(abort, 5 * 60_000);
      timer.unref();
      event = { ...event, timeout: 5 * 60_000, expiresAt: Date.now() + 5 * 60_000 };
      this.dialogs.set(event.id, { event, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.emit(event);
    });
  }

  private async permission(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const deny: PermissionResult = { behavior: "deny", message: "Not approved in the web UI (denied, cancelled or timed out)." };
    if (this.options.catalogOnly) return deny;
    if (tool === "AskUserQuestion") {
      if (!Array.isArray(input.questions) || !input.questions.length) return deny;
      const answers: Record<string, string> = {};
      for (const raw of input.questions) {
        if (!raw || typeof raw !== "object" || typeof raw.question !== "string") return deny;
        const choices = Array.isArray(raw.options) ? raw.options.filter((o: unknown) => o && typeof o === "object").map((o: { label?: string; description?: string }) => `${o.label ?? ""}: ${o.description ?? ""}`).join("\n") : "";
        const answer = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "input", title: `${raw.question}\n${choices}`, placeholder: raw.multiSelect ? "Enter one or more answers" : "Enter your answer" }, signal);
        if (answer.cancelled || typeof answer.value !== "string" || !answer.value.trim()) return deny;
        answers[raw.question] = answer.value;
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    const details = JSON.stringify(input, null, 2);
    if (details.length > 24_000) return { behavior: "deny", message: "Tool input is too large to review safely in the web approval dialog" };
    // First choice is denial; no permission persistence and no bypassPermissions.
    const response = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "select", title: `Claude Code: ${tool}\n${details}`, options: ["Deny", "Allow once"] }, signal);
    return response.value === "Allow once" && !response.cancelled && !signal.aborted
      ? { behavior: "allow", updatedInput: input } : deny;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    await this.waitUntilReady();
    this.resetIdle();
    switch (command.type) {
      case "get_state": {
        const contextUsage = await this.context.get(this.busy || this.changingModel);
        return {
          sessionId: this.sessionId, sessionFile: this.sessionFile, sessionName: this.transcript?.name,
          engine: this.engine, model: this.model ? { id: this.model, provider: "claude-code" } : undefined,
          isPromptRunning: this.busy, isStreaming: this.busy, isSettled: !this.busy,
          isBashRunning: false, isCompacting: false, pendingMessageCount: 0,
          queuedMessages: { steering: [], followUp: [] }, extensionStatuses: [], extensionWidgets: [],
          systemPrompt: "", contextUsage,
        };
      }
      case "get_available_models": return { models: await this.query!.supportedModels() };
      case "get_native_usage": return this.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      case "get_commands": return { commands: claudeSlashCommands(await this.query!.supportedCommands(), this.terminalCommands) };
      case "get_skill_commands": return { commands: await this.query!.supportedCommands() };
      case "get_tools": return this.tools.map((name) => ({ name, description: "Claude Code native tool", active: true }));
      case "get_available_thinking_levels": return { levels: [] };
      case "get_messages": return { messages: this.transcript!.getMessages() };
      case "get_last_assistant_text": {
        const last = this.transcript!.getMessages().findLast((m) => m.role === "assistant");
        return { text: last?.role === "assistant" ? last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "" };
      }
      case "get_session_stats": return { sessionId: this.sessionId, sessionName: this.transcript?.name, contextUsage: await this.context.get(this.busy || this.changingModel) };
      case "extension_ui_response": {
        if (typeof command.id === "string") this.dialogs.get(command.id)?.finish(command);
        return null;
      }
      case "abort":
        this.interruptRequested = this.busy;
        this.cancelDialogs();
        if (this.busy) await this.query!.interrupt();
        // Interrupt acknowledgement is not completion; wait for native result.
        return null;
      case "set_session_name":
        if (typeof command.name !== "string") throw new Error("name must be a string");
        this.transcript!.rename(command.name.trim());
        this.changed();
        return null;
      case "set_model": {
        if (this.busy || this.changingModel) throw new Error("Wait for Claude Code to finish before switching models");
        if (command.provider !== "claude-code" || typeof command.modelId !== "string") throw new Error("Select a native Claude Code model");
        this.changingModel = true;
        this.context.invalidate();
        try {
          const models = await this.query!.supportedModels();
          if (!models.some((model) => model.value === command.modelId || model.resolvedModel === command.modelId)) throw new Error("Model is not in the native Claude Code catalog");
          await this.query!.setModel(command.modelId);
          this.model = command.modelId;
          this.projector!.setModel(this.model);
          this.transcript?.setModel(this.model);
          return { id: this.model, provider: "claude-code" };
        } finally { this.changingModel = false; this.context.invalidate(); }
      }
      case "prompt": {
        if (this.options.catalogOnly) throw new Error("Catalog clients cannot submit model prompts");
        if (this.busy || this.changingModel) throw new Error("Claude Code is busy; wait or stop before sending another message");
        if (typeof command.message !== "string") throw new Error("message must be a string");
        if (command.message.trimStart().startsWith("/")) {
          const name = command.message.trimStart().match(/^\/([^\s]+)/)?.[1] ?? "";
          const restriction = claudeSlashCommandRestriction(name);
          if (restriction) throw new Error(`Claude slash commands: ${restriction}`);
          const commands = claudeSlashCommands(await this.query!.supportedCommands(), this.terminalCommands);
          if (!commands.some((item) => item.name === name)) throw new Error(`/${name} is not available in this Claude session's native command catalog`);
          // Catalog lookup yields: another prompt/model change may have won the race.
          await this.waitUntilReady();
          if (this.busy || this.changingModel) throw new Error("Claude Code is busy; wait or stop before sending another message");
        }
        const imageError = validateAgentImages(command.images);
        if (imageError) throw new Error(imageError);
        const images = (command.images ?? []) as Base64ImageAttachment[];
        const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
        if (images.some((i) => !allowed.has(i.mimeType))) throw new Error("Claude supports PNG, JPEG, GIF and WebP attachments");
        const content: UserMessage["content"] = [
          { type: "text", text: command.message },
          ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, data: i.data, media_type: i.mimeType } })),
        ];
        const message: UserMessage = { role: "user", content, timestamp: Date.now() };
        this.transcript!.append(message);
        this.projector!.resetTurn();
        this.permissionReplies.clear();
        this.busy = true;
        this.context.invalidate();
        this.activePrompt = randomUUID();
        this.interruptRequested = false;
        this.changed();
        this.emit({ type: "agent_start" });
        this.emit({ type: "message_end", message });
        this.input.push({ type: "user", session_id: this.nativeId, parent_tool_use_id: null, uuid: this.activePrompt, message: { role: "user", content: content as SDKUserMessage["message"]["content"] } });
        return null;
      }
      default: throw new Error(`Claude Code web adapter does not support ${String(command.type)} yet`);
    }
  }

  private cancelDialogs(): void {
    for (const dialog of [...this.dialogs.values()]) dialog.finish({ cancelled: true });
  }
  private resetIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.changingModel || this.dialogs.size) this.resetIdle();
      else this.destroy();
    }, 10 * 60_000);
    this.idleTimer.unref();
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.context.invalidate();
    clearTimeout(this.idleTimer);
    this.cancelDialogs();
    this.finishTurn();
    this.input.close();
    this.query?.close();
    this.onDestroyCallback?.();
    this.changed();
  }
  async shutdown(): Promise<void> {
    this.destroy();
    await this.loop;
  }
}
