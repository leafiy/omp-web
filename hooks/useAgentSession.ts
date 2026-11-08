"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import { useI18n } from "./useI18n";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { hasActiveTasks, hasUnknownTasks, type AgentTaskSnapshot } from "@/lib/agent-task-types";
import { createAgentSession, sendAgentCommand } from "@/lib/agent-client";
import { resolveContextUsage } from "@/lib/context-usage";
import { fetchHistoryTurn, historyClientCache, historyUrl, HistoryRequestError } from "@/lib/history-client-cache";
import type { HistoryPage } from "@/lib/history-page";
import { historyTurnKey, type HistoryTurnSummary } from "@/lib/history-turns";
import { getDraft, setDraft } from "@/lib/draft-store";
import { engineForSession, engineLabel, supportsExtendedChat, type AgentEngine } from "@/lib/engine";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * Browser state of one outlined history turn, keyed by `historyTurnKey`.
 * A turn is fetched whole the first time it is expanded and then kept, so
 * collapsing and expanding again does not refetch.
 */
export interface HistoryTurnState {
  expanded: boolean;
  loading?: boolean;
  error?: "changed" | "failed";
  messages?: AgentMessage[];
  entryIds?: string[];
}

const NO_HISTORY_TURNS: HistoryTurnSummary[] = [];

export interface SessionData {
  page?: HistoryPage;
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  model?: { id: string; provider: string };
  tasks?: AgentTaskSnapshot;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  supportsSteering?: boolean;
  webFollowUpPending?: number;
  isNamingSession?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  queuedItems?: QueuedMessageItem[];
};

