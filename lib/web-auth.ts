import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  loadWebCredentials,
  verifySessionToken,
} from "../bin/web-credentials.js";

export const WEB_SESSION_COOKIE = SESSION_COOKIE;
/** Marks 401 responses caused by missing web login, so the browser can redirect. */
export const WEB_AUTH_HEADER = "X-OMP-Web-Auth";

type WebCredentials = NonNullable<ReturnType<typeof loadWebCredentials>>;
type RequestLike = { headers: Headers; url?: string };

declare global {
  var __ompWebRevokedSessions: Map<string, number> | undefined;
}

function revokedSessions(): Map<string, number> {
  return globalThis.__ompWebRevokedSessions ??= new Map();
}

/** Credentials, undefined when unset, or null when the configured source is invalid. */
export function readWebCredentials(): WebCredentials | undefined | null {
  try { return loadWebCredentials(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function sessionFromRequest(req: RequestLike, credentials: WebCredentials) {
  const token = readCookie(req.headers.get("cookie"), WEB_SESSION_COOKIE);
  if (!token) return null;
  const session = verifySessionToken(token, credentials);
  if (!session) return null;
  const revoked = revokedSessions().get(session.n);
  if (revoked !== undefined) return null;
  return session;
}

/** True only for a valid login session. No credentials configured means no access. */
export function isRequestAuthenticated(req: RequestLike): boolean {
  const credentials = readWebCredentials();
  if (!credentials) return false;
  return sessionFromRequest(req, credentials) !== null;
}

/** Username of the authenticated session, or null. */
export function authenticatedUsername(req: RequestLike): string | null {
  const credentials = readWebCredentials();
  if (!credentials) return null;
  return sessionFromRequest(req, credentials) ? credentials.username : null;
}

/** Revokes the request's session token until it would have expired anyway. */
export function revokeRequestSession(req: RequestLike): void {
  const credentials = readWebCredentials();
  if (!credentials) return;
  const session = sessionFromRequest(req, credentials);
  if (!session) return;
  const revoked = revokedSessions();
  const now = Date.now();
  for (const [nonce, expires] of revoked) if (expires <= now) revoked.delete(nonce);
  revoked.set(session.n, session.exp * 1000);
}

function isSecureRequest(req: RequestLike): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try { return req.url ? new URL(req.url).protocol === "https:" : false; } catch { return false; }
}

export function createSessionCookie(req: RequestLike, credentials: WebCredentials): string {
  const token = createSessionToken(credentials);
  return [
    `${WEB_SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`, ...(isSecureRequest(req) ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(req: RequestLike): string {
  return [`${WEB_SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(isSecureRequest(req) ? ["Secure"] : [])].join("; ");
}

/**
 * 401 for unauthenticated requests. Deliberately no WWW-Authenticate header:
 * the browser must show the login page, never a native Basic Auth prompt.
 */
export function webAuthRequired(headers: Record<string, string> = {}, json = false): Response {
  const init = { status: 401, headers: { "Cache-Control": "no-store", ...headers, [WEB_AUTH_HEADER]: "required" } };
  return json ? Response.json({ error: "Authentication required" }, init) : new Response("Authentication required", init);
}
