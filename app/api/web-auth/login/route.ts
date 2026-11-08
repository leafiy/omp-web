import { verifyWebLogin } from "@/bin/web-credentials.js";
import { createSessionCookie, readWebCredentials } from "@/lib/web-auth";
import { clearLoginFailures, clientKey, guardWebAuthRequest, loginRetryAfter, noStore, readSmallJson, recordLoginFailure } from "@/lib/web-auth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = guardWebAuthRequest(req);
  if (denied) return denied;
  const key = clientKey(req);
  const retryAfter = loginRetryAfter(key);
  if (retryAfter > 0) {
    return Response.json({ error: "Too many failed attempts. Try again later.", code: "rate_limited", retryAfter }, { status: 429, headers: { ...noStore, "Retry-After": String(retryAfter) } });
  }
  const credentials = readWebCredentials();
  if (!credentials) {
    return Response.json({ error: "Web credentials are not configured on the server.", code: credentials === null ? "invalid" : "not_configured" }, { status: 503, headers: noStore });
  }
  const body = await readSmallJson(req);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await verifyWebLogin(credentials, username, password))) {
    recordLoginFailure(key);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return Response.json({ error: "Invalid username or password.", code: "invalid_credentials" }, { status: 401, headers: noStore });
  }
  clearLoginFailures(key);
  return Response.json({ ok: true, username: credentials.username }, { headers: { ...noStore, "Set-Cookie": createSessionCookie(req, credentials) } });
}
