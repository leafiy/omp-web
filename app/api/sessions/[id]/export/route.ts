import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { engineForSession, engineLabel, nativeSessionId, supportsExtendedChat, supportsHtmlExport } from "@/lib/engine";
import { renderSessionHtml } from "@/lib/session-html-export";
import { readClaudeNativeTitle } from "@/lib/claude-native-title";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const engine = engineForSession(id);
  if (!supportsHtmlExport(engine)) return Response.json({ error: "HTML export is not supported for this engine yet" }, { status: 409 });
  const disposition = new URL(req.url).searchParams.get("inline") === "1" ? "inline" : "attachment";
  let directory: string | undefined;
  try {
    const file = await resolveSessionPath(id);
    if (!file) return Response.json({ error: "Session not found" }, { status: 404 });
    let html: string;
    if (supportsExtendedChat(engine)) {
      const { session } = await startRpcSession(id, file, undefined);
      directory = await mkdtemp(join(tmpdir(), "omp-web-export-"));
      const outputPath = join(directory, "session.html");
      await session.send({ type: "export_html", outputPath });
      html = await readFile(outputPath, "utf8");
    } else {
      // The CLI has no HTML exporter: render the read-only web projection
      // (active branch). Never starts the agent or rewrites the file.
      const sm = openSessionManager(file);
      const header = sm.getHeader();
      const context = buildSessionContext(sm.getEntries() as never, sm.getLeafId());
      // A web rename wins; otherwise Claude Code's own title from its native transcript.
      const nativeTitle = engine === "claude" && !sm.getSessionName() && header?.cwd
        ? await readClaudeNativeTitle(nativeSessionId(id), header.cwd).catch(() => undefined) : undefined;
      html = renderSessionHtml({
        title: sm.getSessionName() || nativeTitle || `${engineLabel(engine)} session`,
        engineLabel: engineLabel(engine),
        cwd: header?.cwd ?? "",
        created: header?.timestamp,
        messages: context.messages,
      });
    }
    return new Response(html, { headers: { ...HTML_HEADERS, "Content-Disposition": `${disposition}; filename="${engine}-session.html"` } });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
