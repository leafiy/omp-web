import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIds, getWaitingRpcSessionIds } from "@/lib/rpc-manager";
import { sessionPinState } from "@/lib/session-pin-state";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    return NextResponse.json(
      { sessions, runningSessionIds: getRunningRpcSessionIds(), waitingSessionIds: getWaitingRpcSessionIds(), pinState: sessionPinState().snapshot() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
