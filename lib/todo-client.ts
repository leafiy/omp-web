import { startVisiblePolling } from "./visible-polling";
import { historyUrl } from "./history-client-cache";
import { isTurnAnchor } from "./history-turns";
import { summarizeUserMessage } from "./user-message-content";
import type { AgentMessage, TextContent } from "./types";
import { applyTodoMutation, normalizeTodoText, type TodoItem, type TodoMutation, type TodoSnapshot, type TodoSource, type TodoSourceRole } from "./todo-types";

/**
 * One browser-wide copy of the server todo list shared by the top-bar card,
 * sidebar menus and message buttons. Server snapshots are authoritative; local
 * mutations are shown optimistically and replayed over each newer snapshot
 * until the server confirms them.
 */
export interface TodoClientState {
  /** Null until the first snapshot arrives. */
  snapshot: TodoSnapshot | null;
  /** The last save or load failed; cleared by the next success. */
  error: "load" | "save" | "limit" | null;
}

const POLL_MS = 20_000;
let base: TodoSnapshot | null = null;
let state: TodoClientState = { snapshot: null, error: null };
const listeners = new Set<() => void>();
const pending = new Map<number, TodoMutation>();
let pendingSeq = 0;
let stopPolling: (() => void) | null = null;

function emit() {
  for (const listener of [...listeners]) listener();
}

function publish(error: TodoClientState["error"] = state.error) {
  let snapshot = base;
  if (snapshot && pending.size) {
    let items = snapshot.items;
    const now = Date.now();
    for (const mutation of pending.values()) {
      try { items = applyTodoMutation(items, mutation, now); } catch { /* the server will reject it */ }
    }
    snapshot = { revision: snapshot.revision, items };
  }
  state = { snapshot, error };
  emit();
}

/** Older poll/list responses must not undo a newer mutation response. */
function applySnapshot(next: TodoSnapshot | undefined, force = false) {
  if (!next || !Array.isArray(next.items)) return;
  if (!force && base && next.revision <= base.revision) return;
  base = next;
  publish();
}

async function fetchTodos(signal?: AbortSignal, force = false) {
  const response = await fetch("/api/todos", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { todos?: TodoSnapshot };
  if (signal?.aborted) return;
  applySnapshot(data.todos, force);
  if (state.error === "load") publish(null);
}

export function subscribeTodos(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopPolling && typeof window !== "undefined") {
    stopPolling = startVisiblePolling(async (signal) => {
      try { await fetchTodos(signal); }
      catch (error) {
        if (!signal.aborted && !base) publish("load");
        throw error;
      }
    }, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stopPolling) { stopPolling(); stopPolling = null; }
  };
}

export function getTodoState(): TodoClientState {
  return state;
}

export function dismissTodoError() {
  if (state.error && state.error !== "load") publish(null);
}

const SERVER_STATE: TodoClientState = { snapshot: null, error: null };
export function getServerTodoState(): TodoClientState {
  return SERVER_STATE;
}

export function newTodoId(): string {
  // randomUUID is missing outside secure contexts (plain-HTTP LAN access).
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null;
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function mutate(mutation: TodoMutation): Promise<boolean> {
  const seq = ++pendingSeq;
  pending.set(seq, mutation);
  publish();
  try {
    const response = await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mutation),
    });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const data = await response.json() as { todos?: TodoSnapshot };
    pending.delete(seq);
    applySnapshot(data.todos);
    publish(null);
    return true;
  } catch (error) {
    pending.delete(seq);
    publish((error as { status?: number }).status === 409 ? "limit" : "save");
    // Drop the optimistic change and show what the server actually has.
    try { await fetchTodos(undefined, true); } catch { /* keep the last snapshot */ }
    return false;
  }
}

export function addTodo(text: string, source?: TodoSource, id = newTodoId()): Promise<boolean> {
  const value = normalizeTodoText(text);
  if (!value) return Promise.resolve(false);
  return mutate(source ? { op: "add", id, text: value, source } : { op: "add", id, text: value });
}

export function setTodoDone(id: string, done: boolean): Promise<boolean> {
  return mutate({ op: "update", id, done });
}

export function setTodoText(id: string, text: string): Promise<boolean> {
  const value = normalizeTodoText(text);
  if (!value) return Promise.resolve(false);
  return mutate({ op: "update", id, text: value });
}

export function deleteTodo(id: string): Promise<boolean> {
  return mutate({ op: "delete", id });
}

export function clearDoneTodos(): Promise<boolean> {
  return mutate({ op: "clearDone" });
}

