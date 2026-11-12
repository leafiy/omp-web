import { hasJsonContentType } from "@/lib/request-security";
import {
  MAX_TRANSLATE_FIELD_CHARS, readTranslateConfig, translateStatus, writeTranslateConfig,
} from "@/lib/translate-config";
import { chatCompletionsUrl, DEFAULT_TRANSLATE_MODEL } from "@/lib/translate-text";
import { readSmallJson } from "@/lib/web-auth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function badField(value: unknown): boolean {
  return value !== undefined && (typeof value !== "string" || value.length > MAX_TRANSLATE_FIELD_CHARS || /[\0\r\n]/.test(value));
}

// GET /api/translate/config → status without the API key.
export async function GET() {
  return Response.json(translateStatus(readTranslateConfig()), { headers: noStore });
}

// PUT /api/translate/config { endpoint, model?, apiKey? }
// An empty endpoint removes the settings. An omitted apiKey keeps the saved
// key; an empty one removes it.
export async function PUT(req: Request) {
  if (!hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415, headers: noStore });
  const body = await readSmallJson(req);
  if (!body || badField(body.endpoint) || badField(body.model) || badField(body.apiKey)) {
    return Response.json({ error: "Expected { endpoint, model?, apiKey? } as single-line strings." }, { status: 400, headers: noStore });
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  try {
    if (!endpoint) {
      writeTranslateConfig(null);
      return Response.json(translateStatus(null), { headers: noStore });
    }
    if (!chatCompletionsUrl(endpoint)) {
      return Response.json({ error: "The API URL must be an http(s) address without embedded credentials." }, { status: 400, headers: noStore });
    }
    const model = (typeof body.model === "string" ? body.model.trim() : "") || DEFAULT_TRANSLATE_MODEL;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : readTranslateConfig()?.apiKey ?? "";
    const config = { endpoint, model, apiKey };
    writeTranslateConfig(config);
    return Response.json(translateStatus(config), { headers: noStore });
  } catch (error) {
    console.error("Cannot save translation settings:", error);
    return Response.json({ error: "Cannot save translation settings on the server." }, { status: 500, headers: noStore });
  }
}
