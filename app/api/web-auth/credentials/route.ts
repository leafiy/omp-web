import { loadWebCredentials, setWebCredentials, validatePassword, validateUsername, verifyWebLogin } from "@/bin/web-credentials.js";
import { createSessionCookie, isRequestAuthenticated, readWebCredentials, webAuthRequired } from "@/lib/web-auth";
import { clientKey, guardWebAuthRequest, loginRetryAfter, noStore, readSmallJson, recordLoginFailure } from "@/lib/web-auth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Change username and/or password. Requires a session AND the current
// password; rotating the secret signs out every other browser.
export async function POST(req: Request) {
  const denied = guardWebAuthRequest(req);
  if (denied) return denied;
  if (!isRequestAuthenticated(req)) return webAuthRequired(noStore, true);
  const key = clientKey(req);
  if (loginRetryAfter(key) > 0) return Response.json({ error: "Too many failed attempts. Try again later.", code: "rate_limited" }, { status: 429, headers: noStore });
  const credentials = readWebCredentials();
  if (!credentials) return webAuthRequired(noStore, true);
  const body = await readSmallJson(req);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!(await verifyWebLogin(credentials, credentials.username, currentPassword))) {
    recordLoginFailure(key);
    return Response.json({ error: "Current password is incorrect.", code: "invalid_current_password" }, { status: 403, headers: noStore });
  }
  const problem = validateUsername(username) ?? validatePassword(newPassword);
  if (problem) return Response.json({ error: problem, code: "invalid_input" }, { status: 400, headers: noStore });
  try {
    await setWebCredentials(username, newPassword);
  } catch (error) {
    console.error("Cannot save web credentials:", error);
    return Response.json({ error: "Cannot save credentials on the server. Check the credentials file permissions.", code: "write_failed" }, { status: 500, headers: noStore });
  }
  const updated = loadWebCredentials();
  if (!updated) return Response.json({ error: "Credentials were not saved.", code: "write_failed" }, { status: 500, headers: noStore });
  return Response.json({ ok: true, username: updated.username }, { headers: { ...noStore, "Set-Cookie": createSessionCookie(req, updated) } });
}
