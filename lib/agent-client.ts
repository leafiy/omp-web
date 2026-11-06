import { engineForSession, type AgentEngine } from "@/lib/engine";

// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

/** Creates a session in an explicit engine; returned IDs remain opaque web IDs. */
export async function createAgentSession<T extends { sessionId: string; engine: AgentEngine }>(
  engine: AgentEngine,
  options: { cwd: string; type: "ensure_session"; provider?: string; modelId?: string; thinkingLevel?: string },
): Promise<T> {
  const res = await fetch("/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...options, engine }),
  });
  const body = await res.json() as T & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (typeof body.sessionId !== "string" || !body.sessionId || body.engine !== engine || engineForSession(body.sessionId) !== engine) {
    throw new Error("The server returned a different or unidentified engine. Refresh the page before starting a new chat.");
  }
  return body;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.data as T;
}
