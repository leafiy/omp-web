import { isApiRequestAllowed, hasJsonContentType } from "./request-security";
import { isRequestAuthenticated, webAuthRequired } from "./web-auth";
import { TERMINAL_MAX_BODY } from "./terminal-contract";

// Check every endpoint locally: the app proxy intentionally skips /events.
export function guardTerminalRequest(req: Request): Response | null {
  if (process.env.OMP_WEB_TERMINAL === "0") return Response.json({ error: "Terminal is disabled" }, { status: 403 });
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted terminal request" }, { status: 403 });
  if (!isRequestAuthenticated(req)) return webAuthRequired();
  if (req.method === "POST" && !hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415 });
  return null;
}

export async function readTerminalBody(req: Request): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Missing JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TERMINAL_MAX_BODY) {
        await reader.cancel();
        throw new Error("Terminal request is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected JSON object");
  return body;
}

export function terminalErrorResponse(error: unknown): Response {
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status : 500;
  // Avoid leaking paths/environment through unexpected native errors.
  if (status === 500) console.error("Terminal request failed:", error);
  return Response.json({ error: status === 500 ? "Unable to start or control terminal. Check server logs." : String((error as Error).message) }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
