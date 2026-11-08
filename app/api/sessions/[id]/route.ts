import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { sessionFileVersion } from "@/lib/session-file-cache";
import { windowHistory, lightHistoryTree } from "@/lib/history-page";
import { guardHistoryRequest, historyHeaders } from "@/lib/history-http";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
  openSessionManager,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession, startRpcSession, withIdleSessionDeletion, SessionDeletionConflict } from "@/lib/rpc-manager";
import { engineForSession, supportsSessionDeletion } from "@/lib/engine";
import { deleteClaudeSession } from "@/lib/claude-code-delete";

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, branch points, and leaves while contracting single-child chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain.
 */
function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[] }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[]): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[] }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = guardHistoryRequest(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const searchParams = new URL(req.url).searchParams;
    const windowed = searchParams.get("window") === "1";
    const version = sessionFileVersion(filePath);
    if (windowed && searchParams.has("version") && searchParams.get("version") !== version) return NextResponse.json({ error: "History changed; refresh the latest page" }, { status: 409, headers: historyHeaders });
    const liveLeafId = getRpcSession(id)?.getActiveLeafId();
    const etag = '"' + createHash("sha256").update(JSON.stringify(["history-v2", id, version, liveLeafId, searchParams.toString()])).digest("hex") + '"';
    const headers = { ...historyHeaders, ETag: etag };
    if (windowed && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const sm = openSessionManager(filePath);
    const entries = sm.getEntries() as never;
    const leafId = searchParams.has("leafId") ? searchParams.get("leafId") || null : liveLeafId !== undefined ? liveLeafId : sm.getLeafId();
    const tree = windowed && engineForSession(id) !== "omp" ? [] : projectTreeForResponse(sm.getTree());
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = !windowed && searchParams.has("deferMedia");
    const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });
    // Recent turns arrive whole; older turns are outlined and fetched whole on expand.
    const paged = windowed ? windowHistory(context, version) : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession, engineForSession(id))
      : undefined;
    const info = header ? {
      path: filePath,
      id,
      engine: engineForSession(id),
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    } : null;

    if (sessionFileVersion(filePath) !== version) return NextResponse.json({ error: "History changed while reading" }, { status: 409, headers: historyHeaders });
    if (windowed && info) info.firstMessage = info.firstMessage.slice(0, 240);
    return NextResponse.json({
      sessionId: id, filePath, info, leafId,
      tree: windowed ? lightHistoryTree(tree) : tree,
      context: paged?.context ?? context,
      ...(paged ? { page: paged.page } : {}),
    }, { headers });
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    const changed = error instanceof Error && error.message === "Session changed while reading; retry";
    return NextResponse.json({ error: missing ? "Session not found" : changed ? "History changed while reading" : "History could not be read" }, { status: missing ? 404 : changed ? 409 : 503, headers: historyHeaders });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const { session } = await startRpcSession(id, filePath, undefined);
    await session.send({ type: "set_session_name", name: name.trim() });
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = guardHistoryRequest(req);
  if (denied) return denied;
  const { id } = await params;
  if (!supportsSessionDeletion(engineForSession(id))) return NextResponse.json({ error: "Deletion is not enabled for this engine: native history and the web display projection must be handled together" }, { status: 409 });
  try {
    if (engineForSession(id) === "claude") {
      return await withIdleSessionDeletion(id, async () => {
        const projectionPath = await resolveSessionPath(id);
        if (!projectionPath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
        await deleteClaudeSession(id, projectionPath);
        invalidateSessionPathCache(id);
        invalidateSessionListCache();
        return NextResponse.json({ ok: true });
      });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (
            header.type === "session" &&
            header.parentSession &&
            sessionPathKey(header.parentSession) === targetPathKey
          ) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    await getRpcSession(id)?.shutdown();
    unlinkSync(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof SessionDeletionConflict ? 409 : 500 });
  }
}
