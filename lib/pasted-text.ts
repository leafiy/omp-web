/**
 * Long pastes stay out of the composer, as in the Pi/OMP/Codex TUIs: the textarea
 * holds a short marker and the content is expanded when the message is sent.
 * Outside command mode the expansion is wrapped in <pasted-text>, so every view
 * of the transcript can fold it back into an attachment instead of a wall of text.
 */
export interface PastedText {
  id: number;
  text: string;
}

export type PastedSegment = { type: "text"; text: string } | { type: "paste"; text: string };

/** Same thresholds as the Pi TUI editor: more than 10 lines or more than 1000 characters. */
export const PASTE_MARKER_MIN_LINES = 10;
export const PASTE_MARKER_MIN_CHARS = 1000;

const OPEN_TAG = "<pasted-text>";
const CLOSE_TAG = "</pasted-text>";
const BLOCK_RE = /<pasted-text>\n([\s\S]*?)\n<\/pasted-text>/g;
// Previews may have had their whitespace collapsed or their tail cut off.
const LOOSE_BLOCK_RE = /<pasted-text>\s([\s\S]*?)\s<\/pasted-text>/g;
const DANGLING_BLOCK_RE = /<pasted-text>(?:\s[\s\S]*)?$/;
const TOKEN_RE = /\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]/g;

const tokenCache = new WeakMap<PastedText, string>();

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

/** A paste becomes a marker only when it is long and can round-trip through the wrapper. */
export function shouldCollapsePaste(text: string): boolean {
  if (!text.trim() || text.includes(OPEN_TAG) || text.includes(CLOSE_TAG)) return false;
  return text.length > PASTE_MARKER_MIN_CHARS || countLines(text) > PASTE_MARKER_MIN_LINES;
}

function pasteLabel(text: string): string {
  const lines = countLines(text);
  return lines > PASTE_MARKER_MIN_LINES ? `+${lines} lines` : `${text.length} chars`;
}

export function pastedTextToken(entry: PastedText): string {
  let token = tokenCache.get(entry);
  if (token === undefined) {
    token = `[paste #${entry.id} ${pasteLabel(entry.text)}]`;
    tokenCache.set(entry, token);
  }
  return token;
}

/** First non-empty line, for attachment headers. */
export function pastedTextPreview(text: string, max = 120): string {
  const line = text.split("\n", 50).find((candidate) => candidate.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** `!shell` and `/command` drafts are sent verbatim; a wrapper would become part of the command. */
export function isCommandDraft(value: string): boolean {
  return /^[!/]/.test(value.trimStart());
}

/** Entries whose marker is still present in the draft. */
export function livePastedTexts(value: string, pasted: PastedText[]): PastedText[] {
  return pasted.filter((entry) => value.includes(pastedTextToken(entry)));
}

/** Drop the markers of entries whose content will not be available. */
export function stripPastedTokens(value: string, pasted: PastedText[]): string {
  let result = value;
  for (const entry of pasted) result = result.split(pastedTextToken(entry)).join("");
  return result;
}

export function nextPastedTextId(pasted: PastedText[]): number {
  return pasted.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

/** Replace markers with their content. Unknown marker-like text is left as typed. */
export function expandPastedTokens(value: string, pasted: PastedText[]): string {
  const live = livePastedTexts(value, pasted);
  if (!live.length) return value;
  const raw = isCommandDraft(value);
  const byToken = new Map(live.map((entry) => [pastedTextToken(entry), entry.text]));
  return value.replace(TOKEN_RE, (token) => {
    const text = byToken.get(token);
    if (text === undefined) return token;
    return raw ? text : `${OPEN_TAG}\n${text}\n${CLOSE_TAG}`;
  });
}

/** Inverse of expansion, for text returning to the composer (edit, history, queue recall). */
export function collapsePastedBlocks(text: string, existing: PastedText[] = []): { value: string; pastedTexts: PastedText[] } {
  if (!text.includes(OPEN_TAG)) return { value: text, pastedTexts: existing };
  let id = nextPastedTextId(existing) - 1;
  const pastedTexts = [...existing];
  const value = text.replace(BLOCK_RE, (_match, body: string) => {
    const entry = { id: ++id, text: body };
    pastedTexts.push(entry);
    return pastedTextToken(entry);
  });
  return { value, pastedTexts };
}

export function splitPastedBlocks(text: string): PastedSegment[] {
  if (!text.includes(OPEN_TAG)) return [{ type: "text", text }];
  const segments: PastedSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(BLOCK_RE)) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ type: "text", text: text.slice(last, at) });
    segments.push({ type: "paste", text: match[1] });
    last = at + match[0].length;
  }
  if (last < text.length || !segments.length) segments.push({ type: "text", text: text.slice(last) });
  return segments;
}

