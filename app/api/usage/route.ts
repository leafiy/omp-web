import { getSubscriptionUsage } from "@/lib/subscription-usage";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isValidBasicAuthorization, isWebPasswordEnabled } from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403, headers });
  if (isWebPasswordEnabled() && !isValidBasicAuthorization(req.headers.get("authorization"))) return new Response("Authentication required", { status: 401, headers });
  const params = new URL(req.url).searchParams;
  const sessionId = params.get("sessionId") || undefined;
  if (sessionId && (sessionId.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(sessionId))) return Response.json({ error: "Invalid session ID" }, { status: 400, headers });
  return Response.json(await getSubscriptionUsage(sessionId, params.get("refresh") === "1"), { headers });
}
