import { randomUUID } from "node:crypto";
import { query as nativeClaudeQuery, type ElicitationRequest, type ElicitationResult, type Options, type PermissionMode, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSystemEvents } from "./claude-system-events";
import { CLAUDE_WEB_PERMISSION_MODES, allowSuggestions, describePermissionUpdates, isClaudePermissionMode, isClaudeWebPermissionMode, persistentDestination, sessionScoped } from "./claude-permissions";
import { elicitationFields, parseElicitationAnswer, safeElicitationUrl } from "./claude-elicitation";
import { projectMcpStatus } from "./claude-mcp";
import { projectedUserText, resolveNativeTarget, type NativeChainEntry } from "./claude-rewind";
import { forgetContextUsage } from "./context-usage-cache";
import type { AgentFrame, AgentProcessOptions } from "./agent-rpc-client";
import { sessionKey } from "./engine";
import { claudeChildEnvironment, getClaudeConfig } from "./claude-code-config";
import { ClaudeEventProjector } from "./claude-code-events";
import { AgentTasks } from "./agent-tasks";
import { taskTranscript } from "./agent-task-messages";
import { ClaudeContextCache } from "./claude-context-cache";
import { ClaudeInputLedger, type ClaudeInputKind } from "./claude-input-ledger";
import { interruptClaude, supportsClaudeSteering, canRecallClaudeInput, recallClaudeInput } from "./claude-steering";
import { claudeSlashCommands, claudeSlashCommandRestriction } from "./claude-code-commands";
import { ClaudeWebTranscript } from "./claude-code-store";
import { forgetClaudeNativeTitle, readClaudeNativeTitle } from "./claude-native-title";
import { readClaudeModels, readClaudeModelSettings, claudeEffortLevels, isClaudeEffort, type ClaudeModelSettings } from "./claude-models";
import { validateAgentImages, type Base64ImageAttachment } from "./image-attachments";
import { questionDisplay } from "./question-dialog";
import type { AgentMessage, ExtensionUiRequest, UserMessage } from "./types";

type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
type ChildMessagesReader = (parentId: string, taskId: string, cwd: string) => Promise<unknown[]>;
const readNativeChildMessages: ChildMessagesReader = async (parentId, taskId, cwd) => {
  const { getSubagentMessages } = await import("@anthropic-ai/claude-agent-sdk");
  return getSubagentMessages(parentId, taskId, { dir: cwd });
};
/** Read/fork Claude Code's native transcripts in-process (the CLI owns their format). */
export interface ClaudeNativeSessions {
  messages(sessionId: string, cwd: string): Promise<NativeChainEntry[]>;
  fork(sessionId: string, cwd: string, upToMessageId: string): Promise<string>;
}
const nativeSessions: ClaudeNativeSessions = {
  async messages(sessionId, cwd) {
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    return (await getSessionMessages(sessionId, { dir: cwd })).map((entry) => ({ type: entry.type, uuid: entry.uuid, message: entry.message }));
  },
  async fork(sessionId, cwd, upToMessageId) {
    const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
    return (await forkSession(sessionId, { dir: cwd, upToMessageId })).sessionId;
  },
};
type CanUseToolContext = Parameters<NonNullable<Options["canUseTool"]>>[2];
type Dialog = Extract<ExtensionUiRequest, { method: "select" | "input" }>;
const PLAN_ACCEPT_EDITS = "Approve and auto-accept edits";
const PLAN_REVIEW_EDITS = "Approve and review each edit";
const PLAN_KEEP = "Keep planning";
type PendingDialog = { event: Dialog; background: boolean; finish: (response: Record<string, unknown>) => void };

