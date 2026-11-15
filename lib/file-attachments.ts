/** Web file cards use ordinary prompt text at the native-engine seam, not a fake image/document block. */
export interface AttachedFile {
  name: string;
  path: string;
  size: number;
}

export type FileAttachmentSegment = { type: "text"; text: string } | { type: "file"; file: AttachedFile };
const BLOCK_RE = /<file-attachment>\s+(\{[^\r\n]*?\})\s+<\/file-attachment>/g;

export function isAttachedFile(value: unknown): value is AttachedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<AttachedFile>;
  return typeof file.name === "string" && !!file.name && !/[/\\]/.test(file.name) && !file.name.includes("\0")
    && typeof file.path === "string" && /^(?:\/|[a-zA-Z]:[\\/])/.test(file.path) && !file.path.includes("\0")
    && typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0;
}

export function fileAttachmentBlock(file: AttachedFile): string {
  // Keep tag-like filenames from terminating the block; JSON decoding restores them exactly.
  const metadata = JSON.stringify({ name: file.name, path: file.path, size: file.size }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<file-attachment>\n${metadata}\n</file-attachment>`;
}

/** Prepend metadata so !shell or /command text with a file cannot execute as a command. */
export function appendFileAttachments(text: string, files: AttachedFile[]): string {
  if (!files.length) return text;
  return [...files.map(fileAttachmentBlock), text].filter(Boolean).join("\n\n");
}

export function splitFileAttachments(text: string): FileAttachmentSegment[] {
  const segments: FileAttachmentSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(BLOCK_RE)) {
    let file: unknown;
    try { file = JSON.parse(match[1]); } catch { continue; }
    if (!isAttachedFile(file)) continue;
    const at = match.index!;
    if (at > last) segments.push({ type: "text", text: text.slice(last, at) });
    segments.push({ type: "file", file: { name: file.name, path: file.path, size: file.size } });
    last = at + match[0].length;
  }
  if (last < text.length || !segments.length) segments.push({ type: "text", text: text.slice(last) });
  return segments;
}
