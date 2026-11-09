import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isTerminalId, isTerminalSize, type TerminalLaunch } from "@/lib/terminal-contract";
import { guardTerminalRequest, readTerminalBody, terminalErrorResponse } from "@/lib/terminal-http";
import { getTerminalRegistry, TerminalError } from "@/lib/terminal-manager";
import { resolveTerminalLaunch, terminalShellCatalog } from "@/lib/terminal-shells";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shells offered for new terminals: /etc/shells plus the automatic default.
export async function GET(req: Request) {
  const denied = guardTerminalRequest(req);
  if (denied) return denied;
  try {
    return Response.json(terminalShellCatalog(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return terminalErrorResponse(error); }
}

// Creation is POST-only and idempotent, including React StrictMode remounts.
export async function POST(req: Request) {
  const denied = guardTerminalRequest(req);
  if (denied) return denied;
  try {
    const body = await readTerminalBody(req).catch(() => { throw new TerminalError("Invalid JSON body", 400); });
    if (!isTerminalId(body.id) || !isTerminalSize(body) || typeof body.cwd !== "string" || !path.isAbsolute(body.cwd)) {
      throw new TerminalError("Expected id, absolute cwd, cols and rows", 400);
    }
    const { shell, login } = body;
    if ((shell !== undefined && typeof shell !== "string") || (login !== undefined && typeof login !== "boolean")) {
      throw new TerminalError("Expected shell path and boolean login", 400);
    }
    const choice: TerminalLaunch = { shell, login };
    const roots = await getAllowedFileRoots();
    const cwd = await realpath(body.cwd).catch(() => { throw new TerminalError("Directory does not exist", 400); });
    if (!isExistingFilePathAllowed(cwd, roots)) throw new TerminalError("Directory is not allowed", 403);
    if (!(await stat(cwd)).isDirectory()) throw new TerminalError("Not a directory", 400);
    // Reattaching ignores the choice, so a stale preference cannot block it.
    const info = getTerminalRegistry().open(body.id, cwd, body, () => {
      const plan = resolveTerminalLaunch(choice);
      if (!plan) throw new TerminalError("Shell is not listed in /etc/shells", 400);
      return plan;
    });
    return Response.json(info, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return terminalErrorResponse(error); }
}
