/**
 * Display-only fallbacks for Claude Code file tools whose stored result has no
 * native diff (older web projections). Headerless +/- lines: no line numbers
 * are claimed because the input does not carry them.
 */
const MAX_LINES = 400;

function lines(prefix: "+" | "-", text: string): string[] {
  const body = text.replace(/\n$/, "").split("\n");
  const shown = body.slice(0, MAX_LINES).map((line) => `${prefix}${line}`);
  return body.length > MAX_LINES ? [...shown, `… ${body.length - MAX_LINES} more lines`] : shown;
}

const CLAUDE_FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
export function isClaudeFileTool(toolName: string): boolean { return CLAUDE_FILE_TOOLS.has(toolName); }

export function claudeInputDiff(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input || !isClaudeFileTool(toolName)) return null;
  if (toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return [...lines("-", input.old_string), ...lines("+", input.new_string)].join("\n");
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const edits = input.edits.filter((edit): edit is { old_string: string; new_string: string } => Boolean(edit)
      && typeof (edit as Record<string, unknown>).old_string === "string" && typeof (edit as Record<string, unknown>).new_string === "string");
    if (!edits.length) return null;
    return edits.flatMap((edit, index) => [`@@ edit ${index + 1}/${edits.length} @@`, ...lines("-", edit.old_string), ...lines("+", edit.new_string)]).join("\n");
  }
  if (toolName === "Write" && typeof input.content === "string") return lines("+", input.content).join("\n");
  if (toolName === "NotebookEdit" && typeof input.new_source === "string" && input.edit_mode !== "delete") return lines("+", input.new_source).join("\n");
  return null;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned";
  activeForm?: string;
}

/** Claude Code's TodoWrite list, or null when the input is not one. */
export function todoItems(toolName: string, input: Record<string, unknown> | undefined): TodoItem[] | null {
  if (toolName !== "TodoWrite" || !input || !Array.isArray(input.todos)) return null;
  const items = input.todos.flatMap((raw): TodoItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const todo = raw as Record<string, unknown>;
    if (typeof todo.content !== "string") return [];
    const status = todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending";
    return [{ content: todo.content, status, ...(typeof todo.activeForm === "string" ? { activeForm: todo.activeForm } : {}) }];
  });
  return items.length ? items : null;
}

export interface TodoGroup {
  /** OMP phase name; Claude Code's TodoWrite has one unnamed list. */
  name?: string;
  items: TodoItem[];
}

/**
 * The todo list a tool call shows: Claude Code's TodoWrite input, or the
 * snapshot OMP's `todo` tool returns in its result details (`phases`).
 */
export function todoGroups(toolName: string, input: Record<string, unknown> | undefined, details?: unknown): TodoGroup[] | null {
  const claude = todoItems(toolName, input);
  if (claude) return [{ items: claude }];
  if (toolName !== "todo" || !details || typeof details !== "object") return null;
  const phases = (details as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) return null;
  const groups = phases.flatMap((raw): TodoGroup[] => {
    if (!raw || typeof raw !== "object") return [];
    const phase = raw as { name?: unknown; tasks?: unknown };
    const items = Array.isArray(phase.tasks) ? phase.tasks.flatMap((task): TodoItem[] => {
      if (!task || typeof task !== "object" || typeof (task as { content?: unknown }).content !== "string") return [];
      const status = (task as { status?: unknown }).status;
      return [{ content: (task as { content: string }).content, status: status === "completed" || status === "in_progress" || status === "abandoned" ? status : "pending" }];
    }) : [];
    return items.length ? [{ ...(typeof phase.name === "string" && phase.name ? { name: phase.name } : {}), items }] : [];
  });
  return groups.length ? groups : null;
}
