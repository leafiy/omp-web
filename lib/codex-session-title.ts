import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { object, type CodexFrame, type CodexObject, type CodexTransport } from "./codex-rpc-client";

type TitleSettings = { cwd: string; model: string; modelProvider: string; permissionProfile?: string };

/** Native 0.155.1 tui/src/temporary_structured_request.rs, on a private transport. */
export async function generateCodexSessionTitle(client: CodexTransport, settings: TitleSettings, prompt: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const result = Promise.withResolvers<string>();
  let stopped = false, failure: unknown, threadId = "", turnId = "", response = "";
  const buffered: CodexFrame[] = [];
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true; failure = error;
    result.reject(error);
    client.destroy(); // Dedicated process group: also terminates a turn whose start has not replied.
  };
  const collectItem = (value: unknown) => {
    const item = object(value);
    if (!["userMessage", "agentMessage", "reasoning"].includes(String(item.type))) throw new Error("Codex title generation emitted an unexpected tool or item");
    if (item.type === "agentMessage") {
      if (typeof item.text !== "string" || Buffer.byteLength(item.text) > 8192) throw new Error("Invalid or oversized Codex title response");
      response = item.text;
    }
  };
  const receive = (frame: CodexFrame) => {
    if (stopped) return;
    try {
      if (frame.id !== undefined) {
        client.reject(frame.id, "Session title generation has no tools or interactions");
        throw new Error("Codex title generation requested an unexpected tool or interaction");
      }
      const method = frame.method || "", params = object(frame.params);
      if (/^item\/(commandExecution|fileChange|mcpToolCall|dynamicToolCall|collabAgentToolCall|webSearch|imageGeneration)\//.test(method)) throw new Error("Codex title generation emitted an unexpected tool event");
      if (["item/started", "item/completed"].includes(method) && !["userMessage", "agentMessage", "reasoning"].includes(String(object(params.item).type))) throw new Error("Codex title generation emitted an unexpected tool or item");
      if (params.threadId !== threadId) return;
      if (!turnId) {
        if (buffered.length >= 256) throw new Error("Too many Codex title events before turn acknowledgement");
        buffered.push(frame); return;
      }
      const eventTurn = ["turn/started", "turn/completed"].includes(method) ? object(params.turn).id : params.turnId;
      if (eventTurn !== turnId) return;
      if (method === "item/started") {
        const item = object(params.item);
        if (!["userMessage", "agentMessage", "reasoning"].includes(String(item.type))) throw new Error("Codex title generation started an unexpected tool or item");
      } else if (method === "item/completed") collectItem(params.item);
      else if (method === "turn/completed") {
        const turn = object(params.turn);
        if (turn.status !== "completed") throw new Error(String(object(turn.error).message || `Codex title turn ended with status ${String(turn.status)}`));
        if (Array.isArray(turn.items)) for (const item of turn.items) collectItem(item);
        if (!response.trim()) throw new Error("Codex title generation returned no text");
        stopped = true; result.resolve(response);
      }
    } catch (error) { fail(error); }
  };
  client.onFrame(receive);
  client.onClose(fail);
  const cancel = () => fail(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => fail(new Error("Codex title generation timed out")), 90_000);
  timer.unref();
  const run = async () => {
    if (signal.aborted) cancel();
    if (stopped) throw failure;
    await client.start();
    if (stopped) throw failure;
    const effective = await client.request("config/read", { includeLayers: false, cwd: settings.cwd });
    if (stopped) throw failure;
    if (!effective.config || typeof effective.config !== "object" || Array.isArray(effective.config)) throw new Error("Codex did not return effective title configuration");
    const config = object(effective.config), overrides: CodexObject = {};
    // Match the native ephemeral structured-request recipe. Empty environments remove
    // shell/apply_patch even on models that advertise them; this is not approval denial.
    for (const feature of ["apps", "code_mode", "code_mode_only", "context_management", "current_time_reminder", "deferred_executor", "enable_fanout", "goals", "hooks", "image_generation", "memories", "multi_agent", "multi_agent_v2", "plugins", "request_permissions_tool", "shell_snapshot", "shell_tool", "sleep_tool", "standalone_web_search", "token_budget", "tool_suggest", "unified_exec", "view_image"]) overrides[`features.${feature}`] = false;
    overrides["orchestrator.skills.enabled"] = false;
    overrides["cloud.skills.enabled"] = false;
    overrides["skills.include_instructions"] = false;
    overrides["token_budget.use_history_notes_extension"] = false;
    overrides["tools.experimental_request_user_input.enabled"] = false;
    overrides["tools.update_plan.enabled"] = false;
    overrides.web_search = "disabled";
    overrides.mcp_servers = Object.fromEntries(Object.keys(object(config.mcp_servers)).map(name => [name, { enabled: false }]));
    const customProfile = settings.permissionProfile && !settings.permissionProfile.startsWith(":") ? settings.permissionProfile : undefined;
    const started = await client.request("thread/start", {
      model: settings.model, modelProvider: settings.modelProvider, cwd: settings.cwd,
      ephemeral: true, approvalPolicy: "never", threadSource: "system",
      ...(customProfile ? { permissions: customProfile } : { sandbox: "read-only" }),
      runtimeWorkspaceRoots: [], environments: [], dynamicTools: [], selectedCapabilityRoots: [], config: overrides,
    });
    if (stopped) throw failure;
    const thread = object(started.thread);
    if (typeof thread.id !== "string" || !thread.id || thread.ephemeral !== true || thread.path) throw new Error("Codex did not create an isolated ephemeral title thread");
    threadId = thread.id;
    let returnedCwd: string, expectedCwd: string;
    try { returnedCwd = realpathSync(String(started.cwd)); expectedCwd = realpathSync(settings.cwd); }
    catch { returnedCwd = resolve(String(started.cwd)); expectedCwd = resolve(settings.cwd); }
    if (returnedCwd !== expectedCwd || started.model !== settings.model || started.modelProvider !== settings.modelProvider) throw new Error("Codex title generation changed the native model, provider or working directory");
    if (customProfile ? object(started.activePermissionProfile).id !== customProfile : object(started.sandbox).type !== "readOnly") throw new Error("Codex title generation did not retain restricted permissions");
    const begun = await client.request("turn/start", {
      threadId, model: settings.model, environments: [], runtimeWorkspaceRoots: [],
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    if (stopped) throw failure;
    const turn = object(begun.turn);
    if (typeof turn.id !== "string" || !turn.id) throw new Error("Codex did not acknowledge the title turn identity");
    turnId = turn.id;
    for (const frame of buffered.splice(0)) receive(frame);
    return await result.promise;
  };
  try { return await Promise.race([run(), result.promise]); }
  finally {
    stopped = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    client.destroy(); // No unsubscribe delay, persisted thread, or main-stream listener to retain.
  }
}