/** A whole-conversation item; message items always carry a role. */
export function findSessionTodo(items: TodoItem[], sessionId: string): TodoItem | undefined {
  return items.find((item) => item.source?.sessionId === sessionId && !item.source.entryId && !item.source.role);
}

export function findMessageTodo(items: TodoItem[], sessionId: string, entryId: string): TodoItem | undefined {
  return items.find((item) => item.source?.sessionId === sessionId && item.source.entryId === entryId);
}

function displayText(message: AgentMessage): string | null {
  if (message.role === "user") {
    const content = message.content;
    return summarizeUserMessage(typeof content === "string"
      ? content
      : content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n"));
  }
  if (message.role === "assistant") {
    return (message.content ?? []).filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
  }
  return null;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Entry IDs reach the browser only with a history load, so a message sent or
 * produced during the current run has none yet. Find it in the persisted
 * latest window by role and display text (newest match first). Null when it
 * has not been written yet or cannot be told apart.
 */
export async function resolveMessageLink(sessionId: string, role: TodoSourceRole, text: string): Promise<{ entryId: string; turnId: string } | null> {
  const wanted = squash(text);
  if (!wanted) return null;
  const response = await fetch(historyUrl(sessionId), { cache: "no-store" });
  if (!response.ok) return null;
  const data = await response.json() as { sessionId?: string; context?: { messages?: AgentMessage[]; entryIds?: string[] } };
  const messages = data.context?.messages, entryIds = data.context?.entryIds;
  if (data.sessionId !== sessionId || !Array.isArray(messages) || !Array.isArray(entryIds) || messages.length !== entryIds.length) return null;
  const candidates = messages.map((message) => message.role === role ? squash(displayText(message) ?? "") : "");
  let index = candidates.lastIndexOf(wanted);
  // The engine may store a lightly different copy (for example added notes).
  if (index < 0) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i] && (candidates[i].includes(wanted) || wanted.includes(candidates[i]))) { index = i; break; }
    }
  }
  if (index < 0 || !entryIds[index]) return null;
  // The window starts at a turn boundary, so its first entry anchors a preamble.
  let anchor = 0;
  for (let i = index; i >= 0; i--) {
    if (isTurnAnchor(messages[i])) { anchor = i; break; }
  }
  return { entryId: entryIds[index], turnId: entryIds[anchor] };
}

/** A one-line excerpt used as the default text of a message todo. */
export function todoExcerpt(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${normalizeTodoText(line, max - 1)}…` : line;
}

// ── Jump requests ───────────────────────────────────────────────────────────
// The card asks to show a linked conversation/message; the chat window for
// that session resolves it once its history is loaded.

export interface TodoJumpRequest {
  nonce: number;
  sessionId: string;
  entryId?: string;
  turnId?: string;
}

export type TodoJumpNotice = { nonce: number; kind: "messageNotFound" | "sessionNotFound" };

const JUMP_TIMEOUT_MS = 20_000;
let jumpRequest: TodoJumpRequest | null = null;
let jumpNotice: TodoJumpNotice | null = null;
let jumpNonce = 0;
let jumpTimer: ReturnType<typeof setTimeout> | null = null;
const jumpListeners = new Set<() => void>();

function emitJump() {
  for (const listener of [...jumpListeners]) listener();
}

export function subscribeTodoJump(listener: () => void): () => void {
  jumpListeners.add(listener);
  return () => { jumpListeners.delete(listener); };
}

export function getTodoJumpRequest(): TodoJumpRequest | null {
  return jumpRequest;
}

export function getTodoJumpNotice(): TodoJumpNotice | null {
  return jumpNotice;
}

export function getServerTodoJump(): null {
  return null;
}

export function requestTodoJump(source: TodoSource): TodoJumpRequest {
  const request: TodoJumpRequest = { nonce: ++jumpNonce, sessionId: source.sessionId };
  if (source.entryId) request.entryId = source.entryId;
  if (source.turnId) request.turnId = source.turnId;
  jumpRequest = request;
  jumpNotice = null;
  if (jumpTimer) clearTimeout(jumpTimer);
  // A request that never resolves must not move a later, unrelated chat.
  jumpTimer = setTimeout(() => finishTodoJump(request.nonce), JUMP_TIMEOUT_MS);
  emitJump();
  return request;
}

export function finishTodoJump(nonce: number, notice?: TodoJumpNotice["kind"]) {
  if (jumpRequest?.nonce !== nonce) return;
  jumpRequest = null;
  if (jumpTimer) { clearTimeout(jumpTimer); jumpTimer = null; }
  jumpNotice = notice ? { nonce, kind: notice } : null;
  emitJump();
}

export function dismissTodoJumpNotice() {
  if (!jumpNotice) return;
  jumpNotice = null;
  emitJump();
}