class PromptInput implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed");
    this.pending.push(value);
    this.wake?.();
  }
  remove(id: string): boolean { const index = this.pending.findIndex(item => item.uuid === id); if (index < 0) return false; this.pending.splice(index, 1); return true; }
  clear(): string[] { return this.pending.splice(0).flatMap((item) => item.uuid ? [item.uuid] : []); }
  close(): void { this.clear(); this.closed = true; this.wake?.(); }
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
  private nativeEnvironment?: NodeJS.ProcessEnv;
  private nativeExecutable?: string;
  private readonly titleRequests = new Set<AbortController>();
  private transcript?: ClaudeWebTranscript;
  private projector?: ClaudeEventProjector;
  private model = "";
  private modelSettings?: ClaudeModelSettings;
  private settingsRevision = 0;
  private get effortControlAvailable(): boolean { return Boolean(this.modelSettings && typeof this.query?.applyFlagSettings === "function"); }
  private async refreshModelSettings(): Promise<void> {
    const revision = this.settingsRevision;
    const settings = await readClaudeModelSettings(this.query!);
    if (!settings || revision !== this.settingsRevision || this.closed) return;
    if (this.ready) {
      if (settings.model !== this.model) this.transcript?.setModel(settings.model);
      if (settings.effort !== this.modelSettings?.effort) this.transcript?.setEffort(settings.effort ?? "auto");
    }
    this.modelSettings = settings;
    this.model = settings.model;
    this.projector?.setModel(this.model);
  }
  private readonly tasks = new AgentTasks("claude", event => { this.emit(event); this.changed(); this.resetIdle(); });
  private listeners = new Set<(event: AgentFrame) => void>();
  private dialogs = new Map<string, PendingDialog>();
  private permissionReplies = new Map<string, Promise<PermissionResult>>();
  private ready = false;
  private closed = false;
  private busy = false;
  private changingModel = false;
  private readonly inputs = new ClaudeInputLedger();
  private steeringAvailable = false;
  private recalling?: string;
  private steeredCycle = false;
  private stopping = false;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private resultUuids = new Set<string>();
  private interruptRequested = false;
  private loop?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private onDestroyCallback?: () => void;
  private tools: string[] = [];
  private terminalCommands: string[] = [];
  private lastError?: string;
  private permissionMode: PermissionMode = "default";
  private readonly system = new ClaudeSystemEvents();
  /** Native UUIDs of web sends, so Fork/Rewind target the exact native entry. */
  private readonly nativeUuids = new WeakMap<UserMessage, string>();
  private readonly context = new ClaudeContextCache(() => {
    if (this.closed || this.busy || this.changingModel) throw new Error("Context summary is unavailable during a transition");
    return this.query!.getContextUsage({ detail: "summary" });
  }, {
    // A browser's one-shot read after a turn can time out; push the settled summary.
    onUpdate: (contextUsage) => { if (!this.closed) this.emit({ type: "context_usage", sessionId: this.sessionId, contextUsage }); },
  });
  /** Claude's own /rename or generated title, read from its native transcript. */
  private nativeTitle?: string;
  private nativeTitleRead?: Promise<void>;
  private nativeTitleCheckedAt = 0;
  /** Claude persists its transcript with the first turn; before that there is nothing to read. */
  private nativeHistory = false;
  /** Claude names a session early in its first turn; look for it while the turn runs. */
  private nativeTitleWatch?: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: AgentProcessOptions & { nativeId?: string },
    private readonly changed: () => void,
    private readonly createQuery?: QueryFactory,
    private readonly readChildMessages: ChildMessagesReader = readNativeChildMessages,
    // An injected query has no native transcript: never read the real ~/.claude for it.
    private readonly readNativeTitle: (nativeId: string, cwd: string) => Promise<string | undefined> = createQuery ? async () => undefined : readClaudeNativeTitle,
    private readonly native: ClaudeNativeSessions = nativeSessions,
  ) {
    this.nativeId = options.nativeId ?? randomUUID();
    this.sessionId = sessionKey("claude", this.nativeId);
    this.cwd = options.cwd;
  }

  get sessionFile(): string { return this.transcript?.path ?? ""; }
  getActiveLeafId(): undefined { return undefined; }
  isAlive(): boolean { return this.ready && !this.closed; }
  isRunning(): boolean { return this.isAlive() && (this.busy || this.tasks.active || this.stopping || this.changingModel || this.system.isCompacting || this.inputs.size > 0); }
  hasPendingDialog(): boolean { return this.isAlive() && this.dialogs.size > 0; }
  onDestroy(callback: () => void): void { this.onDestroyCallback = callback; }
  async waitUntilReady(): Promise<void> {
    if (!this.isAlive()) throw new Error(this.lastError || "Claude Code is not ready");
  }
  onEvent(listener: (event: AgentFrame) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "task_snapshot", snapshot: this.tasks.snapshot() });
    if (this.ready && this.steeringAvailable) {
      listener({ type: "agent_capabilities", supportsSteering: true });
      listener({ type: "queue_update", ...this.inputs.queued(), items: this.recallItems() });
    }
    if (this.ready) listener({ type: "permission_mode", mode: this.permissionMode });
    if (this.system.isCompacting) listener({ type: "compaction_start", reason: "auto" });
    for (const { event } of this.dialogs.values()) listener(event);
    const name = this.sessionName();
    if (name) listener({ type: "session_info_update", sessionId: this.sessionId, title: name });
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: AgentFrame): void {
    for (const listener of this.listeners) { try { listener(event); } catch { /* disconnected browser */ } }
  }
  /** A web rename wins; otherwise show the title Claude Code generated or was given natively. */
  private sessionName(): string | undefined {
    return this.transcript?.name?.trim() || this.nativeTitle;
  }
  private refreshNativeTitle(force = false): Promise<void> {
    if (this.options.catalogOnly || this.closed || !this.nativeHistory) return Promise.resolve();
    if (this.nativeTitleRead) return this.nativeTitleRead;
    if (!force && Date.now() - this.nativeTitleCheckedAt < 5000) return Promise.resolve();
    const read = this.readNativeTitle(this.nativeId, this.cwd).then((title) => {
      this.nativeTitleCheckedAt = Date.now();
      if (this.closed || title === this.nativeTitle) return;
      forgetClaudeNativeTitle(this.sessionId);
      const before = this.sessionName();
      this.nativeTitle = title;
      const after = this.sessionName();
      if (after === before) return;
      this.emit({ type: "session_info_update", sessionId: this.sessionId, title: after ?? "" });
      this.changed();
    }).catch(() => { /* Title metadata never fails the chat. */ })
      .finally(() => { if (this.nativeTitleRead === read) this.nativeTitleRead = undefined; });
    this.nativeTitleRead = read;
    return read;
  }
  private watchNativeTitle(): void {
    if (this.nativeTitleWatch || this.options.catalogOnly || this.closed || this.sessionName()) return;
    // A main-thread reply means Claude has already written the user turn natively.
    this.nativeHistory = true;
    this.nativeTitleWatch = setInterval(() => {
      if (this.closed || !this.busy || this.sessionName()) {
        clearInterval(this.nativeTitleWatch);
        this.nativeTitleWatch = undefined;
        return;
      }
      void this.refreshNativeTitle(true);
    }, 4000);
    this.nativeTitleWatch.unref();
  }

  async start(): Promise<void> {
    try {
      const config = getClaudeConfig();
      if (this.options.initialModel && this.options.initialModel.provider !== "claude-code") throw new Error("Select a native Claude Code model");
      const env = claudeChildEnvironment();
      this.model = this.options.initialModel?.modelId || "";
      this.nativeEnvironment = env;
      this.nativeExecutable = config.executable;
      this.projector = new ClaudeEventProjector(this.model);
      if (this.options.sessionFile) this.transcript = new ClaudeWebTranscript(this.nativeId, this.cwd, this.options.sessionFile);
      this.model ||= this.transcript?.model ?? "";
      // An unanswered conversation rewind resumes at its native chain point.
      const resumeAt = this.options.catalogOnly ? undefined : this.transcript?.pendingResumeAt;
      const resume = Boolean(this.options.sessionFile && (resumeAt || this.transcript?.getMessages().some((m) => m.role === "user")));
      const effort = this.options.thinkingLevel ?? this.transcript?.effort;
      if (effort && effort !== "auto" && !isClaudeEffort(effort)) throw new Error("Invalid Claude effort level");
      // Only re-apply a mode the user chose in the web; otherwise Claude's settings decide.
      const savedMode = this.transcript?.permissionMode;
      const permissionMode = !this.options.catalogOnly && isClaudeWebPermissionMode(savedMode) ? savedMode : undefined;
      const factory = this.createQuery ?? nativeClaudeQuery;
      this.query = factory({
        prompt: this.input,
        options: {
          cwd: this.cwd, env, pathToClaudeCodeExecutable: config.executable,
          ...(this.model ? { model: this.model } : {}),
          ...(isClaudeEffort(effort) ? { effort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(this.options.catalogOnly ? {} : resume ? { resume: this.nativeId, ...(resumeAt ? { resumeSessionAt: resumeAt } : {}) } : { sessionId: this.nativeId }),
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          includePartialMessages: true, persistSession: !this.options.catalogOnly,
          // Native checkpoints back Rewind's "restore code"; the CLI owns the backups.
          enableFileCheckpointing: !this.options.catalogOnly,
          includeHookEvents: true,
          canUseTool: (tool, input, context) => {
            const id = context.requestId || context.toolUseID;
            let reply = this.permissionReplies.get(id);
            if (!reply) {
              reply = this.permission(tool, input, context, Boolean(context.agentID));
              this.permissionReplies.set(id, reply);
            }
            return reply;
          },
          onElicitation: (request, { signal }) => this.elicit(request, signal),
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
      if (effort === "auto") await this.query.applyFlagSettings({ effortLevel: null });
      await this.refreshModelSettings();
      if (isClaudeEffort(effort) && !claudeEffortLevels(await readClaudeModels(this.query), this.model).includes(effort)) {
        throw new Error("Requested effort is not supported by the selected native Claude model");
      }
      if (!this.options.catalogOnly) {
        this.transcript ??= new ClaudeWebTranscript(this.nativeId, this.cwd);
        if (this.model) this.transcript.setModel(this.model);
        if (effort) this.transcript.setEffort(effort);
      }
      this.ready = true;
      this.resetIdle();
      this.nativeHistory = resume;
      if (resume) void this.refreshNativeTitle(true);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /** A separate, nonpersistent native query; never enters this conversation. */
  async generateSessionTitle(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!this.isAlive() || this.changingModel || !this.model) throw new Error("Claude Code title generation requires a ready native model");
    const controller = new AbortController(), input = new PromptInput();
    const model = this.model;
    let query: Query | undefined;
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    this.titleRequests.add(controller);
    const { promise: cancelled, reject: rejectCancelled } = Promise.withResolvers<never>();
    const stop = () => {
      rejectCancelled(controller.signal.reason);
      input.close();
      query?.close();
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Claude Code title generation timed out")), 90_000);
    timer.unref();
    try {
      controller.signal.throwIfAborted();
      const run = async () => {
        const factory = this.createQuery ?? nativeClaudeQuery;
        controller.signal.throwIfAborted();
        query = factory({
          prompt: input,
          options: {
            cwd: this.cwd, env: this.nativeEnvironment, pathToClaudeCodeExecutable: this.nativeExecutable,
            model, abortController: controller, persistSession: false, maxTurns: 1, verbatimPrompts: true,
            tools: [], mcpServers: {}, strictMcpConfig: true, skills: [],
            settingSources: ["user", "project", "local"],
            settings: { disableAllHooks: true, disableClaudeAiConnectors: true, disableBundledSkills: true },
            enableFileCheckpointing: false,
            canUseTool: async () => {
              controller.abort(new Error("Claude Code title generation requested an unexpected tool"));
              return { behavior: "deny", message: "Session title generation has no tools" };
            },
          },
        });
        await query.initializationResult();
        controller.signal.throwIfAborted();
        input.push({
          type: "user", session_id: "", parent_tool_use_id: null, uuid: randomUUID(),
          message: { role: "user", content: prompt },
        });
        let initialized = false;
        for await (const frame of query) {
          controller.signal.throwIfAborted();
          if (frame.type === "tool_progress" || frame.type === "tool_use_summary") throw new Error("Claude Code title generation emitted an unexpected tool event");
          if (frame.type === "system" && frame.subtype === "permission_denied") throw new Error("Claude Code title generation attempted an unexpected tool");
          if (frame.type === "assistant" && frame.error) throw new Error(`Claude Code title generation failed: ${frame.error}`);
          if (frame.type === "system" && frame.subtype === "init") {
            if (!Array.isArray(frame.tools) || frame.tools.length) throw new Error("Claude Code did not disable every title-generation tool");
            if (frame.model !== model) throw new Error("Claude Code title generation changed the selected model");
            if (initialized) throw new Error("Claude Code title query initialized more than once");
            initialized = true;
          } else if (frame.type === "assistant" && frame.message.content.some(block => block.type === "tool_use" || block.type === "server_tool_use")) {
            throw new Error("Claude Code title generation emitted an unexpected tool call");
          } else if (frame.type === "result") {
            if (!initialized || frame.subtype !== "success" || frame.is_error) {
              throw new Error("errors" in frame ? frame.errors.join("\n") || "Claude Code title generation failed" : "Claude Code title generation failed");
            }
            if (!frame.result?.trim() || Buffer.byteLength(frame.result) > 8192) throw new Error("Claude Code title generation returned empty or oversized text");
            return frame.result;
          }
        }
        throw new Error("Claude Code title query closed without a result");
      };
      return await Promise.race([run(), cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", stop);
      this.titleRequests.delete(controller);
      input.close();
      query?.close();
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const frame of this.query!) {
        if (this.closed) break;
        if (!this.options.catalogOnly && frame.session_id && frame.session_id !== this.nativeId) throw new Error("Claude Code returned a different session ID");
        const raw = frame as unknown as Record<string, unknown>;
        this.tasks.claude(raw);
        for (const event of this.system.consume(raw)) this.emit(event);
        if (raw.parent_tool_use_id) continue;
        const nativeMode = raw.type === "system" && (raw.subtype === "init" || raw.subtype === "status") ? raw.permissionMode : undefined;
        if (isClaudePermissionMode(nativeMode)) this.updatePermissionMode(nativeMode);
        if (!this.nativeTitle && (raw.type === "assistant" || raw.type === "stream_event")) this.watchNativeTitle();
        // A background task can wake the main agent without a new browser send.
        // Keep that continuation separate from child transcripts and input UUIDs.
        if (this.ready && !this.busy && !this.stopping && (raw.type === "assistant" || raw.type === "stream_event")) {
          this.busy = true;
          this.emit({ type: "agent_start" });
          this.changed();
        }
        if (raw.type === "command_lifecycle" && typeof raw.command_uuid === "string") {
          if (raw.state === "started") this.deliver(this.inputs.started([raw.command_uuid]));
          else if (raw.state === "cancelled") this.inputs.cancel([raw.command_uuid], true);
          this.queueChanged();
          if (!this.inputs.size && !this.stopping) this.finishTurn();
          continue;
        }
        const consumed = [...(Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : []), raw.user_message_uuid].filter((id): id is string => typeof id === "string" && this.inputs.has(id));
        if (consumed.length && frame.type !== "result") { this.deliver(this.inputs.started(consumed)); this.queueChanged(); }
        if (frame.type === "system" && frame.subtype === "init") {
          this.steeringAvailable = supportsClaudeSteering(frame.capabilities ?? []);
          this.emit({ type: "agent_capabilities", supportsSteering: this.steeringAvailable });
          this.context.invalidate();
          this.tools = frame.tools;
          this.terminalCommands = frame.terminal_slash_commands ?? [];
          this.settingsRevision++;
          this.model = frame.model;
          if (frame.effort === null || isClaudeEffort(frame.effort)) this.modelSettings = { model: frame.model, effort: frame.effort };
          this.projector!.setModel(this.model);
          this.transcript?.setModel(this.model);
        }
        for (const event of this.projector!.consume(frame)) {
          if (event.type === "message_end") this.transcript?.append(event.message as AgentMessage);
          this.emit(event);
        }
        if (frame.type === "result") {
          // One native result can consume several sends; another queued send can
          // start a later turn even when queued_turn_count is zero (CLI 2.1.318).
          if (frame.uuid && this.resultUuids.has(frame.uuid)) continue;
          if (frame.uuid) { this.resultUuids.add(frame.uuid); if (this.resultUuids.size > 256) this.resultUuids.delete(this.resultUuids.values().next().value!); }
          const ids = this.inputs.resultIds(frame);
          if (!ids.length) {
            if (!this.inputs.size && !this.stopping) {
              if (frame.is_error) this.emit({ type: "prompt_error", errorMessage: "errors" in frame ? frame.errors.join("\n") : "Claude Code continuation failed" });
              this.finishTurn();
            }
            if (!frame.user_message_uuid && !frame.user_message_uuids?.length && this.inputs.size) {
              this.emit({ type: "prompt_error", errorMessage: "Claude did not identify the completed input; the native process was closed to avoid losing queued messages." });
              this.destroy();
            }
            continue;
          }
          // CC 2.1.318 reports an interrupted, unfinished turn as an execution
          // diagnostic. Suppress only that known cancellation shape, not auth or
          // tool failures that happen to race a user's stop request.
          const errors = "errors" in frame ? frame.errors : [];
          const interruptedDiagnostic = this.interruptRequested && frame.subtype === "error_during_execution"
            && errors.length > 0 && errors.every((error) => error.startsWith("[ede_diagnostic] result_type=user "));
          if (frame.is_error && !interruptedDiagnostic) this.emit({ type: "prompt_error", errorMessage: errors.join("\n") || ("result" in frame && frame.result) || "Claude Code turn failed" });
          this.deliver(this.inputs.complete(ids));
          this.context.invalidate();
          this.queueChanged();
          if (!this.inputs.size && !this.stopping) this.finishTurn();
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

  private deliver(messages: UserMessage[]): void {
    for (const message of messages) {
      this.transcript?.append(message, this.nativeUuids.get(message));
      this.emit({ type: "message_end", message });
    }
  }

  private updatePermissionMode(mode: PermissionMode): void {
    if (mode === this.permissionMode) return;
    this.permissionMode = mode;
    this.emit({ type: "permission_mode", mode });
    this.changed();
  }

  /** Neither Fork nor Rewind may race a turn, a queued send or a model change. */
  private requireIdle(action: string): void {
    if (this.isRunning() || this.changingModel || this.stopping || this.inputs.size || this.dialogs.size) {
      throw new Error(`Wait for Claude Code to finish before ${action}`);
    }
  }

  private async nativeTarget(entryId: unknown) {
    if (typeof entryId !== "string" || !entryId) throw new Error("entryId is required");
    if (!this.transcript) throw new Error("This Claude Code session has no history yet");
    const projected = this.transcript.getProjectedMessages();
    const chain = await this.native.messages(this.nativeId, this.cwd);
    return { projected, chain, ...resolveNativeTarget(projected, entryId, chain) };
  }

  /** Message Fork: a new native session holding everything before the chosen user message. */
  private async fork(entryId: unknown): Promise<unknown> {
    this.requireIdle("forking");
    const { projected, chain, index, position } = await this.nativeTarget(entryId);
    if (index === 0 || position === 0) throw new Error("There is nothing before the first message to fork; start a new chat instead");
    const forkId = await this.native.fork(this.nativeId, this.cwd, chain[index - 1].uuid);
    // forkSession remaps every native UUID; map ours by chain position when the copy lines up.
    const copied = await this.native.messages(forkId, this.cwd).catch(() => [] as NativeChainEntry[]);
    const remap = new Map<string, string>();
    if (copied.length === index) chain.slice(0, index).forEach((entry, i) => remap.set(entry.uuid, copied[i].uuid));
    const fork = new ClaudeWebTranscript(forkId, this.cwd, undefined, { parentSession: this.transcript!.path });
    for (const item of projected.slice(0, position)) fork.append(item.message, item.nativeUuid ? remap.get(item.nativeUuid) : undefined);
    if (this.model) fork.setModel(this.model);
    if (this.transcript!.effort) fork.setEffort(this.transcript!.effort);
    if (this.transcript!.permissionMode) fork.setPermissionMode(this.transcript!.permissionMode);
    this.changed();
    const newSessionId = sessionKey("claude", forkId);
    return { cancelled: false, newSessionId, sessionId: newSessionId };
  }

  private async rewindPreview(entryId: unknown): Promise<unknown> {
    this.requireIdle("rewinding");
    const { projected, index, uuid, position } = await this.nativeTarget(entryId);
    let files: Record<string, unknown>;
    try {
      const result = await this.query!.rewindFiles(uuid, { dryRun: true });
      files = { canRewind: result.canRewind, ...(result.error ? { error: result.error } : {}), filesChanged: (result.filesChanged ?? []).slice(0, 200), insertions: result.insertions ?? 0, deletions: result.deletions ?? 0 };
    } catch (error) {
      files = { canRewind: false, error: error instanceof Error ? error.message : String(error), filesChanged: [], insertions: 0, deletions: 0 };
    }
    const conversation = index > 0 && position > 0;
    return {
      conversation: { canRewind: conversation, ...(conversation ? {} : { error: "This is the first message; start a new chat to discard the whole conversation" }), messagesRemoved: projected.length - position },
      files,
    };
  }

  /**
   * Rewind like Claude Code's /rewind: restore files from native checkpoints
   * and/or branch the conversation before the chosen user message. The live
   * CLI still holds later turns in memory, so a conversation rewind closes it;
   * the next request resumes the native session at the rewind point.
   */
  private async rewind(entryId: unknown, mode: unknown): Promise<unknown> {
    if (mode !== "both" && mode !== "conversation" && mode !== "files") throw new Error("mode must be both, conversation or files");
    this.requireIdle("rewinding");
    const { projected, chain, index, uuid, position } = await this.nativeTarget(entryId);
    const conversation = mode !== "files", files = mode !== "conversation";
    if (conversation && (index === 0 || position === 0)) throw new Error("Cannot rewind the conversation before its first message; start a new chat instead");
    let filesResult: Record<string, unknown> | undefined;
    if (files) {
      const result = await this.query!.rewindFiles(uuid);
      if (!result.canRewind) throw new Error(result.error || "Claude Code cannot restore files to this point");
      filesResult = { filesChanged: (result.filesChanged ?? []).slice(0, 200), insertions: result.insertions ?? 0, deletions: result.deletions ?? 0, ...(result.skippedLinks ? { skippedLinks: result.skippedLinks } : {}) };
    }
    const target = projected[position].message;
    const text = target.role === "user" ? projectedUserText(target) : "";
    if (conversation) {
      this.transcript!.rewindBefore(entryId as string, { resumeSessionAt: chain[index - 1].uuid, nativeUuid: uuid });
      forgetContextUsage(this.sessionId);
      this.changed();
      this.destroy();
    }
    return { conversation, ...(filesResult ? { files: filesResult } : {}), text };
  }

  private async elicit(request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    if (this.options.catalogOnly || !this.ready) return { action: "decline" };
    const server = request.displayName || request.serverName;
    const heading = request.title?.trim() || `MCP server ${server}`;
    const message = [request.message, request.description].filter((part) => part && part.trim()).join("\n\n");
    if (request.mode === "url") {
      const url = safeElicitationUrl(request.url);
      if (!url) return { action: "decline" };
      this.emit({ type: "extension_ui_request", id: randomUUID(), method: "open_url", url, instructions: `${heading}: ${request.message}` });
      const choice = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "select", title: `${heading} asks you to open a link\n${message}\n\n${url}`, options: ["I have opened the link", "Decline"] }, signal);
      if (choice.cancelled || signal.aborted) return { action: "cancel" };
      return { action: choice.value === "I have opened the link" ? "accept" : "decline" };
    }
    const fields = elicitationFields(request.requestedSchema);
    if (!fields) {
      this.emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message: `${heading} requested a form the web cannot display; it was declined.`, notifyType: "warning" });
      return { action: "decline" };
    }
    const start = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "select", title: `${heading} requests information\n${message || "No details provided."}`, options: ["Respond", "Decline"] }, signal);
    if (start.cancelled || signal.aborted) return { action: "cancel" };
    if (start.value !== "Respond") return { action: "decline" };
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const label = `${heading}: ${field.title}${field.required ? "" : " (optional)"}`;
      if (field.kind === "enum" || field.kind === "boolean") {
        const options = field.kind === "boolean" ? ["Yes", "No"] : field.options.map((option) => option.label);
        const choice = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "select", title: field.description ? `${label}\n${field.description}` : label, options: field.required ? options : [...options, "Skip"] }, signal);
        if (choice.cancelled || signal.aborted || typeof choice.value !== "string") return { action: "cancel" };
        if (choice.value === "Skip" && !field.required) continue;
        content[field.key] = field.kind === "boolean" ? choice.value === "Yes" : field.options.find((option) => option.label === choice.value)?.value;
        continue;
      }
      let problem = "";
      for (let attempt = 0; ; attempt++) {
        const answer = await this.ask({
          type: "extension_ui_request", id: randomUUID(), method: "input",
          title: [label, problem || field.description].filter(Boolean).join("\n"),
          ...(field.kind === "multi" ? { choices: field.options.map((option) => ({ label: option.label })) } : {}),
          placeholder: field.kind === "multi" ? "Comma-separated choices" : field.kind === "string" && field.format ? field.format : field.required ? "Required" : "Leave empty to skip",
        }, signal);
        if (answer.cancelled || signal.aborted || typeof answer.value !== "string") return { action: "cancel" };
        if (!answer.value.trim() && !field.required) break;
        try {
          if (!answer.value.trim()) throw new Error("This field is required");
          content[field.key] = parseElicitationAnswer(field, answer.value);
          break;
        }
        catch (error) {
          if (attempt >= 2) return { action: "cancel" };
          problem = error instanceof Error ? error.message : String(error);
        }
      }
    }
    // Values are validated per field above: strings, numbers, booleans or string arrays.
    return { action: "accept", content } as ElicitationResult;
  }

  private recallItems() { return this.steeringAvailable && this.query && canRecallClaudeInput(this.query) ? this.inputs.pendingItems() : []; }
  private queueChanged(): void { this.emit({ type: "queue_update", ...this.inputs.queued(), items: this.recallItems() }); this.changed(); }

  private finishTurn(): void {
    if (!this.busy) return;
    this.inputs.clear();
    this.steeredCycle = false;
    clearTimeout(this.stopTimer);
    this.queueChanged();
    this.cancelDialogs(false);
    for (const event of this.system.reset()) this.emit(event);
    this.busy = false;
    this.context.invalidate();
    this.interruptRequested = false;
    this.emit({ type: "agent_end" });
    this.emit({ type: "prompt_done" });
    this.emit({ type: "agent_settled" });
    this.changed();
    this.resetIdle();
    if (!this.closed) {
      this.nativeHistory = true;
      void this.context.get();
      void this.refreshNativeTitle(true);
    }
  }

  private ask(event: Dialog, signal: AbortSignal, background = false): Promise<Record<string, unknown>> {
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
        this.changed();
        resolve(response);
      };
      const abort = () => finish({ cancelled: true });
      const timer = setTimeout(abort, 5 * 60_000);
      timer.unref();
      event = { ...event, timeout: 5 * 60_000, expiresAt: Date.now() + 5 * 60_000 };
      this.dialogs.set(event.id, { event, finish, background });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else { this.emit(event); this.changed(); }
    });
  }

  private async permission(tool: string, input: Record<string, unknown>, context: CanUseToolContext, background = false): Promise<PermissionResult> {
    const signal = context.signal;
    const deny: PermissionResult = { behavior: "deny", message: "Not approved in the web UI (denied, cancelled or timed out)." };
    if (this.options.catalogOnly) return deny;
    if (tool === "ExitPlanMode") {
      const plan = typeof input.plan === "string" && input.plan.trim() ? input.plan : "Claude Code did not include a plan.";
      const choice = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "select", title: `Claude Code: ready to leave plan mode?\n${plan.slice(0, 24_000)}`, options: [PLAN_ACCEPT_EDITS, PLAN_REVIEW_EDITS, PLAN_KEEP] }, signal, background);
      if (choice.cancelled || signal.aborted || typeof choice.value !== "string") return deny;
      if (choice.value === PLAN_ACCEPT_EDITS || choice.value === PLAN_REVIEW_EDITS) {
        const mode: PermissionMode = choice.value === PLAN_ACCEPT_EDITS ? "acceptEdits" : "default";
        return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
      }
      const feedback = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "input", title: "What should Claude change in the plan?", placeholder: "Optional feedback" }, signal, background);
      const note = !feedback.cancelled && typeof feedback.value === "string" ? feedback.value.trim().slice(0, 8000) : "";
      return { behavior: "deny", message: note ? `The user wants to keep planning. Feedback: ${note}` : "The user wants to keep planning. Do not start implementing yet." };
    }
    if (tool === "AskUserQuestion") {
      if (!Array.isArray(input.questions) || !input.questions.length) return deny;
      const answers: Record<string, string> = {};
      for (const raw of input.questions) {
        if (!raw || typeof raw !== "object" || typeof raw.question !== "string") return deny;
        const answer = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "input", title: raw.question, ...questionDisplay(raw), placeholder: raw.multiSelect ? "Enter one or more answers" : "Enter your answer" }, signal, background);
        if (answer.cancelled || typeof answer.value !== "string" || !answer.value.trim()) return deny;
        answers[raw.question] = answer.value;
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    const details = JSON.stringify(input, null, 2);
    if (details.length > 24_000) return { behavior: "deny", message: "Tool input is too large to review safely in the web approval dialog" };
    // First choice is denial. "Always allow" applies only Claude's own additive
    // suggestions for this call; never bypassPermissions.
    const suggestions = context.suppressAlwaysAllowRule ? [] : allowSuggestions(context.suggestions);
    const rule = describePermissionUpdates(suggestions);
    const persistent = persistentDestination(suggestions);
    const sessionOption = `Always allow in this session: ${rule}`;
    const persistentOption = persistent ? `Always allow (save to ${persistent}): ${rule}` : undefined;
    const options = ["Deny", "Allow once", ...(suggestions.length ? [sessionOption] : []), ...(persistentOption ? [persistentOption] : [])];
    const notes = [context.description, context.decisionReason, context.blockedPath && `Path: ${context.blockedPath}`]
      .filter((note): note is string => typeof note === "string" && Boolean(note.trim())).map((note) => note.replace(/\s+/g, " ").trim());
    const heading = [context.title?.trim() || `Claude Code: ${context.displayName || tool}`, ...notes].join(" — ").slice(0, 600);
    const response = await this.ask({ type: "extension_ui_request", id: randomUUID(), method: "select", title: `${heading}\n${details}`, options }, signal, background);
    if (response.cancelled || signal.aborted || typeof response.value !== "string") return deny;
    if (response.value === "Allow once") return { behavior: "allow", updatedInput: input };
    if (suggestions.length && response.value === sessionOption) return { behavior: "allow", updatedInput: input, updatedPermissions: sessionScoped(suggestions) };
    if (persistentOption && response.value === persistentOption) return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
    return deny;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    await this.waitUntilReady();
    this.resetIdle();
    switch (command.type) {
      case "get_state": {
        if (!this.isRunning() && !this.changingModel) await this.refreshModelSettings();
        const [contextUsage] = await Promise.all([this.context.get(this.busy || this.changingModel), this.refreshNativeTitle()]);
        return {
          sessionId: this.sessionId, sessionFile: this.sessionFile, sessionName: this.sessionName(),
          engine: this.engine, model: this.model ? { id: this.model, provider: "claude-code" } : undefined,
          thinkingLevel: this.modelSettings?.effort ?? "auto", effortControlAvailable: this.effortControlAvailable,
          isPromptRunning: this.busy, isStreaming: this.busy, isSettled: !this.busy && !this.tasks.active,
          tasks: this.tasks.snapshot(),
          isBashRunning: false, isCompacting: this.system.isCompacting, pendingMessageCount: this.inputs.queued().steering.length + this.inputs.queued().followUp.length,
          supportsSteering: this.steeringAvailable,
          permissionMode: this.permissionMode, permissionModes: CLAUDE_WEB_PERMISSION_MODES,
          queuedMessages: this.inputs.queued(), queuedItems: this.recallItems(), extensionStatuses: [], extensionWidgets: [],
          systemPrompt: "", contextUsage,
        };
      }
      case "get_task_detail": {
        const id = String(command.taskId ?? "");
        const detail = this.tasks.detail(id); // Ownership check before any native read.
        if (!["local_agent", "subagent", "task"].includes(detail.task.kind)) return detail;
        const messages = await this.readChildMessages(this.nativeId, id, this.cwd);
        return this.tasks.detail(id, taskTranscript(messages));
      }
      case "get_available_models": {
        if (!this.isRunning() && !this.changingModel) await this.refreshModelSettings();
        return { models: await readClaudeModels(this.query!), settings: this.modelSettings, effortControlAvailable: this.effortControlAvailable };
      }
      case "get_native_usage": return this.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      case "get_commands": return { commands: claudeSlashCommands(await this.query!.supportedCommands(), this.terminalCommands) };
      case "get_skill_commands": return { commands: await this.query!.supportedCommands() };
      case "get_tools": return this.tools.map((name) => ({ name, description: "Claude Code native tool", active: true }));
      case "get_available_thinking_levels": return { levels: claudeEffortLevels(await readClaudeModels(this.query!), this.model) };
      case "set_thinking_level": {
        if (this.isRunning() || this.changingModel) throw new Error("Wait for Claude Code to finish before changing effort");
        const level = command.level;
        if (level !== "auto" && !isClaudeEffort(level)) throw new Error("Invalid Claude effort level");
        if (!this.effortControlAvailable) throw new Error("Native Claude effort controls are not supported by this CLI/SDK");
        this.changingModel = true;
        this.settingsRevision++;
        try {
          await this.refreshModelSettings();
          if (level !== "auto" && !claudeEffortLevels(await readClaudeModels(this.query!), this.model).includes(level)) {
            throw new Error("Effort level is not supported by the selected native Claude model");
          }
          await this.query!.applyFlagSettings({ effortLevel: level === "auto" ? null : level });
          await this.refreshModelSettings();
          this.transcript?.setEffort(level === "auto" ? "auto" : this.modelSettings?.effort ?? level);
          this.changed();
          return { thinkingLevel: this.modelSettings?.effort ?? "auto" };
        } finally { this.changingModel = false; this.context.invalidate(); }
      }
      case "set_permission_mode": {
        const mode = command.mode;
        if (!isClaudeWebPermissionMode(mode)) throw new Error("Unsupported Claude Code permission mode");
        if (this.stopping || this.changingModel) throw new Error("Claude is stopping or switching models; retry shortly");
        // The CLI validates availability (e.g. auto mode needs a supported account/model).
        await this.query!.setPermissionMode(mode);
        this.updatePermissionMode(mode);
        this.transcript?.setPermissionMode(mode);
        return { permissionMode: this.permissionMode };
      }
      case "get_mcp_status": return { servers: projectMcpStatus(await this.query!.mcpServerStatus()) };
      case "mcp_reconnect":
      case "mcp_toggle": {
        const name = command.name;
        if (typeof name !== "string" || !name) throw new Error("name is required");
        // Only act on a server Claude Code itself reports for this session.
        if (!projectMcpStatus(await this.query!.mcpServerStatus()).some((server) => server.name === name)) throw new Error("Unknown MCP server in this session");
        if (command.type === "mcp_reconnect") await this.query!.reconnectMcpServer(name);
        else {
          if (typeof command.enabled !== "boolean") throw new Error("enabled must be a boolean");
          await this.query!.toggleMcpServer(name, command.enabled);
        }
        return { servers: projectMcpStatus(await this.query!.mcpServerStatus()) };
      }
      case "stop_task": {
        const id = String(command.taskId ?? "");
        const detail = this.tasks.detail(id); // Ownership check: only tasks this session reported.
        if (!detail.task.active) return { stopped: false };
        await this.query!.stopTask(id);
        return { stopped: true };
      }
      case "background_tasks": {
        if (!this.busy) throw new Error("Nothing is running in the foreground");
        const toolUseId = typeof command.toolUseId === "string" && command.toolUseId ? command.toolUseId : undefined;
        return { backgrounded: await this.query!.backgroundTasks(toolUseId) };
      }
      case "fork": return this.fork(command.entryId);
      case "rewind_preview": return this.rewindPreview(command.entryId);
      case "rewind": return this.rewind(command.entryId, command.mode);
      case "get_messages": return { messages: this.transcript!.getMessages() };
      case "get_last_assistant_text": {
        const last = this.transcript!.getMessages().findLast((m) => m.role === "assistant");
        return { text: last?.role === "assistant" ? last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "" };
      }
      case "get_session_stats": return { sessionId: this.sessionId, sessionName: this.sessionName(), contextUsage: await this.context.get(this.busy || this.changingModel) };
      case "extension_ui_response": {
        if (typeof command.id === "string") this.dialogs.get(command.id)?.finish(command);
        return null;
      }
      case "recall_queued_message": {
        if (this.stopping || this.interruptRequested || this.recalling) throw new Error("A queue operation is already in progress");
        const item = this.recallItems().find(item => item.id === command.id);
        if (!item) return { removed: false };
        this.recalling = item.id;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          let removed = this.input.remove(item.id);
          if (!removed) {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (!this.recallItems().some(pending => pending.id === item.id) || this.stopping || this.interruptRequested) return { removed: false };
            removed = await Promise.race([recallClaudeInput(this.query!, item.id), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Recall was not confirmed; check the queue before resending")), 5000); })]);
          }
          if (!removed) return { removed: false };
          this.inputs.cancel([item.id]); this.queueChanged();
          if (!this.inputs.size && !this.stopping) this.finishTurn();
          return { removed: true, ...item };
        } finally { clearTimeout(timer); this.recalling = undefined; }
      }
      case "abort": {
        if (!this.busy || this.stopping || this.interruptRequested) return null;
        this.stopping = true;
        this.interruptRequested = true;
        this.cancelDialogs();
        this.inputs.cancel(this.input.clear());
        this.queueChanged();
        const cancelQueued = this.steeringAvailable || this.steeredCycle;
        this.stopTimer = setTimeout(() => {
          this.emit({ type: "prompt_error", errorMessage: "Claude stop timed out; the native process was closed. Pending messages will not be resent." });
          this.destroy();
        }, 5000);
        try {
          // Let messages already yielded to the SDK reach its FIFO transport.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const receipt = await interruptClaude(this.query!, cancelQueued);
          if (this.closed) return null;
          if (cancelQueued) {
            if (!receipt || !Array.isArray(receipt.cancelled) || receipt.still_queued.length) throw new Error("Unconfirmed queue cancellation");
            this.inputs.cancel(receipt.cancelled);
            if (this.inputs.unstartedIds().length) throw new Error("An unsent input survived cancellation");
          }
        } catch {
          if (!this.closed) {
            this.emit({ type: "prompt_error", errorMessage: "Claude did not confirm stopping all pending input; the native process was closed. Pending messages will not be resent." });
            this.destroy();
          }
        } finally {
          this.stopping = false;
          this.queueChanged();
          if (!this.inputs.size) this.finishTurn();
        }
        return null;
      }
      case "set_session_name": {
        if (typeof command.name !== "string") throw new Error("name must be a string");
        const before = this.sessionName();
        this.transcript!.rename(command.name.trim());
        const after = this.sessionName();
        // Clearing the web name falls back to Claude's own title rather than "untitled".
        if (after !== before) this.emit({ type: "session_info_update", sessionId: this.sessionId, title: after ?? "" });
        this.changed();
        return null;
      }
      case "set_model": {
        if (this.isRunning() || this.changingModel) throw new Error("Wait for Claude Code to finish before switching models");
        if (command.provider !== "claude-code" || typeof command.modelId !== "string") throw new Error("Select a native Claude Code model");
        this.changingModel = true;
        this.settingsRevision++;
        this.context.reset();
        try {
          const models = await readClaudeModels(this.query!);
          if (!models.some((model) => model.value === command.modelId || model.resolvedModel === command.modelId)) throw new Error("Model is not in the native Claude Code catalog");
          await this.query!.setModel(command.modelId);
          this.model = command.modelId;
          await this.refreshModelSettings();
          this.projector!.setModel(this.model);
          this.transcript?.setModel(this.model);
          // Persist the new model's applied effort, never a stale unsupported
          // override belonging to the previous model.
          if (this.modelSettings) this.transcript?.setEffort(this.modelSettings.effort ?? "auto");
          this.changed();
          return { id: this.model, provider: "claude-code", thinkingLevel: this.modelSettings?.effort ?? "auto" };
        } finally { this.changingModel = false; this.context.invalidate(); }
      }
      case "steer":
      case "follow_up":
      case "prompt": {
        if (this.options.catalogOnly) throw new Error("Catalog clients cannot submit model prompts");
        const kind: ClaudeInputKind = command.type === "steer" || command.streamingBehavior === "steer" ? "steer"
          : command.type === "follow_up" || command.streamingBehavior === "followUp" ? "follow_up" : "prompt";
        if (command.streamingBehavior !== undefined && !["steer", "followUp"].includes(String(command.streamingBehavior))) throw new Error("Invalid streaming behavior");
        if (this.stopping || this.interruptRequested || this.changingModel) throw new Error("Claude is stopping or switching models; keep this message in the composer and retry later");
        if (kind !== "prompt" && !this.steeringAvailable) throw new Error("This Claude CLI has not advertised safe streaming-input support yet");
        if (this.busy && kind === "prompt") throw new Error("Claude Code is busy; use Steer or Follow-up");
        if (typeof command.message !== "string" || !command.message.trim()) throw new Error("message must be a nonempty string");
        if (this.busy && (command.message.trimStart().startsWith("/") || Array.isArray(command.images) && command.images.length)) throw new Error("Claude streaming input currently supports plain text only; send commands and attachments after the run");
        if (this.inputs.size >= 32 || this.busy && Buffer.byteLength(command.message) > 64 * 1024) throw new Error("Claude pending input limit reached (32 messages / 64 KiB per message)");
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
        const queued = this.busy, id = randomUUID();
        this.inputs.add(id, message, queued ? kind : "prompt");
        this.nativeUuids.set(message, id);
        if (!queued) {
          this.projector!.resetTurn();
          this.permissionReplies.clear();
          this.busy = true;
          this.interruptRequested = false;
          this.emit({ type: "agent_start" });
          this.deliver([message]);
        } else this.steeredCycle = true;
        this.context.invalidate();
        this.queueChanged();
        this.input.push({ type: "user", session_id: this.nativeId, parent_tool_use_id: null, uuid: id,
          ...(queued ? { priority: kind === "steer" ? "next" as const : "later" as const } : {}),
          message: { role: "user", content: content as SDKUserMessage["message"]["content"] } });
        return null;
      }
      default: throw new Error(`Claude Code web adapter does not support ${String(command.type)} yet`);
    }
  }

  private cancelDialogs(includeBackground = true): void {
    for (const dialog of [...this.dialogs.values()]) {
      if (includeBackground || !dialog.background) dialog.finish({ cancelled: true });
    }
  }
  private resetIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.tasks.active || this.changingModel || this.dialogs.size) this.resetIdle();
      else this.destroy();
    }, 10 * 60_000);
    this.idleTimer.unref();
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.nativeTitleWatch);
    this.nativeTitleWatch = undefined;
    for (const request of this.titleRequests) request.abort(new Error("Claude Code session closed"));
    this.tasks.disconnected();
    this.stopping = false;
    clearTimeout(this.stopTimer);
    this.context.reset();
    clearTimeout(this.idleTimer);
    this.cancelDialogs();
    this.finishTurn();
    for (const event of this.system.reset()) this.emit(event);
    this.input.close();
    this.query?.close();
    this.emit({ type: "agent_closed" });
    this.onDestroyCallback?.();
    this.changed();
  }
  async shutdown(): Promise<void> {
    this.destroy();
    await this.loop;
  }
}
