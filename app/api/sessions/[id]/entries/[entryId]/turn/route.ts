import { resolveSessionPath, openSessionManager, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { guardHistoryRequest, historyHeaders } from "@/lib/history-http";
import { historyTurn } from "@/lib/history-page";

/**
 * GET one complete history turn (prompt → process → answer) starting at
 * `entryId` on the requested branch. Read-only; nothing in the turn is deferred
 * except thinking text, which the thinking block loads when it is opened.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const denied = guardHistoryRequest(req); if (denied) return denied;
  const { id, entryId } = await params;
  const path = await resolveSessionPath(id);
  if (!path) return Response.json({ error: "Session not found" }, { status: 404, headers: historyHeaders });
  try {
    const searchParams = new URL(req.url).searchParams;
    const sm = openSessionManager(path);
    const liveLeafId = getRpcSession(id)?.getActiveLeafId();
    const leafId = searchParams.has("leafId") ? searchParams.get("leafId") || null : liveLeafId !== undefined ? liveLeafId : sm.getLeafId();
    const context = buildSessionContext(sm.getEntries() as never, leafId, { deferThinking: searchParams.has("deferThinking") });
    const turn = historyTurn(context, entryId);
    if (!turn) return Response.json({ error: "This turn is no longer on the selected branch" }, { status: 409, headers: historyHeaders });
    return Response.json({ sessionId: id, leafId, ...turn }, { headers: historyHeaders });
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return Response.json({ error: missing ? "Session not found" : "History could not be read" }, { status: missing ? 404 : 503, headers: historyHeaders });
  }
}
