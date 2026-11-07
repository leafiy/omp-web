import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/** Read only: never starts/resumes an agent to inspect a task, and never accepts a transcript path. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params;
  const headers = { "Cache-Control": "no-store" };
  if (!taskId || taskId.length > 1024) return NextResponse.json({ error: "Invalid task ID" }, { status: 400, headers });
  const session = getRpcSession(id);
  if (!session?.isAlive()) return NextResponse.json({ error: "Task session is no longer active" }, { status: 410, headers });
  try {
    const detail = await session.send({ type: "get_task_detail", taskId });
    return NextResponse.json(detail, { headers });
  } catch (error) {
    const unknown = error instanceof Error && error.message === "Unknown task in this session";
    return NextResponse.json({ error: unknown ? "Task not found in this session" : "Task conversation unavailable" }, { status: unknown ? 404 : 503, headers });
  }
}
