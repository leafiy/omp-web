import { NextResponse } from "next/server";
import { isSessionPinId, sessionPinState } from "@/lib/session-pin-state";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

// Authentication and same-origin checks are enforced by proxy.ts.
export async function GET() {
  try {
    return NextResponse.json({ pinState: sessionPinState().snapshot() }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not read session pins" }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid session pin update" }, { status: 400, headers });
  }
  const { sessionId, pinned } = body as { sessionId?: unknown; pinned?: unknown };
  if (!isSessionPinId(sessionId) || typeof pinned !== "boolean") {
    return NextResponse.json({ error: "Invalid session pin update" }, { status: 400, headers });
  }
  try {
    // Do not resolve/start an engine: a newly created session can be pinned
    // before its native transcript has been flushed to disk.
    return NextResponse.json({ pinState: sessionPinState().setPinned(sessionId, pinned) }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not save session pins" }, { status: 503, headers });
  }
}
