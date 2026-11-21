import { splitFileAttachments, type AttachedFile, type FileAttachmentSegment } from "./file-attachments";
import { splitPastedBlocks, summarizePastedBlocks, type PastedSegment } from "./pasted-text";
import { splitTodoListBlock } from "./todo-attachment";

export type TodoListSegment = { type: "todo"; text: string };
export type UserMessageSegment = PastedSegment | FileAttachmentSegment | TodoListSegment;

/** Pasted documents are opaque: attachment-like text inside one stays part of the paste. */
export function splitUserMessage(text: string): UserMessageSegment[] {
  const { text: body, todo } = splitTodoListBlock(text);
  const segments: UserMessageSegment[] = splitPastedBlocks(body).flatMap((part): UserMessageSegment[] => part.type === "paste" ? [part] : splitFileAttachments(part.text));
  if (todo !== null) segments.push({ type: "todo", text: todo });
  return segments;
}

/** Editing/history/queue recall restore file cards, not their transport metadata in the textarea. */
export function extractMessageFiles(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = [];
  // An attached todo list is a snapshot of that moment; a resend attaches the current one.
  const body = splitUserMessage(text).map((part) => {
    if (part.type === "file") { files.push(part.file); return ""; }
    if (part.type === "todo") return "";
    return part.type === "paste" ? `<pasted-text>\n${part.text}\n</pasted-text>` : part.text;
  }).join("");
  return { text: files.length ? body.trim() : body, files };
}

/** All compact user-text surfaces show a filename, never the stored path/metadata. */
export function summarizeUserMessage(text: string): string {
  const { text: body, todo } = splitTodoListBlock(text);
  const summary = splitFileAttachments(summarizePastedBlocks(body)).map((part) => part.type === "file" ? `[${part.file.name}]` : part.text).join("");
  return todo === null ? summary : `${summary} [todo list]`;
}

export function copyUserMessage(text: string): string {
  return splitUserMessage(text).map((part) => part.type === "file" ? `${part.file.name} (${part.file.path})` : part.type === "todo" ? "" : part.text).join("");
}
