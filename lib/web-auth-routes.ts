import { hasJsonContentType, isApiRequestAllowed } from "./request-security";

export const noStore = { "Cache-Control": "no-store" };
const MAX_BODY = 4096;

/** Host/origin checks for auth endpoints (the proxy also applies them). */
export function guardWebAuthRequest(req: Request): Response | null {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403, headers: noStore });
  if (req.method === "POST" && !hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415, headers: noStore });
  return null;
}

export async function readSmallJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

declare global {
  var __ompWebLoginFailures: Map<string, { count: number; resetAt: number }> | undefined;
}

function failures() {
  return globalThis.__ompWebLoginFailures ??= new Map();
}

export function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    || req.headers.get("x-real-ip")?.trim()
    || "direct";
}

/** Seconds until another attempt is allowed, or 0. */
export function loginRetryAfter(key: string, now = Date.now()): number {
  const entry = failures().get(key);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.count >= MAX_FAILURES ? Math.ceil((entry.resetAt - now) / 1000) : 0;
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  const map = failures();
  for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
  const entry = map.get(key);
  if (entry && entry.resetAt > now) entry.count++;
  else map.set(key, { count: 1, resetAt: now + WINDOW_MS });
  // Bound memory under spoofed forwarding headers.
  if (map.size > 10_000) map.delete(map.keys().next().value!);
}

export function clearLoginFailures(key: string): void {
  failures().delete(key);
}
