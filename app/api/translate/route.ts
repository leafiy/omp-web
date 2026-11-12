import { hasJsonContentType } from "@/lib/request-security";
import { readTranslateConfig } from "@/lib/translate-config";
import { TranslateError, translateTexts } from "@/lib/translate-service";
import { isTranslateDirection } from "@/lib/translate-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const MAX_BODY_CHARS = 512 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_TEXTS = 32;

// POST /api/translate { direction: "zh2en" | "en2zh", texts: string[] } → { texts }
// The proxy has already enforced login and same-origin checks.
export async function POST(req: Request) {
  if (!hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415, headers: noStore });
  const config = readTranslateConfig();
  if (!config) return Response.json({ error: "Translation is not configured.", code: "not_configured" }, { status: 409, headers: noStore });

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_CHARS) return Response.json({ error: "Text is too long to translate." }, { status: 413, headers: noStore });
  let body: { direction?: unknown; texts?: unknown } | null = null;
  try { body = JSON.parse(raw); } catch { /* rejected below */ }
  const direction = body?.direction;
  const texts = body?.texts;
  if (!isTranslateDirection(direction) || !Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS
    || !texts.every((text): text is string => typeof text === "string")) {
    return Response.json({ error: "Expected { direction: \"zh2en\" | \"en2zh\", texts: string[] }." }, { status: 400, headers: noStore });
  }
  if (texts.reduce((total, text) => total + text.length, 0) > MAX_TEXT_CHARS) {
    return Response.json({ error: `Text is too long to translate (limit ${MAX_TEXT_CHARS} characters).` }, { status: 413, headers: noStore });
  }

  try {
    return Response.json({ texts: await translateTexts(texts, direction, config, req.signal) }, { headers: noStore });
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499, headers: noStore });
    if (error instanceof TranslateError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
    console.error("Translation failed:", error);
    return Response.json({ error: "Translation failed." }, { status: 500, headers: noStore });
  }
}
