/**
 * Pure helpers for the optional ZH⇄EN translation feature. Shared by the
 * browser (direction labels) and the server route (prompting and chunking).
 */

export type TranslateDirection = "zh2en" | "en2zh";
export const TRANSLATE_DIRECTIONS: readonly TranslateDirection[] = ["zh2en", "en2zh"];
export const DEFAULT_TRANSLATE_MODEL = "index-translate:2b";
/** Prose sent per request. Index-Translate-2B has an 8K window per slot. */
export const MAX_TRANSLATE_CHUNK_CHARS = 1500;

export function isTranslateDirection(value: unknown): value is TranslateDirection {
  return value === "zh2en" || value === "en2zh";
}

/**
 * Index-Translate's training template, used verbatim as a single user
 * message (no system message, greedy decoding). A known source language is
 * named as "以下{源语言}文本". Ordinary chat models follow it as well.
 */
export function translationPrompt(direction: TranslateDirection, text: string): string {
  const [source, target] = direction === "zh2en" ? ["中文", "英语"] : ["英语", "中文"];
  return `请将以下${source}文本翻译为${target}，直接输出翻译结果，不要进行任何解释。\n\n${text}`;
}

/** Tencent Hunyuan-MT models such as anna's `hy-mt2-1.8b`. */
export function isHunyuanMtModel(model: string): boolean {
  return /^hy-?mt/i.test(model.trim());
}

/**
 * The chat-completions body for one chunk. Hunyuan-MT gets its model-card
 * ZH⇄XX template (as anna's hy-mt2 caller sends it) and the server's
 * recommended sampling; everything else gets the Index-Translate template,
 * greedy.
 */
export function translationRequestBody(direction: TranslateDirection, text: string, model: string): Record<string, unknown> {
  if (isHunyuanMtModel(model)) {
    const target = direction === "zh2en" ? "英语" : "中文";
    return {
      model,
      messages: [{ role: "user", content: `将以下文本翻译为${target}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}` }],
      stream: false,
    };
  }
  return { model, messages: [{ role: "user", content: translationPrompt(direction, text) }], temperature: 0, stream: false };
}

/**
 * The chat-completions URL for a configured API address. A full
 * `…/chat/completions` URL is used as-is, an OpenAI-style base such as
 * `http://host:9940/v1` gets `/chat/completions`, and a bare origin gets
 * `/v1/chat/completions`. Returns null for unusable addresses.
 */
export function chatCompletionsUrl(endpoint: string): string | null {
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) url.pathname = "/v1/chat/completions";
  else if (!/\/chat\/completions$/.test(path)) url.pathname = `${path}/chat/completions`;
  else url.pathname = path;
  return url.toString();
}

export type TranslatableSegment = { translate: boolean; text: string };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/;

/** Fenced code stays verbatim; everything else is prose. The parts concatenate to the input. */
export function splitCodeFences(text: string): TranslatableSegment[] {
  const segments: TranslatableSegment[] = [];
  const push = (translate: boolean, part: string) => {
    const last = segments[segments.length - 1];
    if (last && last.translate === translate) last.text += part;
    else segments.push({ translate, text: part });
  };
  let fence: { char: string; length: number } | null = null;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (fence) {
      push(false, line);
      const close = line.match(FENCE_CLOSE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN);
    // A backtick fence's info string cannot itself contain backticks.
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      push(false, line);
      continue;
    }
    push(true, line);
  }
  return segments;
}

// Coarse to fine: paragraphs, lines, then sentence ends (ASCII ones only
// before whitespace, so "3.14" or "file.ts" stay whole).
const SPLITTERS = [/(?<=\n[ \t]*\n)/, /(?<=\n)/, /(?<=[。！？；]|[.!?;](?=\s))/];

function hardSplit(text: string, max: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    // Never separate a surrogate pair.
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function splitDeep(text: string, level: number, max: number): string[] {
  if (text.length <= max) return [text];
  if (level >= SPLITTERS.length) return hardSplit(text, max);
  return text.split(SPLITTERS[level]).filter(Boolean).flatMap((part) => splitDeep(part, level + 1, max));
}

/** Consecutive pieces of at most `max` characters that concatenate to the input. */
export function chunkProse(text: string, max = MAX_TRANSLATE_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const part of splitDeep(text, 0, max)) {
    if (current && current.length + part.length > max) { chunks.push(current); current = ""; }
    current += part;
  }
  if (current) chunks.push(current);
  return chunks;
}

export type TranslationPiece =
  | { translate: false; text: string }
  | { translate: true; lead: string; core: string; trail: string };

/**
 * Split text into verbatim pieces (code fences, whitespace, text without
 * letters) and prose chunks to translate. Surrounding whitespace of each
 * chunk is kept so the translation keeps the original layout.
 */
export function planTranslation(text: string, max = MAX_TRANSLATE_CHUNK_CHARS): TranslationPiece[] {
  const pieces: TranslationPiece[] = [];
  for (const segment of splitCodeFences(text)) {
    if (!segment.translate) { pieces.push({ translate: false, text: segment.text }); continue; }
    for (const chunk of chunkProse(segment.text, max)) {
      const lead = chunk.match(/^\s*/)![0];
      const trail = lead.length === chunk.length ? "" : chunk.match(/\s*$/)![0];
      const core = chunk.slice(lead.length, chunk.length - trail.length);
      if (!/\p{L}/u.test(core)) pieces.push({ translate: false, text: chunk });
      else pieces.push({ translate: true, lead, core, trail });
    }
  }
  return pieces;
}

export function assembleTranslation(pieces: TranslationPiece[], translated: string[]): string {
  let index = 0;
  return pieces.map((piece) => piece.translate ? `${piece.lead}${translated[index++] ?? piece.core}${piece.trail}` : piece.text).join("");
}

/** Message text of an OpenAI-compatible chat completion, without a leading think block. */
export function completionText(body: unknown): string | null {
  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  }
  if (text === null) return null;
  return text.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
}

/**
 * A short reason from an error response body: OpenAI `{ error }`, FastAPI
 * `{ detail }`, or the anna gateway's `{ detail: { error: { message } } }`.
 */
export function completionErrorDetail(body: unknown, raw: string): string {
  const read = (value: unknown, depth: number): string | null => {
    if (typeof value === "string") return value.trim() || null;
    if (!value || typeof value !== "object" || depth > 3) return null;
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      const found = read(record[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return (read(body, 0) ?? raw).trim().slice(0, 300);
}
