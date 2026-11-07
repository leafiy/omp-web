import { isApiRequestAllowed } from "./request-security";
import { isValidBasicAuthorization, isWebPasswordEnabled } from "./web-auth";

export const historyHeaders = { "Cache-Control": "private, no-store" };
export function guardHistoryRequest(req: Request): Response | undefined {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403, headers: historyHeaders });
  if (isWebPasswordEnabled() && !isValidBasicAuthorization(req.headers.get("authorization"))) return new Response("Authentication required", { status: 401, headers: historyHeaders });
}
