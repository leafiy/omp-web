import { splitFileAttachments, type AttachedFile, type FileAttachmentSegment } from "./file-attachments";
import { splitPastedBlocks, summarizePastedBlocks, type PastedSegment } from "./pasted-text";

export type UserMessageSegment = PastedSegment | FileAttachmentSegment;

/** Pasted documents are opaque: attachment-like text inside one stays part of the paste. */
export function splitUserMessage(text: string): UserMessageSegment[] {
  return splitPastedBlocks(text).flatMap((part): UserMessageSegment[] => part.type === "paste" ? [part] : splitFileAttachments(part.text));
}

/** Editing/history/queue recall restore file cards, not their transport metadata in the textarea. */
export function extractMessageFiles(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = [];
  const body = splitUserMessage(text).map((part) => {
    if (part.type === "file") { files.push(part.file); return ""; }
    return part.type === "paste" ? `<pasted-text>\n${part.text}\n</pasted-text>` : part.text;
  }).join("");
  return { text: files.length ? body.trim() : body, files };
}

/** All compact user-text surfaces show a filename, never the stored path/metadata. */
export function summarizeUserMessage(text: string): string {
  return splitFileAttachments(summarizePastedBlocks(text)).map((part) => part.type === "file" ? `[${part.file.name}]` : part.text).join("");
}

export function copyUserMessage(text: string): string {
  return splitUserMessage(text).map((part) => part.type === "file" ? `${part.file.name} (${part.file.path})` : part.text).join("");
}
