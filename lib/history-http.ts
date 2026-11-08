import { isApiRequestAllowed } from "./request-security";
import { isRequestAuthenticated, webAuthRequired } from "./web-auth";

export const historyHeaders = { "Cache-Control": "private, no-store" };
export function guardHistoryRequest(req: Request): Response | undefined {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403, headers: historyHeaders });
  if (!isRequestAuthenticated(req)) return webAuthRequired(historyHeaders);
}
