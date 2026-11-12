import { mkdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { chatCompletionsUrl } from "./translate-text";

/**
 * Web-only translation settings. Stored beside the web login credentials,
 * never in an agent directory, because no engine owns this feature.
 */
export interface TranslateConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

/** What the browser may see: the key itself never leaves the server. */
export interface TranslateStatus {
  configured: boolean;
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  url: string | null;
}

export const MAX_TRANSLATE_FIELD_CHARS = 2048;

export function translateConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMP_WEB_TRANSLATE_FILE?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("OMP_WEB_TRANSLATE_FILE must be an absolute path.");
    return configured;
  }
  return join(homedir(), ".config", "omp-web", "translate.json");
}

function validField(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TRANSLATE_FIELD_CHARS && !/[\0\r\n]/.test(value);
}

/** The saved settings, or null when translation is not configured. */
export function readTranslateConfig(path = translateConfigPath()): TranslateConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const record: unknown = JSON.parse(text);
    if (!record || typeof record !== "object") return null;
    const { endpoint, model, apiKey = "" } = record as Record<string, unknown>;
    if (!validField(endpoint) || !validField(model) || !validField(apiKey) || !model.trim() || !chatCompletionsUrl(endpoint)) return null;
    return { endpoint, model, apiKey };
  } catch {
    return null;
  }
}

/** Saves settings privately; null removes them, which hides translation. */
export function writeTranslateConfig(config: TranslateConfig | null, path = translateConfigPath()): void {
  if (!config) {
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`);
}

export function translateStatus(config: TranslateConfig | null): TranslateStatus {
  if (!config) return { configured: false, endpoint: "", model: "", hasApiKey: false, url: null };
  return { configured: true, endpoint: config.endpoint, model: config.model, hasApiKey: config.apiKey.length > 0, url: chatCompletionsUrl(config.endpoint) };
}
