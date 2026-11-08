import type { ExtensionUiRequest } from "./types";

type InputDialog = Extract<ExtensionUiRequest, { method: "input" }>;

/**
 * Display-only fields for a native question (Claude Code AskUserQuestion,
 * Codex requestUserInput). Keeps the question text out of the option list so
 * the dialog can lay them out separately; the answer itself stays free text.
 */
export function questionDisplay(raw: { header?: unknown; options?: unknown }): Pick<InputDialog, "header" | "choices"> {
  const header = typeof raw.header === "string" ? raw.header.trim() : "";
  const choices = Array.isArray(raw.options) ? raw.options.flatMap((option: unknown) => {
    if (!option || typeof option !== "object") return [];
    const { label, description } = option as { label?: unknown; description?: unknown };
    const name = typeof label === "string" ? label.trim() : "";
    const detail = typeof description === "string" ? description.trim() : "";
    return name || detail ? [{ label: name, ...(detail ? { description: detail } : {}) }] : [];
  }) : [];
  return { ...(header ? { header } : {}), ...(choices.length ? { choices } : {}) };
}
