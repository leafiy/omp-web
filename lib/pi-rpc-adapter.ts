import type { AgentFrame } from "./agent-rpc-client";

const PI_COMMANDS: Readonly<Record<string, true>> = {
  prompt: true, steer: true, follow_up: true, abort: true,
  set_model: true, cycle_model: true, get_available_models: true,
  set_thinking_level: true, cycle_thinking_level: true, get_available_thinking_levels: true,
  set_steering_mode: true, set_follow_up_mode: true,
  compact: true, set_auto_compaction: true, set_auto_retry: true, abort_retry: true,
  bash: true, abort_bash: true, get_session_stats: true, export_html: true,
  get_fork_messages: true, get_entries: true, get_tree: true,
  get_last_assistant_text: true, set_session_name: true,
  get_messages: true, get_state: true, get_commands: true,
};

/** Command subset implemented by the web Pi adapter; native Pi may support more. */
export function piWireCommand(command: Record<string, unknown>): Record<string, unknown> {
  const type = String(command.type);
  if (type === "fork") {
    if (!command.entryId) return { type: "clone" };
    if (command.includeEntry === true) throw new Error("Pi RPC can clone the current leaf or fork before a message, but cannot fork including an arbitrary entry");
    return { type: "fork", entryId: command.entryId };
  }
  if (!Object.hasOwn(PI_COMMANDS, type)) {
    throw new Error(`The web Pi adapter does not support '${type}'. Use the local Pi terminal for this operation.`);
  }
  return command;
}

/** Pi uses one compaction event family with a reason; the web distinguishes auto. */
export function piWebEvent(frame: AgentFrame): AgentFrame {
  if ((frame.type === "compaction_start" || frame.type === "compaction_end") && frame.reason !== "manual") {
    return { ...frame, type: frame.type === "compaction_start" ? "auto_compaction_start" : "auto_compaction_end" };
  }
  return frame;
}
