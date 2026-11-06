import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { engineForSession, supportsExtendedChat } from "@/lib/engine";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!supportsExtendedChat(engineForSession(id))) return Response.json({ error: "HTML export is not supported for this engine yet" }, { status: 409 });
  let directory: string | undefined;
  try {
    const file = await resolveSessionPath(id);
    if (!file) return Response.json({ error: "Session not found" }, { status: 404 });
    const { session } = await startRpcSession(id, file, undefined);
    directory = await mkdtemp(join(tmpdir(), "omp-web-export-"));
    const outputPath = join(directory, "session.html");
    await session.send({ type: "export_html", outputPath });
    const html = await readFile(outputPath, "utf8");
    const disposition = new URL(req.url).searchParams.get("inline") === "1" ? "inline" : "attachment";
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `${disposition}; filename="${engineForSession(id)}-session.html"`,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
