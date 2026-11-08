import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { isRequestAuthenticated, webAuthRequired } from "@/lib/web-auth";

// Reachable before login. Everything else requires a valid session cookie;
// there is no unauthenticated mode.
const PUBLIC_API_PATHS = new Set(["/api/web-auth/login", "/api/web-auth/status"]);

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Bypass SSE streams and long-polling event connections to prevent the
  // proxy/middleware from buffering or timing them out. Those routes check
  // host/origin and the login session themselves.
  if (/^\/api\/(?:agent|terminal)\/[^/]+\/events$/.test(pathname)) {
    return NextResponse.next();
  }
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  if (!PUBLIC_API_PATHS.has(pathname) && !isRequestAuthenticated(request)) {
    if (!isApiRequest) {
      // Next's middleware adapter parses Location as an absolute URL (a bare
      // "/login" throws ERR_INVALID_URL → 500), then rewrites same-host
      // redirects back to a relative path, which keeps the public host/scheme
      // behind reverse proxies.
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      return NextResponse.redirect(loginUrl, { status: 307, headers: { "Cache-Control": "no-store" } });
    }
    return webAuthRequired({}, true);
  }

  // These legacy panels write Pi auth/settings or invoke Pi model tests. Do
  // not let stale browser tabs report successful changes to the wrong engine.
  if (["/api/auth", "/api/models-config", "/api/plugins", "/api/skills"].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.json({ error: "These legacy editors are not engine-scoped. Manage credentials, models, plugins and skills with the selected local OMP or Pi CLI; the shared legacy settings APIs are disabled." }, { status: 409 });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
