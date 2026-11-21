import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { applyTodoMutation, parseTodoItem, TODO_ITEMS_MAX, type TodoItem, type TodoMutation, type TodoSnapshot } from "./todo-types";

function copyItem(item: TodoItem): TodoItem {
  return item.source ? { ...item, source: { ...item.source } } : { ...item };
}

/** Web-owned todo list shared by all devices; never stored in an agent directory. */
export class TodoState {
  private state: TodoSnapshot;

  constructor(private readonly path: string) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.items) || value.items.length > TODO_ITEMS_MAX) {
        throw new Error("Invalid todo state");
      }
      const parsed: (TodoItem | null)[] = value.items.map((item: unknown) => parseTodoItem(item));
      const items = parsed.filter((item): item is TodoItem => item !== null);
      if (items.length !== parsed.length || new Set(items.map((item) => item.id)).size !== items.length) {
        throw new Error("Invalid todo state");
      }
      this.state = { revision: value.revision, items };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { revision: 0, items: [] };
    }
  }

  snapshot(): TodoSnapshot {
    return { revision: this.state.revision, items: this.state.items.map(copyItem) };
  }

  apply(mutation: TodoMutation, now = Date.now()): TodoSnapshot {
    const items = applyTodoMutation(this.state.items, mutation, now);
    if (items === this.state.items) return this.snapshot();
    const next: TodoSnapshot = { revision: this.state.revision + 1, items };
    // Synchronous read/modify/commit on the shared instance serializes requests.
    // A failed write leaves both the published snapshot and the old file intact.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(this.path, JSON.stringify(next) + "\n");
    this.state = next;
    return this.snapshot();
  }
}

declare global {
  var __ompWebTodoState: TodoState | undefined;
}

export function todoStatePath(): string {
  const path = process.env.OMP_WEB_TODO_FILE?.trim() || join(homedir(), ".config", "omp-web", "todos.json");
  if (!isAbsolute(path)) throw new Error("OMP_WEB_TODO_FILE must be an absolute path");
  return path;
}

export function todoState(): TodoState {
  return globalThis.__ompWebTodoState ??= new TodoState(todoStatePath());
}
