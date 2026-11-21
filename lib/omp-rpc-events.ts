import { randomUUID } from "node:crypto";
import type { AgentFrame } from "./agent-rpc-client";

function clip(value: string, max = 400): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }

/**
 * OMP session events the browser has no dedicated view for, shown as notices.
 * Display only: OMP still owns retry/fallback and rule injection. Returns
 * undefined for frames that are not adapted here.
 */
export function ompEventNotice(frame: AgentFrame): AgentFrame | undefined {
  let message = "", notifyType: "info" | "warning" = "info";
  if (frame.type === "retry_fallback_applied") {
    const reason = clip(text(frame.reason));
    message = `OMP switched ${text(frame.role) || "model"} from ${text(frame.from) || "the configured model"} to ${text(frame.to) || "a fallback"}${reason ? `: ${reason}` : ""}`;
    notifyType = "warning";
  } else if (frame.type === "ttsr_triggered") {
    const names = Array.isArray(frame.rules)
      ? frame.rules.flatMap((rule) => rule && typeof rule === "object" && typeof (rule as { name?: unknown }).name === "string" ? [(rule as { name: string }).name] : [])
      : [];
    if (!names.length) return undefined;
    message = `OMP applied rule${names.length > 1 ? "s" : ""}: ${clip(names.join(", "), 200)}`;
  } else return undefined;
  return { type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType };
}
