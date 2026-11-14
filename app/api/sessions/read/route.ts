import { NextResponse } from "next/server";
import { sessionReadState } from "@/lib/session-read-state";

export const dynamic = "force-dynamic";

// Authentication and same-origin checks are enforced by proxy.ts.
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const receipts = body && typeof body === "object" ? (body as { receipts?: unknown }).receipts : null;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)
    || Object.entries(receipts).some(([id, version]) => !id || id.length > 512 || !Number.isSafeInteger(version) || Number(version) <= 0)) {
    return NextResponse.json({ error: "Invalid read receipts" }, { status: 400 });
  }
  return NextResponse.json(
    { readState: sessionReadState().acknowledge(receipts as Record<string, number>) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
