import type { Query, SDKControlInterruptResponse } from "@anthropic-ai/claude-agent-sdk";

export function supportsClaudeSteering(capabilities: readonly string[]): boolean {
  return ["msg_lifecycle_v1", "request_marker_lists_v1", "interrupt_cancel_queued_v1"].every((capability) => capabilities.includes(capability));
}

/**
 * SDK 0.3.318's runtime accepts cancelQueued but its published Query signature
 * omits the argument. Keep this compatibility seam narrow and capability-gated.
 * Native loopback tests verify the wire flag and cancellation receipt. Callers
 * must close the query if cancellation is not acknowledged; never assume it.
 */
export function interruptClaude(query: Pick<Query, "interrupt">, cancelQueued: boolean): Promise<SDKControlInterruptResponse | undefined> {
  if (!cancelQueued) return query.interrupt();
  const interrupt = query.interrupt as (options: { cancelQueued: boolean }) => Promise<SDKControlInterruptResponse | undefined>;
  return interrupt.call(query, { cancelQueued: true });
}
