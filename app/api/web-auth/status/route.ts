import { authenticatedUsername, readWebCredentials } from "@/lib/web-auth";
import { guardWebAuthRequest, noStore } from "@/lib/web-auth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public: tells the login page whether credentials exist. Never reveals the
// username to an unauthenticated client.
export async function GET(req: Request) {
  const denied = guardWebAuthRequest(req);
  if (denied) return denied;
  const credentials = readWebCredentials();
  const username = credentials ? authenticatedUsername(req) : null;
  return Response.json({
    configured: Boolean(credentials),
    invalid: credentials === null,
    authenticated: username !== null,
    ...(username !== null ? { username, managedByFile: credentials?.source === "file" } : {}),
  }, { headers: noStore });
}
