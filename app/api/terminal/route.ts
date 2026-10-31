import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isTerminalId, isTerminalSize } from "@/lib/terminal-contract";
import { guardTerminalRequest, readTerminalBody, terminalErrorResponse } from "@/lib/terminal-http";
import { getTerminalRegistry, TerminalError } from "@/lib/terminal-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Creation is POST-only and idempotent, including React StrictMode remounts.
export async function POST(req: Request) {
  const denied = guardTerminalRequest(req);
  if (denied) return denied;
  try {
    const body = await readTerminalBody(req).catch(() => { throw new TerminalError("Invalid JSON body", 400); });
    if (!isTerminalId(body.id) || !isTerminalSize(body) || typeof body.cwd !== "string" || !path.isAbsolute(body.cwd)) {
      throw new TerminalError("Expected id, absolute cwd, cols and rows", 400);
    }
    const roots = await getAllowedFileRoots();
    const cwd = await realpath(body.cwd).catch(() => { throw new TerminalError("Directory does not exist", 400); });
    if (!isExistingFilePathAllowed(cwd, roots)) throw new TerminalError("Directory is not allowed", 403);
    if (!(await stat(cwd)).isDirectory()) throw new TerminalError("Not a directory", 400);
    return Response.json(getTerminalRegistry().open(body.id, cwd, body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return terminalErrorResponse(error); }
}
