import { getUsageOverview, parsePeriodQuery } from "@/lib/subscription-usage";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isRequestAuthenticated, webAuthRequired } from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403, headers });
  if (!isRequestAuthenticated(req)) return webAuthRequired(headers);
  const params = new URL(req.url).searchParams;
  const sessionId = params.get("sessionId") || undefined;
  if (sessionId && (sessionId.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(sessionId))) return Response.json({ error: "Invalid session ID" }, { status: 400, headers });
  const since = params.get("since"), dates = params.get("dates");
  const periods = since !== null || dates !== null ? parsePeriodQuery(since, dates) : null;
  if ((since !== null || dates !== null) && !periods) return Response.json({ error: "Invalid periods" }, { status: 400, headers });
  return Response.json(await getUsageOverview(sessionId, params.get("refresh") === "1", periods), { headers });
}
