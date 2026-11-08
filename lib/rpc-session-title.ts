import { randomUUID } from "node:crypto";
import { AgentRpcClient, type AgentFrame, type AgentProcessOptions } from "./agent-rpc-client";
import { parseEngine } from "./engine";

const TITLE_TIMEOUT_MS = 90_000;
type TitleClient = Pick<AgentRpcClient, "engine" | "start" | "request" | "onFrame" | "onClose" | "destroy" | "shutdown">;
type TitleClientFactory = (options: AgentProcessOptions) => TitleClient;

/**
 * Run one ephemeral, tool-denied conversation through the selected native CLI.
 * Returns raw model text; only the original session's owner may save its name.
 */
export async function generateRpcSessionTitle(
  options: AgentProcessOptions,
  prompt: string,
  signal: AbortSignal,
  createClient: TitleClientFactory = (settings) => new AgentRpcClient(settings),
): Promise<string> {
  signal.throwIfAborted();
  const engine = parseEngine(options.engine);
  if (engine !== "omp" && engine !== "pi") throw new Error(`${engine} does not use OMP/Pi title RPC`);
  const initialModel = options.initialModel;
  if (!initialModel) throw new Error("Native title generation requires the conversation's active model");
  if (!prompt.trim()) throw new Error("Native title generation requires a prompt");

  // Deliberately select fields rather than forwarding sessionFile/catalog flags.
  const client = createClient({
    cwd: options.cwd,
    engine,
    initialModel,
    thinkingLevel: options.thinkingLevel,
    titleOnly: true,
  });
  const completion = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<never>();
  // Events can settle these promises while startup or admission is still pending.
  void completion.promise.catch(() => {});
  void interrupted.promise.catch(() => {});
  let prompting = false;
  let assistantFailure: string | undefined;
  const promptId = randomUUID();
  const abort = () => {
    interrupted.reject(signal.reason instanceof Error ? signal.reason : new DOMException("Title generation was aborted", "AbortError"));
    client.destroy();
  };
  const timeout = setTimeout(() => {
    interrupted.reject(new Error("Native title generation timed out"));
    client.destroy();
  }, TITLE_TIMEOUT_MS);
  timeout.unref();
  const offClose = client.onClose((error) => interrupted.reject(error));
  const offFrame = client.onFrame((frame: AgentFrame) => {
    if (!prompting) return;
    if (frame.type === "message_end" && frame.message && typeof frame.message === "object") {
      const message = frame.message as { role?: string; stopReason?: string; errorMessage?: string; content?: { type?: string }[] };
      if (message.role === "assistant") {
        assistantFailure = message.stopReason === "error" || message.stopReason === "aborted"
          ? message.errorMessage || `Native title response ${message.stopReason}` : undefined;
        if (Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall")) {
          completion.reject(new Error("Native title response attempted tool use"));
        }
      }
    }
    if (engine === "omp" && frame.type === "prompt_result" && frame.id === promptId) {
      if (frame.status === "completed" && frame.agentInvoked === true) completion.resolve();
      else {
        const error = frame.error as { message?: string } | undefined;
        completion.reject(new Error(error?.message || `OMP title prompt ${String(frame.status)}`));
      }
    } else if (engine === "pi" && frame.type === "agent_settled") {
      // Pi's prompt response acknowledges admission; agent_end can precede retries.
      if (frame.aborted === true || assistantFailure) completion.reject(new Error(assistantFailure || "Pi title prompt was aborted"));
      else completion.resolve();
    }
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  try {
    return await Promise.race([
      (async () => {
        // titleOnly start also waits for the native guard's empty-tool attestation.
        await client.start();
        const state = await client.request<{
          model?: { provider?: string; id?: string };
          sessionFile?: string;
          dumpTools?: unknown[];
        }>({ type: "get_state" });
        if (state.sessionFile) throw new Error("Native title process unexpectedly persists a session");
        if (state.model?.provider !== initialModel.provider || state.model.id !== initialModel.modelId) {
          throw new Error("Native title process did not select the conversation's active model");
        }
        // OMP advertises model-invocable tools in get_state. Pi's native RPC omits
        // this field; its guard attestation uses pi.getActiveTools() instead.
        if (engine === "omp" && (!Array.isArray(state.dumpTools) || state.dumpTools.length !== 0)) {
          throw new Error("OMP title process still exposes tools");
        }
        signal.throwIfAborted();
        prompting = true;
        const admitted = client.request<{ agentInvoked?: boolean; disposition?: string }>({ type: "prompt", message: prompt }, 0, promptId)
          .then((ack) => {
            if (engine === "omp" && ack?.agentInvoked === false) throw new Error("OMP handled the title prompt without invoking the model");
            if (engine === "pi" && ack?.disposition !== "started") throw new Error("Pi did not start the isolated title prompt");
          });
        await Promise.all([admitted, completion.promise]);
        if (assistantFailure) throw new Error(assistantFailure);
        const result = await client.request<{ text?: string }>({ type: "get_last_assistant_text" });
        if (typeof result.text !== "string" || !result.text.trim()) throw new Error("Native title model returned no text");
        return result.text;
      })(),
      interrupted.promise,
    ]);
  } catch (error) {
    client.destroy();
    throw error;
  } finally {
    try { await client.shutdown(); }
    finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      offFrame();
      offClose();
    }
  }
}