/** Composer text around `[paste #n …]` markers, so whole-draft rewrites (translation) keep markers atomic. */
export function splitPastedTokens(value: string): Array<{ token: boolean; text: string }> {
  const parts: Array<{ token: boolean; text: string }> = [];
  let last = 0;
  for (const match of value.matchAll(TOKEN_RE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ token: false, text: value.slice(last, at) });
    parts.push({ token: true, text: match[0] });
    last = at + match[0].length;
  }
  if (last < value.length) parts.push({ token: false, text: value.slice(last) });
  return parts;
}

/** One-line contexts (outline rows, minimap, queue, titles) show the marker, not the content. */
export function summarizePastedBlocks(text: string): string {
  if (!text.includes(OPEN_TAG)) return text;
  let index = 0;
  return text
    .replace(LOOSE_BLOCK_RE, (_match, body: string) => `[paste #${++index} ${pasteLabel(body)}]`)
    .replace(DANGLING_BLOCK_RE, () => `[paste #${++index}]`);
}

/** The message as the user wrote it, without the transport wrapper (copy to clipboard). */
export function unwrapPastedBlocks(text: string): string {
  return text.includes(OPEN_TAG) ? text.replace(BLOCK_RE, (_match, body: string) => body) : text;
}

interface TokenRange {
  start: number;
  end: number;
}

function tokenRanges(value: string, pasted: PastedText[]): TokenRange[] {
  const ranges: TokenRange[] = [];
  for (const entry of pasted) {
    const token = pastedTextToken(entry);
    for (let at = value.indexOf(token); at !== -1; at = value.indexOf(token, at + token.length)) {
      ranges.push({ start: at, end: at + token.length });
    }
  }
  return ranges;
}

/**
 * Markers are atomic: an edit that removes or splits part of one removes all of it,
 * so a half-deleted marker can never be sent as literal text with its content lost.
 * Returns null when the edit touched no marker.
 *
 * `caret` is the caret after the edit. It sits right behind the change, and anchoring
 * the diff there keeps a repeated character beside a marker (typing "[" in front of
 * one) from being read as an edit inside it.
 */
export function repairPastedTokenEdit(prev: string, next: string, pasted: PastedText[], caret?: number): { value: string; caret: number } | null {
  if (!pasted.length || prev === next) return null;
  const max = Math.min(prev.length, next.length);
  const anchored = caret === undefined ? -1 : next.length - caret;
  let suffix = 0;
  if (anchored >= 0 && anchored <= max && prev.endsWith(next.slice(next.length - anchored))) suffix = anchored;
  else while (suffix < max && prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
  let prefix = 0;
  while (prefix < max - suffix && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  // prev[start, end) was replaced by next[prefix, next.length - suffix).
  let start = prefix;
  let end = prev.length - suffix;
  let touched = false;
  for (const range of tokenRanges(prev, pasted)) {
    const hit = start === end
      ? range.start < start && start < range.end
      : range.start < end && range.end > start;
    if (!hit || (range.start >= start && range.end <= end)) continue;
    touched = true;
    start = Math.min(start, range.start);
    end = Math.max(end, range.end);
  }
  if (!touched) return null;
  const inserted = next.slice(prefix, next.length - suffix);
  return { value: prev.slice(0, start) + inserted + prev.slice(end), caret: start + inserted.length };
}

/** Keep a collapsed caret out of a marker: arrow keys step over it, clicks land on the nearer edge. */
export function snapCaretOutOfToken(value: string, caret: number, previousCaret: number | null, pasted: PastedText[]): number {
  for (const { start, end } of tokenRanges(value, pasted)) {
    if (caret <= start || caret >= end) continue;
    if (previousCaret === end && caret === end - 1) return start;
    if (previousCaret === start && caret === start + 1) return end;
    return caret - start < end - caret ? start : end;
  }
  return caret;
}
