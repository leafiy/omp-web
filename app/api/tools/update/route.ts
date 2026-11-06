import { getToolUpdateView, startToolUpdate } from "@/lib/tool-update";
import { createToolUpdateHandlers } from "@/lib/tool-update-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = createToolUpdateHandlers({ getStatus: getToolUpdateView, start: startToolUpdate });
export const GET = handlers.GET;
export const POST = handlers.POST;
