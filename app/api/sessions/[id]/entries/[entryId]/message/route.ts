import { resolveSessionPath, getSessionEntries, entryToUiMessage } from "@/lib/session-reader";
import { guardHistoryRequest, historyHeaders } from "@/lib/history-http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const denied = guardHistoryRequest(req); if (denied) return denied;
  const { id, entryId } = await params;
  const path = await resolveSessionPath(id);
  if (!path) return Response.json({ error: "Session not found" }, { status: 404, headers: historyHeaders });
  try {
    const entry = getSessionEntries(path).find((item) => item.id === entryId);
    const message = entry ? entryToUiMessage(entry, {}) : null;
    return message ? Response.json({ message }, { headers: historyHeaders }) : Response.json({ error: "Message not found" }, { status: 404, headers: historyHeaders });
  } catch { return Response.json({ error: "Message unavailable" }, { status: 503, headers: historyHeaders }); }
}
