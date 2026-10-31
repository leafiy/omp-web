import { isTerminalId } from "@/lib/terminal-contract";
import { guardTerminalRequest, terminalErrorResponse } from "@/lib/terminal-http";
import { getTerminalRegistry, TerminalError } from "@/lib/terminal-manager";
import { terminalEventResponse } from "@/lib/terminal-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardTerminalRequest(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (!isTerminalId(id)) throw new TerminalError("Invalid terminal ID", 400);
    const after = Number(req.headers.get("last-event-id") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) throw new TerminalError("Invalid event cursor", 400);
    return terminalEventResponse(req, getTerminalRegistry().get(id), after);
  } catch (error) { return terminalErrorResponse(error); }
}
