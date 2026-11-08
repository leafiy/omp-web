import { clearSessionCookie, revokeRequestSession } from "@/lib/web-auth";
import { guardWebAuthRequest, noStore } from "@/lib/web-auth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = guardWebAuthRequest(req);
  if (denied) return denied;
  revokeRequestSession(req);
  return Response.json({ ok: true }, { headers: { ...noStore, "Set-Cookie": clearSessionCookie(req) } });
}
