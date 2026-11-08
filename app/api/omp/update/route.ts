import { getOmpUpdateView, OmpUpdateError, startOmpUpdate } from "@/lib/omp-update";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isRequestAuthenticated, webAuthRequired } from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

// Keep the destructive endpoint protected even if the proxy matcher changes.
function guardRequest(req: Request): Response | undefined {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted update request" }, { status: 403, headers });
  if (!isRequestAuthenticated(req)) return webAuthRequired(headers);
}

function errorResponse(error: unknown): Response {
  if (error instanceof OmpUpdateError) return Response.json({ error: error.message }, { status: error.status, headers });
  console.error("OMP update request failed", error);
  return Response.json({ error: "Unable to manage the OMP update. Check the web service logs." }, { status: 500, headers });
}

export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try { return Response.json(await getOmpUpdateView(), { headers }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415, headers });
  let body: unknown;
  try { body = await req.json(); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !("confirm" in body) || body.confirm !== true || Object.keys(body).length !== 1) {
    return Response.json({ error: "Explicit confirmation is required: {confirm:true}. No commands, paths or service names are accepted." }, { status: 400, headers });
  }
  try { return Response.json(await startOmpUpdate(), { status: 202, headers }); }
  catch (error) { return errorResponse(error); }
}
