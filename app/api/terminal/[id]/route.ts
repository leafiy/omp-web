import { isTerminalId, isTerminalSize, TERMINAL_MAX_INPUT } from "@/lib/terminal-contract";
import { guardTerminalRequest, readTerminalBody, terminalErrorResponse } from "@/lib/terminal-http";
import { getTerminalRegistry, TerminalError } from "@/lib/terminal-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Context) {
  const denied = guardTerminalRequest(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (!isTerminalId(id)) throw new TerminalError("Invalid terminal ID", 400);
    const body = await readTerminalBody(req).catch(() => { throw new TerminalError("Invalid JSON body", 400); });
    const terminal = getTerminalRegistry().get(id);
    if (body.type === "input" && typeof body.data === "string" && body.data.length <= TERMINAL_MAX_INPUT) {
      terminal.write(body.data);
    } else if (body.type === "resize" && isTerminalSize(body)) {
      terminal.resize(body);
    } else if (body.type === "keepalive") {
      terminal.keepAlive();
    } else throw new TerminalError("Invalid terminal command", 400);
    return new Response(null, { status: 204 });
  } catch (error) { return terminalErrorResponse(error); }
}

export async function DELETE(req: Request, { params }: Context) {
  const denied = guardTerminalRequest(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (!isTerminalId(id)) throw new TerminalError("Invalid terminal ID", 400);
    getTerminalRegistry().close(id);
    return new Response(null, { status: 204 });
  } catch (error) { return terminalErrorResponse(error); }
}
