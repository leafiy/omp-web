import { NextResponse } from "next/server";
import { getRunningRpcSessionIds, getWaitingRpcSessionIds } from "@/lib/rpc-manager";

import { sessionReadState } from "@/lib/session-read-state";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  const runningSessionIds = getRunningRpcSessionIds();
  const reads = sessionReadState();
  reads.observeRunning(runningSessionIds);
  return NextResponse.json(
    { runningSessionIds, waitingSessionIds: getWaitingRpcSessionIds(), readState: reads.snapshot() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
