"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage } from "@/lib/types";
import { engineForSession, engineLabel as getEngineLabel, supportsExtendedChat, type AgentEngine } from "@/lib/engine";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { CollapsedHistoryTurn, HistoryTurnToggle } from "./HistoryTurnFold";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { NewSessionDirectoryPicker } from "./NewSessionDirectoryPicker";
import { clearDraft, getDraft, setDraft } from "@/lib/draft-store";
import { useI18n } from "@/hooks/useI18n";
import { AgentTasksPanel } from "./AgentTasksPanel";
import type { AgentTask } from "@/lib/agent-task-types";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { historyTurnKey, isTurnAnchor } from "@/lib/history-turns";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  engine: AgentEngine;
  onNewSession?: (cwd: string, engine: AgentEngine) => void;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  onSessionNameChange?: (sessionId: string, name: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenTask?: (sessionId: string, task: AgentTask) => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. A compaction summary also anchors a turn (see
// isTurnAnchor): compaction can replace the prompt mid-turn, and the
// remaining tool calls and answer must still collapse under something.

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, children, t }: { messageCount: number; toolCallCount: number; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, newSessionCwd, engine: newChatEngine, onNewSession, onAgentEnd, onSessionCreated, onSessionForked, onSessionNameChange, modelsRefreshKey, chatInputRef: externalChatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onOpenTask }: Props) {
  const { t, locale } = useI18n();
  const engine = session ? session.engine ?? engineForSession(session.id) : newChatEngine;
  const engineLabel = getEngineLabel(engine);
  const localChatInputRef = useRef<ChatInputHandle | null>(null);
  const chatInputRef = externalChatInputRef ?? localChatInputRef;
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((content: string) => {
    chatInputRef?.current?.editText(content);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState, taskSnapshot, taskStatusStale,
    historyPageError, historyTurns, historyTurnStates, toggleHistoryTurn,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, effortControlAvailable, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, canSendDuringRun, canQueueFollowUp,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueuedMessage, recallingQueue,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, loadSlashCommands,
  } = useAgentSession({
    session, newSessionCwd, engine, onNewSession, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    onSessionNameChange,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });
  const sessionBusy = agentRunning || bashRunning;

  useEffect(() => {
    if (!extensionDialog || soundedExtensionDialogIdRef.current === extensionDialog.id) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // Dropped files are accepted while the agent runs too; ChatInput decides
  // what can be queued (text/@references) and what waits for the run (images).
  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addFiles(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  // Everything shown, in display order: open history turns in full, a
  // collapsed prompt turn as its preview, then the loaded window. The
  // minimap walks this list; its user/assistant entries index messageRefs.
  const displayedMessages = useMemo(() => {
    if (historyTurns.length === 0) return messages;
    const list: AgentMessage[] = [];
    for (const turn of historyTurns) {
      const state = historyTurnStates[historyTurnKey(turn)];
      if (state?.expanded && state.messages) list.push(...state.messages);
      else if (turn.kind === "user") list.push({ role: "user", content: turn.text, timestamp: turn.timestamp });
    }
    list.push(...messages);
    return list;
  }, [historyTurns, historyTurnStates, messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(displayedMessages.filter((m) => m.role === "user" || m.role === "assistant").length);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  // Choosing another directory restarts the empty chat there; the unsent
  // draft (text and in-memory images) moves with it.
  const handleNewSessionCwdChange = useCallback((cwd: string) => {
    if (!onNewSession || !newSessionCwd || cwd === newSessionCwd) return;
    const fromKey = `new:${engine}:${newSessionCwd}`;
    const draft = getDraft(fromKey);
    if (draft) {
      setDraft(`new:${engine}:${cwd}`, draft);
      clearDraft(fromKey);
    }
    onNewSession(cwd, engine);
  }, [engine, newSessionCwd, onNewSession]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      engine={engine}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning && canSendDuringRun ? handleSteer : undefined}
      onFollowUp={agentRunning && canQueueFollowUp ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning && canSendDuringRun ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      onCompact={supportsExtendedChat(engine) && (session || isNew) ? handleCompact : undefined}
      onAbortCompaction={engine === "omp" ? handleAbortCompaction : undefined}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={(supportsExtendedChat(engine) || (engine === "claude" && effortControlAvailable && Boolean(availableThinkingLevels?.length))) && (session || isNew) ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueuedMessage={handleRecallQueuedMessage}
      recallingQueue={recallingQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${engine}:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <div className="relative flex flex-col items-center gap-4 text-center" role="status">
            <svg width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6M12 18v-7m-3 3 3-3 3 3" />
            </svg>
            <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("chat.dropFiles")}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("chat.uploadLimits")}</span>
          </div>
        </div>
      )}

      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>{engine === "codex" ? "CX" : engine === "claude" ? "CC" : engine === "pi" ? "π" : "Ω"}</span>
                <span style={{ fontSize: isMobile ? 18 : 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>{engineLabel} Chat</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {engineLabel} <span style={{ color: "var(--text)" }}>{locale === "zh-CN" ? "本机运行" : "Runs locally"}</span>
                </span>
              </div>
            </div>
            {newSessionCwd && onNewSession && (
              <div style={{ margin: "0 16px 12px", display: "flex", minWidth: 0 }}>
                <NewSessionDirectoryPicker cwd={newSessionCwd} onChange={handleNewSessionCwdChange} />
              </div>
            )}
            {engine === "claude" && <p style={{ margin: "0 16px 10px", fontSize: 12, lineHeight: 1.5, color: "var(--text-dim)" }}>{locale === "zh-CN" ? "直接使用本机 Claude Code 的登录和配置。需要你授权时会弹出确认。" : "Uses this machine's native Claude Code login and configuration. Approval prompts appear when needed."}</p>}
            {engine === "codex" && <p style={{ margin: "0 16px 10px", fontSize: 12, lineHeight: 1.5, color: "var(--text-dim)" }}>{locale === "zh-CN" ? "直接使用本机 Codex CLI。需要你授权时会弹出确认。" : "Runs your local Codex CLI directly. Approval prompts appear when needed."}</p>}
            <NoticeShelf notices={notices} align="right" />
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        <div ref={scrollContainerRef} className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]">
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            {(() => {
              // One renderer for the loaded window and for every expanded history
              // turn. `refBase` offsets this segment's user/assistant messages into
              // messageRefs at their position in displayedMessages (minimap order).
              const renderSegment = (
                segMessages: AgentMessage[],
                segEntryIds: string[],
                options: { refBase: number; live: boolean; branchStart: boolean; prevAssistantEntryId?: string },
              ): ReactNode[] => {
                const toolResultsMap = new Map<string, ToolResultMessage>();
                for (const msg of segMessages) {
                  if (msg.role === "toolResult") {
                    toolResultsMap.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
                  }
                }

                let lastUserIdx = -1;
                if (options.live) {
                  for (let i = segMessages.length - 1; i >= 0; i--) {
                    if (segMessages[i].role === "user") { lastUserIdx = i; break; }
                  }
                }
                // Anchor for live-tail detection: the last user message, or a
                // compaction summary when compaction has replaced it mid-turn.
                // Computed independently from lastUserIdx (which is kept for the
                // scroll-to-user ref) because a compaction summary can sit after
                // the last user message and anchor the still-streaming segment.
                let lastAnchorIdx = -1;
                for (let i = segMessages.length - 1; i >= 0; i--) {
                  if (isTurnAnchor(segMessages[i])) { lastAnchorIdx = i; break; }
                }

                const visibleRefIndexByMessage = new Map<number, number>();
                let refIdx = options.refBase;
                segMessages.forEach((msg, idx) => {
                  if (msg.role === "user" || msg.role === "assistant") {
                    visibleRefIndexByMessage.set(idx, refIdx++);
                  }
                });

                const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                  messageRefs.current[refIndex] = el;
                  if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
                };

                const renderMessage = (idx: number, renderOptions: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean } = {}): ReactNode => {
                  const msg = renderOptions.messageOverride ?? segMessages[idx];
                  // The first prompt of a segment edits from the previous turn's final assistant entry.
                  const prevAssistantEntryId = msg.role !== "user"
                    ? undefined
                    : idx > 0
                      ? (segMessages[idx - 1].role === "assistant" ? segEntryIds[idx - 1] : undefined)
                      : options.prevAssistantEntryId;
                  const isVisible = msg.role === "user" || msg.role === "assistant";
                  const currentRefIdx = visibleRefIndexByMessage.get(idx);
                  const keyPrefix = renderOptions.keyPrefix ?? "message";
                  let showTimestamp = false;
                  if (msg.role === "assistant") {
                    showTimestamp = true;
                    for (let j = idx + 1; j < segMessages.length; j++) {
                      const r = segMessages[j].role;
                      if (r === "user") break;
                      if (r === "assistant") { showTimestamp = false; break; }
                    }
                    // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                    if (showTimestamp && options.live && streamState.isStreaming && idx === segMessages.length - 1) {
                      showTimestamp = false;
                    }
                  }
                  if (renderOptions.showTimestamp !== undefined) showTimestamp = renderOptions.showTimestamp;
                  const view = (
                    <MessageView
                      key={`${keyPrefix}-view-${idx}`}
                      message={msg}
                      toolResults={toolResultsMap}
                      modelNames={modelNames}
                      cwd={messageCwd}
                      onOpenFile={onOpenFile}
                      entryId={segEntryIds[idx]}
                      onFork={sessionBusy || isNew || !supportsExtendedChat(engine) || (options.branchStart && idx === 0 && msg.role === "user") ? undefined : handleFork}
                      forking={forkingEntryId === segEntryIds[idx]}
                      onNavigate={sessionBusy || engine !== "omp" ? undefined : handleNavigate}
                      prevAssistantEntryId={sessionBusy || engine !== "omp" ? undefined : prevAssistantEntryId}
                      onEditContent={handleEditContent}
                      showTimestamp={showTimestamp}
                      prevTimestamp={idx > 0 ? (segMessages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                      sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    />
                  );
                  if (!isVisible || renderOptions.attachRef === false || currentRefIdx === undefined) return view;
                  return (
                    <div key={`${keyPrefix}-${idx}`} ref={attachVisibleRef(idx, currentRefIdx)}>
                      {view}
                    </div>
                  );
                };

                const rendered: ReactNode[] = [];
                for (let idx = 0; idx < segMessages.length;) {
                  const msg = segMessages[idx];
                  if (!isTurnAnchor(msg)) {
                    rendered.push(renderMessage(idx));
                    idx += 1;
                    continue;
                  }

                  const userIdx = idx;
                  let endIdx = userIdx + 1;
                  while (endIdx < segMessages.length && !isTurnAnchor(segMessages[endIdx])) endIdx += 1;

                  const finalAssistantIdx = findFinalAssistantIndex(segMessages, userIdx, endIdx);

                  if (finalAssistantIdx === -1) {
                    for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                      rendered.push(renderMessage(renderIdx));
                    }
                    idx = endIdx;
                    continue;
                  }

                  const isLiveTail = options.live && (sessionBusy || streamState.isStreaming) && endIdx === segMessages.length && userIdx === lastAnchorIdx;
                  if (isLiveTail) {
                    for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                      rendered.push(renderMessage(renderIdx));
                    }
                    idx = endIdx;
                    continue;
                  }

                  rendered.push(renderMessage(userIdx));

                  const processIndices: number[] = [];
                  for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                    processIndices.push(processIdx);
                  }
                  const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(segMessages[processIdx]));
                  const finalAssistant = segMessages[finalAssistantIdx] as AssistantMessage;
                  const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                  const finalProcessMessage = finalSplit.processBlocks.length > 0
                    ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
                    : null;
                  const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                    ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                    : null;

                  const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
                  if (processCount > 0) {
                    const processRefIdx = visibleProcessIndices
                      .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
                      .find((value): value is number => typeof value === "number")
                      ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
                    const processGroup = (
                      <ProcessDetailsGroup
                        messageCount={processCount}
                        t={t}
                        toolCallCount={countToolCalls(segMessages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}
                      >
                        {visibleProcessIndices.map((processIdx) => renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }))}
                        {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })}
                      </ProcessDetailsGroup>
                    );
                    rendered.push(
                      <div
                        key={`process-group-${userIdx}-${finalAssistantIdx}`}
                        ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                      >
                        {processGroup}
                      </div>,
                    );
                  }

                  if (finalAnswerMessage) {
                    rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage }));
                  }
                  for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                }
                return rendered;
              };

              // Older turns, one per prompt: collapsed rows keep every prompt on
              // the page (and in the minimap) for direct jumps; an opened turn is
              // rendered whole, exactly like the recent window below.
              const rendered: ReactNode[] = [];
              let refCursor = 0;
              historyTurns.forEach((turn, turnIndex) => {
                const key = historyTurnKey(turn);
                const state = historyTurnStates[key];
                const toggle = () => { void toggleHistoryTurn(turn); };
                if (state?.expanded && state.messages && state.entryIds) {
                  const previous = historyTurns[turnIndex - 1];
                  const nodes = renderSegment(state.messages, state.entryIds, {
                    refBase: refCursor,
                    live: false,
                    branchStart: turnIndex === 0,
                    prevAssistantEntryId: previous?.endsWithAssistant ? previous.lastId : undefined,
                  });
                  // The bar stays directly under the prompt, where it was while collapsed.
                  nodes.splice(turn.kind === "user" ? 1 : 0, 0, <HistoryTurnToggle key="history-turn-toggle" turn={turn} state={state} onToggle={toggle} t={t} />);
                  rendered.push(<div key={`history-turn-${key}`} data-history-turn={turn.id}>{nodes}</div>);
                  refCursor += state.messages.filter((m) => m.role === "user" || m.role === "assistant").length;
                  return;
                }
                const refIndex = turn.kind === "user" ? refCursor++ : undefined;
                rendered.push(
                  <CollapsedHistoryTurn
                    key={`history-turn-${key}`}
                    turn={turn}
                    state={state}
                    onToggle={toggle}
                    t={t}
                    rowRef={refIndex === undefined ? undefined : (el) => { messageRefs.current[refIndex] = el; }}
                  />,
                );
              });
              const lastHistoryTurn = historyTurns.at(-1);
              rendered.push(...renderSegment(messages, entryIds, {
                refBase: refCursor,
                live: true,
                branchStart: historyTurns.length === 0,
                prevAssistantEntryId: lastHistoryTurn?.endsWithAssistant ? lastHistoryTurn.lastId : undefined,
              }));
              return (
                <>
                  {historyPageError && <p role="status" style={{ margin: "0 0 12px", textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>{locale === "zh-CN" ? "会话有更新或暂时无法读取，请重试。" : historyPageError}</p>}
                  {rendered}
                </>
              );
            })()}
            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} />
            )}

            {agentRunning && !streamState.streamingMessage && agentPhase && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {agentRunning && (
              <div style={{ height: scrollContainerRef.current ? scrollContainerRef.current.clientHeight : "80vh" }} />
            )}

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
        {isMobile ? null : (
          <ChatMinimap
            messages={displayedMessages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
          />
        )}
      </div>

      </>
      )}
      {/* Keep one composer mounted across the empty -> active -> persisted session transition. */}
      <div className="relative">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <AgentTasksPanel snapshot={taskSnapshot} mainRunning={sessionBusy} stale={taskStatusStale} onOpen={onOpenTask ? task => { if (sessionIdRef.current) onOpenTask(sessionIdRef.current, task); } : undefined} />
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
        <ExtensionStatusBar statuses={extensionStatuses} />
      </div>
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "40vh", overflow: "auto" }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              type={request.secret ? "password" : "text"}
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
