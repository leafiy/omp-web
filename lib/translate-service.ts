import type { TranslateConfig } from "./translate-config";
import {
  assembleTranslation, chatCompletionsUrl, completionErrorDetail, completionText, planTranslation, translationRequestBody,
  type TranslateDirection,
} from "./translate-text";

export class TranslateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TranslateError";
  }
}

const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 180_000;

type Fetch = typeof fetch;

async function requestChunk(url: string, config: TranslateConfig, direction: TranslateDirection, text: string, signal: AbortSignal, fetchImpl: Fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(translationRequestBody(direction, text, config.model)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if ((error as Error)?.name === "TimeoutError") throw new TranslateError("The translation API did not answer in time.", 504);
    const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
    const reason = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : (error as Error)?.message;
    throw new TranslateError(`Cannot reach the translation API${reason ? ` (${reason})` : ""}.`, 502);
  }
  const raw = await response.text().catch(() => "");
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* reported below */ }
  if (!response.ok) {
    const detail = completionErrorDetail(body, raw);
    throw new TranslateError(`The translation API returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, 502);
  }
  const translated = completionText(body);
  if (translated === null) throw new TranslateError("The translation API returned no message content.", 502);
  return translated;
}

/**
 * Translate each text with an OpenAI-compatible chat-completions API. Code
 * fences stay verbatim and long prose is sent in chunks; the first failure
 * cancels the remaining requests.
 */
export async function translateTexts(
  texts: string[],
  direction: TranslateDirection,
  config: TranslateConfig,
  signal: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<string[]> {
  const url = chatCompletionsUrl(config.endpoint);
  if (!url) throw new TranslateError("The configured translation API URL is invalid.", 409);
  const plans = texts.map((text) => planTranslation(text));
  const jobs = plans.flatMap((plan) => plan.flatMap((piece) => piece.translate ? [piece.core] : []));
  const results: string[] = new Array(jobs.length);
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < jobs.length && !controller.signal.aborted) {
      const index = next++;
      try {
        results[index] = await requestChunk(url, config, direction, jobs[index], controller.signal, fetchImpl);
      } catch (error) {
        failure ??= error;
        controller.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (failure) throw failure;
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  let offset = 0;
  return plans.map((plan) => {
    const count = plan.filter((piece) => piece.translate).length;
    const translated = results.slice(offset, offset + count);
    offset += count;
    return assembleTranslation(plan, translated);
  });
}
