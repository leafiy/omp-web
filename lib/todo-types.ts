/**
 * Web-owned todo list shared by every device signed in to this server.
 * Items may point back at a conversation or one of its messages; those links
 * are display/navigation hints only and never touch native transcripts.
 */

export const TODO_TEXT_MAX = 2000;
export const TODO_TITLE_MAX = 300;
export const TODO_ITEMS_MAX = 1000;
const TODO_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type TodoSourceRole = "user" | "assistant";

export interface TodoSource {
  /** Engine-qualified web session ID (`lib/engine.ts`). */
  sessionId: string;
  /** Conversation title when the item was added; display only. */
  sessionTitle?: string;
  /** Native entry ID of one message; absent for a whole-conversation item. */
  entryId?: string;
  /** Entry ID that starts the history turn holding `entryId`, so a folded turn can be opened. */
  turnId?: string;
  role?: TodoSourceRole;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  source?: TodoSource;
}

export interface TodoSnapshot {
  revision: number;
  /** Insertion order; views sort for display. */
  items: TodoItem[];
}

export type TodoMutation =
  | { op: "add"; id: string; text: string; source?: TodoSource }
  | { op: "update"; id: string; text?: string; done?: boolean }
  | { op: "delete"; id: string }
  | { op: "clearDone" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isTodoId(value: unknown): value is string {
  return typeof value === "string" && TODO_ID.test(value);
}

function isRef(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Trim and bound user text without splitting a UTF-16 surrogate pair. */
export function normalizeTodoText(value: string, max = TODO_TEXT_MAX): string {
  let text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length > max) {
    let end = max;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    text = text.slice(0, end).trimEnd();
  }
  return text;
}

export function parseTodoSource(value: unknown): TodoSource | null {
  if (!isRecord(value) || !isRef(value.sessionId)) return null;
  const source: TodoSource = { sessionId: value.sessionId };
  if (value.sessionTitle !== undefined) {
    if (typeof value.sessionTitle !== "string") return null;
    const title = normalizeTodoText(value.sessionTitle, TODO_TITLE_MAX).replace(/\s+/g, " ");
    if (title) source.sessionTitle = title;
  }
  if (value.entryId !== undefined) {
    if (!isRef(value.entryId)) return null;
    source.entryId = value.entryId;
  }
  if (value.turnId !== undefined) {
    if (!isRef(value.turnId) || source.entryId === undefined) return null;
    source.turnId = value.turnId;
  }
  if (value.role !== undefined) {
    if (value.role !== "user" && value.role !== "assistant") return null;
    source.role = value.role;
  }
  return source;
}

/** Strict parse of one stored item; a malformed file must not be overwritten silently. */
export function parseTodoItem(value: unknown): TodoItem | null {
  if (!isRecord(value) || !isTodoId(value.id) || typeof value.text !== "string" || typeof value.done !== "boolean"
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  const text = normalizeTodoText(value.text);
  if (!text) return null;
  const item: TodoItem = { id: value.id, text, done: value.done, createdAt: value.createdAt, updatedAt: value.updatedAt };
  if (value.doneAt !== undefined) {
    if (!isTimestamp(value.doneAt)) return null;
    if (item.done) item.doneAt = value.doneAt;
  }
  if (value.source !== undefined) {
    const source = parseTodoSource(value.source);
    if (!source) return null;
    item.source = source;
  }
  return item;
}

export function parseTodoMutation(value: unknown): TodoMutation | null {
  if (!isRecord(value)) return null;
  switch (value.op) {
    case "add": {
      if (!isTodoId(value.id) || typeof value.text !== "string") return null;
      const text = normalizeTodoText(value.text);
      if (!text) return null;
      if (value.source === undefined) return { op: "add", id: value.id, text };
      const source = parseTodoSource(value.source);
      return source ? { op: "add", id: value.id, text, source } : null;
    }
    case "update": {
      if (!isTodoId(value.id) || (value.text === undefined && value.done === undefined)) return null;
      const mutation: Extract<TodoMutation, { op: "update" }> = { op: "update", id: value.id };
      if (value.text !== undefined) {
        if (typeof value.text !== "string") return null;
        const text = normalizeTodoText(value.text);
        if (!text) return null;
        mutation.text = text;
      }
      if (value.done !== undefined) {
        if (typeof value.done !== "boolean") return null;
        mutation.done = value.done;
      }
      return mutation;
    }
    case "delete":
      return isTodoId(value.id) ? { op: "delete", id: value.id } : null;
    case "clearDone":
      return { op: "clearDone" };
    default:
      return null;
  }
}

export class TodoLimitError extends Error {
  constructor() {
    super(`The todo list is limited to ${TODO_ITEMS_MAX} items`);
    this.name = "TodoLimitError";
  }
}

/**
 * Apply one explicit intent (never a stale device's whole list). Returns the
 * same array when nothing changes, so callers can skip a write. Re-applying a
 * mutation is harmless: an existing ID is not added twice.
 */
export function applyTodoMutation(items: TodoItem[], mutation: TodoMutation, now: number): TodoItem[] {
  switch (mutation.op) {
    case "add": {
      if (items.some((item) => item.id === mutation.id)) return items;
      if (items.length >= TODO_ITEMS_MAX) throw new TodoLimitError();
      const item: TodoItem = { id: mutation.id, text: mutation.text, done: false, createdAt: now, updatedAt: now };
      if (mutation.source) item.source = { ...mutation.source };
      return [...items, item];
    }
    case "update": {
      const index = items.findIndex((item) => item.id === mutation.id);
      if (index < 0) return items;
      const current = items[index];
      const text = mutation.text ?? current.text;
      const done = mutation.done ?? current.done;
      if (text === current.text && done === current.done) return items;
      const next: TodoItem = { ...current, text, done, updatedAt: now };
      if (done && !current.done) next.doneAt = now;
      if (!done) delete next.doneAt;
      const copy = [...items];
      copy[index] = next;
      return copy;
    }
    case "delete": {
      const next = items.filter((item) => item.id !== mutation.id);
      return next.length === items.length ? items : next;
    }
    case "clearDone": {
      const next = items.filter((item) => !item.done);
      return next.length === items.length ? items : next;
    }
  }
}

/**
 * Open items in the order they were added (the stored order), so "item 2"
 * means the same thing in the card, the agent copy and `todos.md`; completed
 * items most recently finished first. Open item N is `open[N - 1]`.
 */
export function sortTodosForDisplay(items: TodoItem[]): { open: TodoItem[]; done: TodoItem[] } {
  const open = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done).sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt));
  return { open, done };
}
