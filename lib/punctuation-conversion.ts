/** Explicit approximations for punctuation without an ASCII width variant.
 * Do not NFKC the whole message: that would rewrite units, circled numbers,
 * mathematical letters and other meaningful non-punctuation text.
 */
const GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["、､﹑", ","], ["。｡", "."],
  ["‘’‚‛′‵", "'"], ["“”„‟″‶〝〞〟", '"'],
  ["‴‷", '"""'],
  ["「『｢", '"'], ["」』｣", '"'],
  ["〈《", "<"], ["〉》", ">"],
  ["【〔〖〘〚", "["], ["】〕〗〙〛", "]"],
  ["｟", "("], ["｠", ")"],
  ["‐‑‒–—―−﹘", "-"], ["〜～〰", "~"],
  ["…", "..."], ["‥", ".."], ["⋯", "..."],
  ["·・･‧•﹅﹆", "."], ["‖", "||"],
  ["﹉﹊﹋﹌", "-"], ["﹍﹎﹏", "_"],
  ["‼", "!!"], ["⁇", "??"], ["⁈", "?!"], ["⁉", "!?"],
  ["⁄∕", "/"], ["∖", "\\"],
];
const REPLACEMENTS = new Map(GROUPS.flatMap(([characters, replacement]) =>
  Array.from(characters, (character) => [character, replacement] as const)));

export function convertPunctuation(text: string): string {
  return Array.from(text, (character) => {
    const explicit = REPLACEMENTS.get(character);
    if (explicit !== undefined) return explicit;
    const code = character.codePointAt(0)!;
    // Entire fullwidth ASCII range, including letters/digits, plus ideographic space.
    if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
    if (code === 0x3000) return " ";
    // Vertical/small presentation forms and fullwidth currency/symbol variants.
    // Normalize only these ranges, then map the resulting Chinese punctuation.
    if ((code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff5f && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) {
      const normalized = character.normalize("NFKC");
      if (normalized !== character) return convertPunctuation(normalized);
    }
    return character;
  }).join("");
}

/** Never turn prose beginning with fullwidth ! or / into an executable command. */
export function convertPromptPunctuation(text: string, enabled: boolean): string {
  if (!enabled || /^[!/]/.test(text.trimStart())) return text;
  const converted = convertPunctuation(text);
  if (/^[!/]/.test(converted.trimStart())) {
    return converted.replace(/^(\s*)[!/]/, (_match, whitespace: string) =>
      whitespace + text.trimStart()[0]);
  }
  return converted;
}

const STORAGE_KEY = "omp-web:punctuation-conversion";
const CHANGE_EVENT = "omp-web:punctuation-conversion-change";
let fallback = true;

export function readPunctuationConversion(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? fallback : stored !== "false";
  }
  catch { return fallback; }
}

export function writePunctuationConversion(enabled: boolean): void {
  fallback = enabled;
  try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* Keep working in memory. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribePunctuationConversion(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) { fallback = true; listener(); }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}
