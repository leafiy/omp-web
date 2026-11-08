import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIds, getWaitingRpcSessionIds } from "@/lib/rpc-manager";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds(), waitingSessionIds: getWaitingRpcSessionIds() });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
