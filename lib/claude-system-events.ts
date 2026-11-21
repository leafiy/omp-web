import { randomUUID } from "node:crypto";
import type { AgentFrame } from "./agent-rpc-client";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function count(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
/** Native output can be large or multi-line; notices are one bounded line. */
function clip(value: string, max = 400): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function notify(message: string, notifyType: "info" | "warning" | "error" = "info"): AgentFrame {
  return { type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType };
}
function status(statusKey: string, statusText?: string): AgentFrame {
  return { type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, ...(statusText !== undefined ? { statusText } : {}) };
}

const RETRY_ERRORS: Record<string, string> = {
  rate_limit: "rate limited",
  overloaded: "API overloaded",
  server_error: "server error",
  authentication_failed: "authentication failed",
  billing_error: "billing error",
  invalid_request: "invalid request",
  model_not_found: "model not found",
  unknown: "request failed",
};

/**
 * Maps Claude Code's native system frames (compaction, API retries, hooks,
 * notifications, automatic denials, refusal fallbacks) to the web's existing
 * event vocabulary. Display only: nothing here changes native behavior.
 */
export class ClaudeSystemEvents {
  private compactionOpen = false;
  private compactionTrigger = "auto";
  private retrying = false;
  private hooks = new Map<string, string>();

  get isCompacting(): boolean { return this.compactionOpen; }

  consume(raw: Record<string, unknown>): AgentFrame[] {
    const events: AgentFrame[] = [];
    // Any model output or turn result means a pending API retry has resolved.
    if (this.retrying && (raw.type === "assistant" || raw.type === "stream_event" || raw.type === "result")) {
      this.retrying = false;
      events.push({ type: "auto_retry_end" });
    }
    if (raw.type === "result" && this.compactionOpen) {
      // A turn cannot settle while compaction is still running natively.
      this.compactionOpen = false;
      events.push({ type: "compaction_end", reason: this.compactionTrigger, aborted: true });
    }
    if (raw.type !== "system" || raw.parent_tool_use_id) return events;
    switch (raw.subtype) {
      case "status": {
        if (raw.status === "compacting") {
          if (!this.compactionOpen) {
            this.compactionOpen = true;
            this.compactionTrigger = "auto";
            events.push({ type: "compaction_start", reason: "auto" });
          }
        } else if (this.compactionOpen) {
          this.compactionOpen = false;
          if (raw.compact_result === "failed") {
            events.push({ type: "compaction_end", reason: this.compactionTrigger, errorMessage: text(raw.compact_error) || "Claude Code compaction failed" });
          } else {
            events.push({ type: "compaction_end", reason: this.compactionTrigger });
          }
        } else if (raw.compact_result === "failed") {
          events.push({ type: "compaction_end", reason: this.compactionTrigger, errorMessage: text(raw.compact_error) || "Claude Code compaction failed" });
        }
        break;
      }
      case "compact_boundary": {
        const metadata = record(raw.compact_metadata);
        const trigger = metadata.trigger === "manual" ? "manual" : "auto";
        const tokensBefore = count(metadata.pre_tokens);
        const tokensAfter = count(metadata.post_tokens);
        this.compactionTrigger = trigger;
        this.compactionOpen = false;
        events.push({
          type: "compaction_end",
          reason: trigger,
          // Only native counts; when the CLI omits post_tokens the UI shows no estimate.
          ...(tokensBefore !== undefined && tokensAfter !== undefined ? { result: { tokensBefore, estimatedTokensAfter: tokensAfter } } : {}),
        });
        break;
      }
      case "api_retry": {
        this.retrying = true;
        const reason = RETRY_ERRORS[text(raw.error)] ?? (text(raw.error) || "request failed");
        const statusCode = count(raw.error_status);
        const delay = count(raw.retry_delay_ms);
        events.push({
          type: "auto_retry_start",
          attempt: count(raw.attempt) ?? 1,
          maxAttempts: count(raw.max_retries) ?? 0,
          errorMessage: `${reason}${statusCode ? ` (HTTP ${statusCode})` : ""}${delay ? ` · retrying in ${Math.ceil(delay / 1000)}s` : ""}`,
        });
        break;
      }
      case "hook_started": {
        const id = text(raw.hook_id);
        if (!id) break;
        const label = [text(raw.hook_event), text(raw.hook_name)].filter(Boolean).join(" · ") || "hook";
        this.hooks.set(id, label);
        events.push(status(`claude-hook:${id}`, `Hook ${label} running…`));
        break;
      }
      case "hook_response": {
        const id = text(raw.hook_id);
        const label = this.hooks.get(id) ?? ([text(raw.hook_event), text(raw.hook_name)].filter(Boolean).join(" · ") || "hook");
        if (id) {
          this.hooks.delete(id);
          events.push(status(`claude-hook:${id}`));
        }
        if (raw.outcome === "error") {
          const detail = clip(text(raw.stderr) || text(raw.output) || text(raw.stdout));
          const code = count(raw.exit_code);
          events.push(notify(`Claude Code hook ${label} failed${code !== undefined ? ` (exit ${code})` : ""}${detail ? `: ${detail}` : ""}`, "warning"));
        }
        break;
      }
      case "notification": {
        const message = clip(text(raw.text), 600);
        if (message) events.push(notify(message, raw.priority === "high" || raw.priority === "immediate" ? "warning" : "info"));
        break;
      }
      case "informational": {
        const message = clip(text(raw.content), 600);
        if (message) events.push(notify(message, raw.level === "warning" ? "warning" : "info"));
        break;
      }
      case "permission_denied": {
        const reason = clip(text(raw.decision_reason) || text(raw.message));
        events.push(notify(`Claude Code denied ${text(raw.tool_name) || "a tool"} automatically${reason ? `: ${reason}` : ""}`, "warning"));
        break;
      }
      case "model_refusal_fallback": {
        const from = text(raw.original_model), to = text(raw.fallback_model);
        const explanation = clip(text(raw.api_refusal_explanation));
        events.push(notify(raw.direction === "revert"
          ? `Claude Code returned to ${from || "the original model"}`
          : `${from || "The model"} declined; Claude Code continued with ${to || "a fallback model"}${explanation ? ` (${explanation})` : ""}`, "warning"));
        break;
      }
      case "model_refusal_no_fallback": {
        const explanation = clip(text(raw.api_refusal_explanation) || text(raw.content));
        events.push(notify(`${text(raw.original_model) || "The model"} declined this request${explanation ? `: ${explanation}` : ""}`, "warning"));
        break;
      }
      case "session_writes_lost": {
        const lost = Array.isArray(raw.lost) ? raw.lost.filter((item): item is string => typeof item === "string").join(", ") : "";
        events.push(notify(`Claude Code could not save ${lost || "session data"} (${text(raw.error_code) || "disk error"}); free disk space before continuing.`, "error"));
        break;
      }
    }
    return events;
  }

  /** Clear transient status rows when the native process stops or a turn ends. */
  reset(): AgentFrame[] {
    const events: AgentFrame[] = [...this.hooks.keys()].map((id) => status(`claude-hook:${id}`));
    this.hooks.clear();
    if (this.retrying) { this.retrying = false; events.push({ type: "auto_retry_end" }); }
    if (this.compactionOpen) { this.compactionOpen = false; events.push({ type: "compaction_end", reason: this.compactionTrigger, aborted: true }); }
    return events;
  }
}
