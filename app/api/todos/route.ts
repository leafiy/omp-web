import { NextResponse } from "next/server";
import { todoState } from "@/lib/todo-state";
import { parseTodoMutation, TodoLimitError } from "@/lib/todo-types";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const MAX_BODY_CHARS = 64 * 1024;

// Authentication and same-origin checks are enforced by proxy.ts.
export async function GET() {
  try {
    return NextResponse.json({ todos: todoState().snapshot() }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not read the todo list" }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Todo update is too large" }, { status: 413, headers });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }
  const mutation = parseTodoMutation(body);
  if (!mutation) return NextResponse.json({ error: "Invalid todo update" }, { status: 400, headers });
  try {
    // Links are stored as given: a new chat can be added before its native
    // transcript is flushed, and a deleted chat keeps its todo until removed.
    return NextResponse.json({ todos: todoState().apply(mutation) }, { headers });
  } catch (error) {
    if (error instanceof TodoLimitError) return NextResponse.json({ error: error.message }, { status: 409, headers });
    return NextResponse.json({ error: "Could not save the todo list" }, { status: 503, headers });
  }
}
