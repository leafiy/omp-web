import { NextResponse } from "next/server";
import { lastContextUsage } from "@/lib/context-usage-cache";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const rpc = getRpcSession(id);
    if (!rpc?.isAlive()) {
      // An idle-closed process cannot answer; expose only its last native report.
      const usage = lastContextUsage(id);
      return NextResponse.json({ running: false, ...(usage ? { lastContextUsage: usage } : {}) });
    }

    const state = await rpc.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