export interface QueuedMessageItem { id?: string; kind: "steer" | "follow_up"; text: string; state?: "queued" | "sending" | "unconfirmed"; source?: "web"; }
export interface QueuedMessages {
  queueEpoch?: string;
  queueRevision?: number;
  followUpPaused?: boolean;
  steering: string[];
  followUp: string[];
  items?: QueuedMessageItem[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[]; queueEpoch?: string; queueRevision?: number; followUpPaused?: boolean } | null, items?: QueuedMessageItem[]): QueuedMessages {
  const steering = q?.steering ?? [], followUp = q?.followUp ?? [];
  const identified = (items ?? []).filter(item => item.id && typeof item.text === "string" && ["steer", "follow_up"].includes(item.kind));
  const remaining = new Map<string, number>();
  for (const item of identified) { const key = `${item.kind}\0${item.text}`; remaining.set(key, (remaining.get(key) ?? 0) + 1); }
  const missing: QueuedMessageItem[] = [];
  for (const [kind, values] of [["steer", steering], ["follow_up", followUp]] as const) for (const text of values) {
    const key = `${kind}\0${text}`, count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1); else missing.push({ kind, text });
  }
  const ordered = [...identified, ...missing].sort((a, b) => {
    const priority = (item: QueuedMessageItem) => (item.kind === "steer" ? 0 : 2) + (item.source === "web" ? 1 : 0);
    return priority(a) - priority(b);
  });
  return { steering, followUp, items: ordered, queueEpoch: q?.queueEpoch, queueRevision: q?.queueRevision, followUpPaused: q?.followUpPaused };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "omp" | "pi" | "claude";
  argumentHint?: string;
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  engine?: AgentEngine;
  onNewSession?: (cwd: string, engine: AgentEngine) => void;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  onSessionNameChange?: (sessionId: string, name: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

type EventStreamConnectionAttempt = {
  source: EventSource;
  promise: Promise<EventStreamConnectionResult>;
  pending: boolean;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  editText: (text: string) => void;
  prependText: (text: string, notice?: string) => void;
  addFiles: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string; contextWindow?: number; resolvedModel?: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  defaultThinkingLevel?: string;
  effortControlAvailable?: boolean;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const { t } = useI18n();
  const {
    session, newSessionCwd, engine: newChatEngine = "omp", onNewSession, onAgentEnd, onSessionCreated, onSessionForked,
    onSessionNameChange,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  const engine = session ? session.engine ?? engineForSession(session.id) : newChatEngine;
  const modelCwd = session?.cwd ?? newSessionCwd ?? "";
  const modelScopeKey = JSON.stringify([engine, modelCwd]);
  const modelScopeRef = useRef(modelScopeKey);
  modelScopeRef.current = modelScopeKey;
  const modelRequestRef = useRef(0);
  const mountedRef = useRef(true);

  const [data, setData] = useState<SessionData | null>(null);
  const [historyPage, setHistoryPage] = useState<(HistoryPage & { leafId: string | null }) | null>(null);
  const [historyPageError, setHistoryPageError] = useState<string | null>(null);
  const [historyTurnStates, setHistoryTurnStates] = useState<Record<string, HistoryTurnState>>({});
  const historyTurnStatesRef = useRef(historyTurnStates);
  historyTurnStatesRef.current = historyTurnStates;
  const historyPageRef = useRef(historyPage);
  historyPageRef.current = historyPage;
  // Last persisted window (entry IDs parallel to messages); streamed additions are not included.
  const loadedWindowRef = useRef<{ messages: AgentMessage[]; entryIds: string[] }>({ messages: [], entryIds: [] });
  const historyLoadRevision = useRef(0), messageRevision = useRef(0);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [taskSnapshot, setTaskSnapshot] = useState<AgentTaskSnapshot | null>(null);
  const [taskStatusStale, setTaskStatusStale] = useState(false);
  const taskStatusStaleRef = useRef(false);
  const taskSnapshotRef = useRef<AgentTaskSnapshot | null>(null);
  const retiredTaskEpochsRef = useRef(new Set<string>());
  const completionDeferredRef = useRef(false);
  const completionRevisionRef = useRef(0);
  const notifiedCompletionRevisionRef = useRef(-1);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [effortControlAvailable, setEffortControlAvailable] = useState(false);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("full");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const extensionDialogsRef = useRef(new Map<string, ExtensionUiDialogRequest>());
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessagesState] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const queuedCountRef = useRef(0);
  const queueStampRef = useRef<{ epoch?: string; revision: number }>({ revision: -1 });
  const retiredQueueEpochsRef = useRef(new Set<string>());
  const setQueuedMessages = useCallback((value: QueuedMessages, reset = false) => {
    const normalized = normalizeQueuedMessages(value, value.items);
    const epoch = normalized.queueEpoch, revision = normalized.queueRevision ?? -1, previous = queueStampRef.current;
    if (!reset) {
      if (epoch && retiredQueueEpochsRef.current.has(epoch)) return;
      if (previous.epoch && !epoch) return;
      if (epoch === previous.epoch && revision < previous.revision) return;
      if (previous.epoch && epoch && epoch !== previous.epoch) retiredQueueEpochsRef.current.add(previous.epoch);
    }
    if (reset && previous.epoch) retiredQueueEpochsRef.current.add(previous.epoch);
    queueStampRef.current = { epoch, revision };
    queuedCountRef.current = normalized.steering.length + normalized.followUp.length;
    setQueuedMessagesState(normalized);
  }, []);
  const [nativeSteeringAvailable, setNativeSteeringAvailable] = useState(false);
  const [recallingQueue, setRecallingQueue] = useState(false);
  const recallingQueueRef = useRef(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventSourceSessionIdRef = useRef<string | null>(null);
  const eventConnectionAttemptRef = useRef<EventStreamConnectionAttempt | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  // SSE (re)connects replay the current title; only a real change needs reloads.
  const knownSessionNameRef = useRef<string>(session?.name ?? "");
  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const executeBashRef = useRef<((command: string, excludeFromContext: boolean) => Promise<boolean>) | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  const thinkingChangeRevisionRef = useRef(0);
  const promptRunIdRef = useRef(0);
  const contextRevisionRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
    const prefix = historyPage?.prefix;
    const tokens = prefix ? { ...prefix.tokens } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = prefix?.cost ?? 0;
    let userMessages = prefix?.userMessages ?? 0;
    let assistantMessages = prefix?.assistantMessages ?? 0;
    let toolResults = prefix?.toolResults ?? 0;
    let toolCalls = prefix?.toolCalls ?? 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;

    const matchedModel = displayModel
      ? modelList.find((m) => m.provider === displayModel.provider && m.id === displayModel.modelId)
      : null;
    // A native effective window may be smaller than the catalog. Never replace
    // it with a larger advertised value, or invent capacity from token usage.
    const effectiveContextUsage = resolveContextUsage(contextUsage,
      engine === "claude" || engine === "codex" ? undefined : matchedModel?.contextWindow);

    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: (prefix?.totalMessages ?? 0) + messages.length,
      tokens,
      cost,
      contextUsage: effectiveContextUsage,
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, displayModel, modelList, data?.filePath, session?.id, session?.name, engine, historyPage]);

  /**
   * Install a freshly read window and outline. Turns that just left the
   * loaded window (a newer turn pushed them out) stay open with the data
   * already on screen; states for turns no longer outlined are dropped.
   */
  const applyHistoryWindow = useCallback((d: SessionData) => {
    const previous = loadedWindowRef.current;
    const nextEntryIds = d.context.entryIds ?? [];
    loadedWindowRef.current = { messages: d.context.messages, entryIds: nextEntryIds };
    setMessages(d.context.messages); setEntryIds(nextEntryIds);
    setHistoryPage(d.page ? { ...d.page, leafId: d.leafId } : null); setHistoryPageError(null);
    const turns = d.page?.turns ?? NO_HISTORY_TURNS;
    setHistoryTurnStates((current) => {
      const next: Record<string, HistoryTurnState> = {};
      for (const turn of turns) {
        const key = historyTurnKey(turn), kept = current[key];
        if (kept?.messages || kept?.loading) { next[key] = kept; continue; }
        const start = previous.entryIds.indexOf(turn.id), end = start + turn.count;
        if (start >= 0 && end <= previous.messages.length && previous.entryIds[end - 1] === turn.lastId) {
          next[key] = { expanded: true, messages: previous.messages.slice(start, end), entryIds: previous.entryIds.slice(start, end) };
        }
      }
      return next;
    });
  }, []);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    let messagesLoaded = false;
    const revision = ++historyLoadRevision.current, streamRevision = messageRevision.current, modelRevision = contextRevisionRef.current;
    const current = () => mountedRef.current && sessionIdRef.current === sid && historyLoadRevision.current === revision && messageRevision.current === streamRevision && contextRevisionRef.current === modelRevision;
    const url = historyUrl(sid);
    const apply = (d: SessionData) => {
      if (!current() || d.sessionId !== sid) return;
      setData(d); setActiveLeafId(d.leafId); applyHistoryWindow(d);
      setCurrentModelOverride(null); setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      messagesLoaded = true; if (showLoading) setLoading(false);
    };
    try {
      const cached = historyClientCache.peek(url);
      if (showLoading && cached) apply(cached);
      else if (showLoading) setLoading(true);
      let d: SessionData;
      try { d = await historyClientCache.load(url); }
      catch (failure) {
        if (!(failure instanceof HistoryRequestError) || failure.status !== 409 || !current()) throw failure;
        historyClientCache.invalidate(sid); d = await historyClientCache.load(url);
      }
      if (!current()) return null;
      apply(d);
      if (!includeState) return null;

      try {
        const contextRevision = contextRevisionRef.current;
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse; lastContextUsage?: AgentStateResponse["contextUsage"] };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.supportsSteering !== undefined) setNativeSteeringAvailable(liveState.supportsSteering);
          if (contextRevision === contextRevisionRef.current && liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages, liveState.queuedItems));
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
          // The idle-closed native process reported this before exiting; no estimate.
          const last = resolveContextUsage(agentState.lastContextUsage);
          if (last && contextRevision === contextRevisionRef.current) setContextUsage(last);
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      // A superseded request is not a history failure; the newer load applies.
      if (e instanceof DOMException && e.name === "AbortError") return null;
      if (current()) {
        if (e instanceof HistoryRequestError && [401, 403, 404].includes(e.status)) {
          setData(null); setMessages([]); setEntryIds([]); setHistoryPage(null); setHistoryTurnStates({});
          loadedWindowRef.current = { messages: [], entryIds: [] };
        }
        setError(String(e));
      }
      return null;
    } finally {
      if (mountedRef.current && showLoading && !messagesLoaded && historyLoadRevision.current === revision) setLoading(false);
    }
  }, [applyHistoryWindow]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    const revision = ++historyLoadRevision.current, streamRevision = messageRevision.current;
    try {
      const d = await historyClientCache.load(historyUrl(sid, leafId ? { leafId } : {}));
      if (!mountedRef.current || sessionIdRef.current !== sid || historyLoadRevision.current !== revision || messageRevision.current !== streamRevision) return;
      applyHistoryWindow(d);
    } catch { if (mountedRef.current && historyLoadRevision.current === revision) setHistoryPageError("History could not be loaded. Please retry."); }
  }, [applyHistoryWindow]);

  /** Expand or collapse one outlined turn; the first expansion fetches it whole. */
  const toggleHistoryTurn = useCallback(async (turn: HistoryTurnSummary) => {
    const sid = sessionIdRef.current, key = historyTurnKey(turn);
    const state = historyTurnStatesRef.current[key];
    if (state?.loading) return;
    if (state?.messages) {
      setHistoryTurnStates((current) => current[key] ? { ...current, [key]: { ...current[key], expanded: !current[key].expanded } } : current);
      return;
    }
    if (!sid) return;
    setHistoryTurnStates((current) => ({ ...current, [key]: { expanded: true, loading: true } }));
    try {
      const d = await fetchHistoryTurn(sid, turn, historyPageRef.current?.leafId ?? null);
      if (!mountedRef.current || sessionIdRef.current !== sid) return;
      // Only fill a request the current outline still contains.
      setHistoryTurnStates((current) => current[key]?.loading ? { ...current, [key]: { expanded: true, messages: d.messages, entryIds: d.entryIds } } : current);
    } catch (failure) {
      if (!mountedRef.current || sessionIdRef.current !== sid) return;
      const changed = failure instanceof HistoryRequestError && failure.status === 409;
      setHistoryTurnStates((current) => current[key]?.loading ? { ...current, [key]: { expanded: false, error: changed ? "changed" : "failed" } } : current);
      // The outline is stale (branch moved or file replaced). Refresh it when idle;
      // a running prompt reloads history itself once it settles.
      if (changed && !agentRunningRef.current) { historyClientCache.invalidate(sid); void loadSession(sid); }
    }
  }, [loadSession]);

  const loadTools = useCallback(async (sid: string) => {
    if (engine !== "omp") return;
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [engine, setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!mountedRef.current || !isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      engine,
      path: "",
      cwd: newSessionCwd,
      // A native title can arrive before the prompt request returns.
      name: knownSessionNameRef.current || undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    });
  }, [engine, isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit overrides. Each engine resolves its own native config.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const result = await createAgentSession<{
        sessionId: string;
        engine: AgentEngine;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
      }>(engine, {
        cwd: newSessionCwd,
        type: "ensure_session",
        ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
        ...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
      });
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [engine, isNew, newSessionCwd]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    eventSourceSessionIdRef.current = null;
    eventConnectionAttemptRef.current = null;
  }, []);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    eventSourceSessionIdRef.current = sid;

    const promise = new Promise<EventStreamConnectionResult>((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (eventConnectionAttemptRef.current?.source === es) {
          eventConnectionAttemptRef.current.pending = false;
        }
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      es.onmessage = (e) => {
        if (eventSourceRef.current !== es || sessionIdRef.current !== sid) return;
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle("connected");
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (eventSourceRef.current !== es || sessionIdRef.current !== sid) return;
        taskStatusStaleRef.current = true;
        setTaskStatusStale(true);
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions or an active idle grace window.
          settle("closed");
          if (eventSourceRef.current === es && (agentRunningRef.current || eventStreamGraceActiveRef.current)) {
            eventSourceRef.current = null;
            eventSourceSessionIdRef.current = null;
            eventConnectionAttemptRef.current = null;
            const reconnectGeneration = eventStreamGraceGenerationRef.current;
            setTimeout(() => {
              if (
                reconnectGeneration === eventStreamGraceGenerationRef.current
                && !eventSourceRef.current
                && (agentRunningRef.current || eventStreamGraceActiveRef.current)
              ) {
                void connectEvents(sid);
              }
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
    eventConnectionAttemptRef.current = { source: es, promise, pending: true };
    return promise;
  }, [closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const current = eventSourceRef.current;
    if (current && eventSourceSessionIdRef.current === sid) {
      if (current.readyState === EventSource.OPEN) return;
      const attempt = eventConnectionAttemptRef.current;
      if (attempt?.source === current && attempt.pending) {
        await attempt.promise;
        if (eventSourceRef.current === current && current.readyState === EventSource.OPEN) return;
      }
    }

    const result = await connectEvents(sid);
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    if (eventSourceSessionIdRef.current === sid) eventSourceSessionIdRef.current = null;
    if (eventConnectionAttemptRef.current?.source === result.source) eventConnectionAttemptRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
      extensionDialogsRef.current.delete(request.id);
      setExtensionDialog(extensionDialogsRef.current.values().next().value ?? null);
    } catch (e) {
      setError(`Failed to send ${engineLabel(engine)} UI response: ${String(e)}`);
    }
  }, [engine]);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    switch (request.method) {
      case "cancel":
        extensionDialogsRef.current.delete(request.targetId);
        setExtensionDialog(extensionDialogsRef.current.values().next().value ?? null);
        break;
      case "open_url":
        addNotice({ message: `${request.instructions ?? "Open this URL to continue"}: ${request.launchUrl ?? request.url}`, type: "info" });
        break;
      case "select":
      case "confirm":
      case "input":
      case "editor":
        extensionDialogsRef.current.set(request.id, request);
        setExtensionDialog(extensionDialogsRef.current.values().next().value ?? null);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const applyTaskSnapshot = useCallback((snapshot?: AgentTaskSnapshot) => {
    if (!snapshot) return;
    const previous = taskSnapshotRef.current;
    if (retiredTaskEpochsRef.current.has(snapshot.epoch)) return;
    if (previous?.epoch === snapshot.epoch && previous.revision > snapshot.revision) return;
    if (previous && previous.epoch !== snapshot.epoch) retiredTaskEpochsRef.current.add(previous.epoch);
    taskSnapshotRef.current = snapshot;
    if (hasActiveTasks(snapshot)) completionDeferredRef.current = true;
    taskStatusStaleRef.current = false;
    setTaskStatusStale(false);
    setTaskSnapshot(snapshot);
  }, []);

  const notifyCompletion = useCallback(() => {
    if (taskStatusStaleRef.current || queuedCountRef.current > 0 || hasActiveTasks(taskSnapshotRef.current) || hasUnknownTasks(taskSnapshotRef.current)) {
      completionDeferredRef.current = true;
      return;
    }
    completionDeferredRef.current = false;
    if (notifiedCompletionRevisionRef.current === completionRevisionRef.current) return;
    notifiedCompletionRevisionRef.current = completionRevisionRef.current;
    onAgentEnd?.();
  }, [onAgentEnd]);

  useEffect(() => {
    if (!completionDeferredRef.current || agentRunning || queuedCountRef.current > 0 || taskStatusStale || hasActiveTasks(taskSnapshot) || hasUnknownTasks(taskSnapshot)) return;
    const timer = setTimeout(() => { if (completionDeferredRef.current && !agentRunningRef.current) notifyCompletion(); }, 300);
    return () => clearTimeout(timer);
  }, [taskSnapshot, taskStatusStale, queuedMessages, agentRunning, notifyCompletion]);

  const notifyPromptStage = useCallback((runId: number) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    notifyCompletion();
    return true;
  }, [notifyCompletion]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        applyTaskSnapshot(state?.tasks);
        setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages, state?.queuedItems));
        if (!data.running && hasActiveTasks(taskSnapshotRef.current)) {
          taskStatusStaleRef.current = true;
          setTaskStatusStale(true);
        }
        const promptActive = Boolean(data.running && state && (state.isStreaming || state.isPromptRunning));
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && (state?.isNamingSession || (state?.webFollowUpPending ?? 0) > 0 || hasActiveTasks(state?.tasks))) {
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }
        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }

        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents, applyTaskSnapshot]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (promptRunIdRef.current !== runId) return;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        notifyCompletion();
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, notifyCompletion, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current && !queuedCountRef.current && !hasActiveTasks(taskSnapshotRef.current)) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId || sessionIdRef.current !== sid) return;
      const state = data.state;
      applyTaskSnapshot(state?.tasks);
      if (!data.running && hasActiveTasks(taskSnapshotRef.current)) {
        taskStatusStaleRef.current = true;
        setTaskStatusStale(true);
      }
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages, state?.queuedItems));
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      if (sessionIdRef.current === sid) {
        taskStatusStaleRef.current = true;
        setTaskStatusStale(true);
      }
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, applyTaskSnapshot]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning && !queuedCountRef.current && !hasActiveTasks(taskSnapshot)) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, taskSnapshot, queuedMessages, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "session_info_update": {
        const sid = sessionIdRef.current;
        if (!sid || event.sessionId !== sid || typeof event.title !== "string") break;
        const name = event.title;
        if (name === knownSessionNameRef.current) break;
        knownSessionNameRef.current = name;
        historyClientCache.invalidate(sid);
        setSessionStatsOverride((prev) => prev ? { ...prev, sessionName: name } : prev);
        onSessionNameChange?.(sid, name);
        break;
      }
      case "context_usage": {
        // Native push after a turn settles; a one-shot state read may have timed out.
        const sid = sessionIdRef.current;
        const usage = resolveContextUsage(event.contextUsage as AgentStateResponse["contextUsage"]);
        if (sid && event.sessionId === sid && usage) setContextUsage(usage);
        break;
      }
      case "task_snapshot":
        applyTaskSnapshot(event.snapshot as AgentTaskSnapshot);
        break;
      case "agent_start":
        completionRevisionRef.current++;
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          const sid = sessionIdRef.current, run = promptRunIdRef.current, revision = contextRevisionRef.current;
          loadSession(sid);
          fetch(`/api/agent/${encodeURIComponent(sid)}`)
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (sessionIdRef.current !== sid || promptRunIdRef.current !== run || contextRevisionRef.current !== revision) return;
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages, d.state?.queuedItems));
            })
            .catch(() => {});
        }
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) notifyCompletion();
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          const firstNotification = notifyPromptStage(runId);
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        messageRevision.current++;
        if (sessionIdRef.current) historyClientCache.invalidate(sessionIdRef.current);
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "agent_closed":
        // A fail-closed Stop/CLI exit invalidates this SSE attachment. Reusing it
        // for an exact-ID restart would miss the replacement process's events.
        cancelEventStreamGrace();
        closeEvents();
        setNativeSteeringAvailable(false);
        setQueuedMessages({ steering: [], followUp: [] }, true);
        break;
      case "agent_capabilities":
        if (engine === "claude") setNativeSteeringAvailable(event.supportsSteering === true);
        break;
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
          items: event.items as QueuedMessageItem[] | undefined,
          queueEpoch: event.queueEpoch as string | undefined,
          queueRevision: event.queueRevision as number | undefined,
          followUpPaused: event.followUpPaused === true,
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, cancelEventStreamGrace, closeEvents, handleExtensionUiRequest, loadSession, notifyPromptStage, notifyCompletion, scheduleEventStreamClose, settleUiStage, engine, applyTaskSnapshot, onSessionNameChange]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    if (agentRunningRef.current || bashRunningRef.current) return false;
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      return await executeBashRef.current?.(bashCmd, isExcluded) ?? false;
    }

    const promptRunId = promptRunIdRef.current + 1;
    completionRevisionRef.current++;
    messageRevision.current++;
    if (sessionIdRef.current) historyClientCache.invalidate(sessionIdRef.current);
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          promptRequestStarted = true;
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          promoteNewSession(1, message);
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        promptRequestStarted = true;
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (!sentSessionId) throw new Error("Unable to create a session");
      if (mountedRef.current && isSlashCommandPrompt) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
      return true;
    } catch (e) {
      console.error("Failed to send message:", e);
      // A failed prompt POST is ambiguous: the server may have accepted it
      // before the response connection was lost. Keep SSE alive until the
      // server confirms idle so a real run cannot continue unseen.
      if (promptRequestStarted && sentSessionId) {
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
        if (mountedRef.current) void waitForPromptSettlement(sentSessionId, promptRunId);
        return false;
      }
      rpcPromptPendingRef.current = false;
      agentRunningRef.current = false;
      closeEvents();
      if (!(e instanceof EventStreamConnectionError)) addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      if (e instanceof EventStreamConnectionError) {
        const optimisticKey = optimisticUserMessageKeyRef.current;
        if (optimisticKey) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last?.role === "user" && userMessageKey(last) === optimisticKey
              ? prev.slice(0, -1)
              : prev;
          });
        }
        addNotice({ type: "error", message: e.message });
        // The prompt never reached the agent, so restore the user's text into
        // the input instead of losing it. Mirrors the shell-command recovery in
        // executeBash; insertIfEmpty avoids clobbering anything typed since.
        if (mountedRef.current && message) opts.chatInputRef?.current?.insertIfEmpty(message);
      }
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return false;
    } finally {
      // Switching chats detaches the browser, never aborts accepted native work.
      // Startup may have attached SSE after the unmount cleanup already ran.
      if (!mountedRef.current) {
        cancelEventStreamGrace();
        closeEvents();
      }
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, opts.chatInputRef]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return false;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
      return true;
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      if (mountedRef.current) opts.chatInputRef?.current?.insertIfEmpty(inputText);
      return false;
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (mountedRef.current && !cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    const revision = ++contextRevisionRef.current;
    setContextUsage(null);
    setSessionStatsOverride(null);
    const refreshContext = async (sid: string) => {
      if (engine !== "claude") return;
      const state = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
      if (sessionIdRef.current === sid && contextRevisionRef.current === revision) {
        setContextUsage(state?.contextUsage ?? null);
        if (state?.model) {
          const applied = { provider: state.model.provider, modelId: state.model.id };
          setCurrentModelOverride(applied);
          if (isNew) setPendingModel(applied);
        }
        if (state.thinkingLevel !== undefined) setThinkingLevel((state.thinkingLevel ?? "auto") as ThinkingLevelOption);
      }
    };
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      if (engine === "claude") {
        thinkingLevelOverrideRef.current = null;
        setThinkingLevel("auto");
      }
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
        await refreshContext(sid);
      } catch (e) {
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
        if (engine === "claude") await refreshContext(sid).catch(() => {});
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
      await refreshContext(sid);
    } catch (e) {
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [isNew, setNewSessionModel, engine, addNotice]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++modelRequestRef.current;
    const params = new URLSearchParams({ engine, cwd: modelCwd });
    const res = await fetch(`/api/models?${params}`, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    if (signal?.aborted || !mountedRef.current || modelScopeRef.current !== modelScopeKey || modelRequestRef.current !== requestId) return;
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setEffortControlAvailable(d.effortControlAvailable === true);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew && !sessionIdRef.current) {
      const match = d.defaultModel
        ? nextModelList.find((m) => (m.id === d.defaultModel?.modelId || m.resolvedModel === d.defaultModel?.modelId) && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? (supportsExtendedChat(engine) ? nextModelList[0] : undefined);
      setNewSessionDefaultModel(match && d.defaultModel ? d.defaultModel : displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? (newSessionModelOverrideRef.current ? "auto" : (d.defaultThinkingLevel as ThinkingLevelOption | undefined) ?? "auto"));
      }
    }
  }, [engine, isNew, modelCwd, modelScopeKey]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      if (!supportsExtendedChat(engine)) {
        if (commandName === "login" || commandName === "logout") return complete({ handled: true, message: engine === "codex"
          ? "请在终端运行 codex login / codex logout 管理 Codex 登录，不要把登录凭据发到聊天里。"
          : "请在终端运行 claude，使用其官方登录流程；网页不管理或复制登录凭据。" });
        if (engine === "claude") {
          // Native commands win over same-named web shortcuts (/usage, /compact,
          // /help, project skills, etc.). Re-fetch so typed commands need not have
          // appeared in an already-open palette. Sending still uses prompt/SSE.
          const commands = await loadSlashCommands();
          if (commands.some((command) => command.source === "claude" && command.name === commandName)) return { handled: false };
        }
        if (commandName === "help") return complete({ handled: true, message: engine === "claude"
          ? "输入 / 查看本机会话提供的 Claude Code 命令。登录和终端专用操作请在本机 claude 中完成。"
          : `${engineLabel(engine)}: /models, /name, /copy, /new, /clear, /settings, /resume. 暂不支持分支、队列或手动压缩。` });
        if (!["name", "copy", "model", "models", "settings", "resume", "new", "clear", "hotkeys"].includes(commandName)) return complete({ handled: true, error: `/${commandName} is not supported by the ${engineLabel(engine)} web adapter yet` });
      }
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload":
          if (engine === "pi") return complete({ handled: true, error: "Pi RPC does not support reload. Start a new Pi chat after configuration changes." });
          // Route through the normal prompt/SSE path so OMP can ask UI questions.
          return { handled: false };

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session":
        case "usage":
        case "stats": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "model":
        case "models": {
          if (args) {
            const sidToUse = sid ?? await ensureNewSession();
            let provider = "";
            let modelId = args.trim();
            const slashIdx = modelId.indexOf("/");
            if (slashIdx > 0) {
              provider = modelId.slice(0, slashIdx);
              modelId = modelId.slice(slashIdx + 1);
            } else {
              const matched = modelList.find((m) => m.id === modelId || m.name.toLowerCase() === modelId.toLowerCase());
              if (matched) {
                provider = matched.provider;
                modelId = matched.id;
              }
            }
            if (!provider && modelList.length > 0) {
              provider = modelList[0].provider;
            }
            if (sidToUse && provider) {
              const revision = ++contextRevisionRef.current;
              setContextUsage(null);
              setSessionStatsOverride(null);
              await sendAgentCommand(sidToUse, { type: "set_model", provider, modelId });
              setCurrentModelOverride({ provider, modelId });
              if (engine === "claude") {
                const state = await sendAgentCommand<AgentStateResponse>(sidToUse, { type: "get_state" });
                if (sessionIdRef.current === sidToUse && contextRevisionRef.current === revision) setContextUsage(state?.contextUsage ?? null);
              }
              return complete({ handled: true, message: `Switched model to ${provider}/${modelId}` });
            }
          }
          return complete({ handled: true, message: "Use the model selector dropdown below the chat box to change models" });
        }

        case "settings": {
          return complete({ handled: true, message: "Open Models & Settings from the sidebar bottom to configure settings" });
        }

        case "export": {
          if (!sid) return complete({ handled: true, error: "No active session to export" });
          window.open(`/api/sessions/${encodeURIComponent(sid)}/export`, "_blank");
          return complete({ handled: true, message: "Opened session export" });
        }

        case "import":
        case "resume": {
          return complete({ handled: true, message: "Use the sidebar session tree to switch or resume sessions" });
        }

        case "new":
        case "clear": {
          const cwd = session?.cwd ?? newSessionCwd;
          if (!cwd || !onNewSession) return complete({ handled: true, error: "Select a project before starting a new chat" });
          onNewSession(cwd, engine);
          return complete({ handled: true, message: "Started a new session" });
        }

        case "fork":
        case "clone": {
          if (!sid || !activeLeafId) return complete({ handled: true, error: "No active session position to fork" });
          const res = await sendAgentCommand<{ sessionId?: string }>(sid, { type: "fork", includeEntry: true });
          if (res?.sessionId) {
            if (mountedRef.current) onSessionForked?.(res.sessionId);
            return complete({ handled: true, message: `Forked session (${res.sessionId.slice(0, 8)})` });
          }
          return complete({ handled: true, message: "Forked session" });
        }

        case "tree": {
          if (engine === "pi") return complete({ handled: true, error: "Pi RPC does not support history-branch navigation. Use Fork to start a separate branch chat." });
          return complete({ handled: true, message: "Use the branch switcher in the header to navigate session branches" });
        }

        case "login":
        case "logout":
          return complete({ handled: true, message: engine === "omp" ? "Start omp in the embedded terminal and use /login or /logout there. This chat uses OMP credentials." : 'Start the bundled Pi CLI in the terminal with PI_CODING_AGENT_DIR="${OMP_WEB_PI_AGENT_DIR:-$HOME/.pi/agent}", then use /login or /logout. See Pi settings for the full command; do not use the inherited .omp directory.' });

        case "help": {
          addNotice({
            type: "success",
            message: engine === "pi"
              ? "Slash commands available: /usage, /models, /compact, /name, /session, /copy, /export, /fork, /new, /login, /logout"
              : "Slash commands available: /usage, /models, /compact, /reload, /name, /session, /copy, /export, /fork, /tree, /new, /login, /logout",
          });
          return complete({ handled: true, message: "Listed available commands" });
        }

        case "hotkeys": {
          addNotice({
            type: "success",
            message: "Shortcuts: Enter (Send), Shift+Enter (Newline), Esc (Abort/Close), Tab (Autocomplete), / (Commands), @ (Files)",
          });
          return complete({ handled: true, message: "Showed keyboard shortcuts" });
        }

        case "changelog": {
          return complete({ handled: true, message: engine === "omp" ? "This chat uses local OMP RPC. Run omp --version in the terminal for its version." : "This chat uses local Pi RPC. Use the bundled Pi CLI command shown in Pi settings with --version for its version." });
        }

        case "trust":
        case "share":
        case "scoped-models":
        case "quit": {
          return complete({ handled: true, error: `/${commandName} is not implemented by the web controls. Use local ${engine === "pi" ? "Pi (with its separate agent directory)" : "OMP"} in the terminal.` });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [activeLeafId, addNotice, engine, ensureNewSession, isCompacting, loadSession, loadSlashCommands, modelList, newSessionCwd, onNewSession, onSessionForked, onSessionStatsPanelOpen, promoteNewSession, session?.cwd]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await ensureEventsConnected(sid);
      await sendAgentCommand(sid, { type: "steer", message, ...(piImages?.length ? { images: piImages } : {}) });
      return true;
    } catch (e) {
      addNotice({ type: "error", message: `${e instanceof Error ? e.message : String(e)} — 消息未确认，草稿已保留；请先检查队列和聊天记录，勿盲目重复发送。` });
      return false;
    }
  }, [addNotice, ensureEventsConnected]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await ensureEventsConnected(sid);
      await sendAgentCommand(sid, { type: "prompt", message, streamingBehavior: behavior, ...(piImages?.length ? { images: piImages } : {}) });
      return true;
    } catch (e) {
      addNotice({ type: "error", message: `${e instanceof Error ? e.message : String(e)} — 消息未确认，草稿已保留；请先检查队列和聊天记录。` });
      return false;
    }
  }, [addNotice, ensureEventsConnected]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await ensureEventsConnected(sid);
      await sendAgentCommand(sid, { type: "follow_up", message, ...(piImages?.length ? { images: piImages } : {}) });
      return true;
    } catch (e) {
      addNotice({ type: "error", message: `${e instanceof Error ? e.message : String(e)} — 消息未确认，草稿已保留；请先检查队列和聊天记录。` });
      return false;
    }
  }, [addNotice, ensureEventsConnected]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [addNotice]);

  const handleRecallQueuedMessage = useCallback(async (item: QueuedMessageItem) => {
    const sid = sessionIdRef.current;
    if (!sid || recallingQueueRef.current || (!item.id && engine !== "omp")) return;
    recallingQueueRef.current = true; setRecallingQueue(true);
    const restore = (text: string, notice?: string) => {
      if (mountedRef.current && sessionIdRef.current === sid) {
        opts.chatInputRef?.current?.prependText(text, notice);
        if (notice) addNotice({ type: "warning", message: notice });
      } else {
        const draft = getDraft(sid);
        setDraft(sid, { value: text + (draft?.value ? `\n\n${draft.value}` : ""), images: draft?.images ?? [], notice });
      }
    };
    try {
      const command = item.id ? { type: "recall_queued_message", id: item.id, recover: true }
        : { type: "remove_queued_message", queue: item.kind === "steer" ? "steering" : "followUp", message: item.text };
      const reply = await sendAgentCommand<{ removed: boolean; text?: string }>(sid, command);
      if (reply.removed) restore(typeof reply.text === "string" ? reply.text : item.text);
      else restore(item.text, "消息已开始处理或未确认撤回。草稿只是副本，请检查队列/历史，勿直接重复发送。");
      try {
        const state = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
        if (mountedRef.current && sessionIdRef.current === sid) setQueuedMessages(normalizeQueuedMessages(state.queuedMessages, state.queuedItems));
      } catch { /* Confirmed removals are already recovered above. */ }
    } catch {
      restore(item.text, "取回状态未确认，原文已保留为草稿副本；请先检查队列/历史，不要盲目重复发送。");
    } finally { recallingQueueRef.current = false; if (mountedRef.current) setRecallingQueue(false); }
  }, [addNotice, opts.chatInputRef, engine]);

  const handleWithdrawQueuedMessage = useCallback(async (item: { id?: string; kind: "steer" | "follow_up"; text: string }) => {
    const sid = sessionIdRef.current;
    if (!sid || recallingQueueRef.current || (!item.id && engine !== "omp")) return;
    recallingQueueRef.current = true; setRecallingQueue(true);
    try {
      const command = item.id ? { type: "recall_queued_message", id: item.id }
        : { type: "remove_queued_message", queue: item.kind === "steer" ? "steering" : "followUp", message: item.text };
      const reply = await sendAgentCommand<{ removed: boolean }>(sid, command);
      if (mountedRef.current && sessionIdRef.current === sid) addNotice({ type: reply.removed ? "success" : "warning", message: t(reply.removed ? "chat.withdrawn" : "chat.withdrawTooLate") });
      // The native acknowledgement decides success; state refresh failure cannot undo it.
      const run = promptRunIdRef.current;
      try {
        const state = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
        if (mountedRef.current && sessionIdRef.current === sid && run === promptRunIdRef.current) setQueuedMessages(normalizeQueuedMessages(state.queuedMessages, state.queuedItems));
      } catch { /* SSE/reconciliation will repair the queue. */ }
    } catch {
      if (mountedRef.current && sessionIdRef.current === sid) addNotice({ type: "warning", message: t("chat.withdrawUnconfirmed") });
    } finally { recallingQueueRef.current = false; if (mountedRef.current) setRecallingQueue(false); }
  }, [engine, addNotice, t]);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || recallingQueueRef.current) return;
    recallingQueueRef.current = true; setRecallingQueue(true);
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      const text = [...(result?.steering ?? []), ...(result?.followUp ?? [])].join("\n\n");
      // Restore confirmed removals before another network request can fail.
      if (text) {
        if (mountedRef.current && sessionIdRef.current === sid) opts.chatInputRef?.current?.prependText(text);
        else { const old = getDraft(sid); setDraft(sid, { value: text + (old?.value ? `\n\n${old.value}` : ""), images: old?.images ?? [] }); }
      }
      const state = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
      if (mountedRef.current && sessionIdRef.current === sid) setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages, state?.queuedItems));
    } catch {
      if (mountedRef.current) addNotice({ type: "error", message: "Queue recall was not confirmed. Check the native queue before retrying." });
    } finally { recallingQueueRef.current = false; if (mountedRef.current) setRecallingQueue(false); }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    const revision = ++thinkingChangeRevisionRef.current;
    const scope = modelScopeRef.current;
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) {
      if (isNew) {
        thinkingLevelOverrideRef.current = level === "auto" ? null : level;
        setThinkingLevel(level);
      }
      return;
    }
    if (level === "auto" && engine !== "claude") { setThinkingLevel(level); return; }
    try {
      const result = await sendAgentCommand<{ thinkingLevel?: string }>(sid, { type: "set_thinking_level", level });
      if (!mountedRef.current || sessionIdRef.current !== sid || modelScopeRef.current !== scope || thinkingChangeRevisionRef.current !== revision) return;
      const applied = (result?.thinkingLevel ?? level) as ThinkingLevelOption;
      setThinkingLevel(applied);
      if (engine === "claude" && level !== "auto" && applied !== level) addNotice({ type: "warning", message: `Claude applied effort ${applied} (requested ${level}); native model and policy limits take precedence.` });
    } catch (e) {
      if (mountedRef.current && sessionIdRef.current === sid && modelScopeRef.current === scope && thinkingChangeRevisionRef.current === revision) {
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }, [isNew, engine, addNotice]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!agentRunningRef.current) return;
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    completionScrollAllowedRef.current = false;
  }, []);

  // Load session on mount
  useEffect(() => {
    mountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (!mountedRef.current || sessionIdRef.current !== session.id) return;
        applyTaskSnapshot(agentState?.state?.tasks);
        if (hasActiveTasks(agentState?.state?.tasks) || (agentState?.state?.webFollowUpPending ?? 0) > 0) {
          void connectEvents(session.id);
          scheduleEventStreamClose(session.id);
        }
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.supportsSteering !== undefined) setNativeSteeringAvailable(agentState.state.supportsSteering);
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages, agentState.state.queuedItems));
        }
      });
    }
    return () => {
      mountedRef.current = false;
      modelRequestRef.current += 1;
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(engine !== "omp" ? [] : data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [engine, data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && completionScrollAllowedRef.current) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Never carry an explicit model/thinking choice into another engine or cwd.
  useEffect(() => {
    newSessionModelOverrideRef.current = null;
    thinkingLevelOverrideRef.current = null;
    setNewSessionModel(null);
    setNewSessionDefaultModel(null);
    setPendingModel(null);
    setModelNames({});
    setModelList([]);
    setModelError(null);
    setEffortControlAvailable(false);
    thinkingChangeRevisionRef.current++;
    setModelScopeWarnings([]);
    setModelThinkingLevels({});
    setModelThinkingLevelMaps({});
    if (isNew) setThinkingLevel("auto");
    // Session promotion does not change scope and must preserve its live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelScopeKey]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      setModelError(e instanceof Error ? e.message : String(e));
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState, taskSnapshot, taskStatusStale,
    historyPageError,
    historyTurns: historyPage?.turns ?? NO_HISTORY_TURNS, historyTurnStates, toggleHistoryTurn,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, effortControlAvailable, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage: sessionStats?.contextUsage ?? contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    canSendDuringRun: supportsExtendedChat(engine) || (engine === "claude" && nativeSteeringAvailable),
    canQueueFollowUp: true,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue, handleRecallQueuedMessage, handleWithdrawQueuedMessage, recallingQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
