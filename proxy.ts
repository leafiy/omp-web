import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  getWebPassword,
} from "@/lib/web-auth";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Bypass SSE streams and long-polling event connections to prevent the
  // proxy/middleware from buffering or timing them out.
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

  const password = getWebPassword();
  if (
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  // These legacy panels write Pi auth/settings or invoke Pi model tests. Do
  // not let stale browser tabs report successful changes to the wrong engine.
  if (["/api/auth", "/api/models-config", "/api/plugins", "/api/skills"].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.json({ error: "These legacy editors are not engine-scoped. Manage credentials, models, plugins and skills with the selected local OMP or Pi CLI; the shared legacy settings APIs are disabled." }, { status: 409 });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
