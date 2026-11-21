import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { piWebEvent } = await jiti.import("./pi-rpc-adapter.ts");
const { ompEventNotice } = await jiti.import("./omp-rpc-events.ts");
const { todoGroups } = await jiti.import("./tool-input-diff.ts");
const { getToolPreview } = await jiti.import("./tool-preview.ts");
const { supportsTaskStop } = await jiti.import("./engine.ts");

/** Fake native OMP/Pi RPC client: no process, no model. */
class FakeNative {
  alive = true;
  sent = [];
  subagents = [];
  state = { sessionId: "native-session", sessionFile: "/tmp/fake-native-session.jsonl", isSettled: true };
  onFrame(listener) { this.frameListener = listener; return () => {}; }
  onClose(listener) { this.closeListener = listener; return () => {}; }
  async start() {}
  isAlive() { return this.alive; }
  frame(frame) { this.frameListener(frame); }
  write(frame) { this.sent.push(frame); }
  async request(command, _timeout, id) {
    this.sent.push({ ...command, id });
    if (command.type === "get_state") return this.state;
    if (command.type === "get_session_stats") return {};
    if (command.type === "get_subagents") return { subagents: this.subagents };
    if (command.type === "cancel_subagent") { this.subagents = []; return { cancelled: true }; }
    return undefined;
  }
  async shutdown() { this.alive = false; this.closeListener?.(new Error("closed")); }
  destroy() { void this.shutdown(); }
}

async function fixture(t, engine = "omp") {
  const native = new FakeNative();
  const session = new AgentSessionWrapper({ engine, cwd: "/tmp" }, native);
  const events = [];
  session.onEvent((event) => events.push(event));
  await session.start();
  t.after(() => session.shutdown());
  return { native, session, events };
}

test("OMP stops one reported subagent natively; unknown tasks and Pi are refused", async (t) => {
  const { native, session } = await fixture(t);
  native.subagents = [{ id: "child", agent: "worker", status: "running" }];
  native.frame({ type: "subagent_lifecycle", payload: { id: "child", agent: "worker", status: "started" } });
  await assert.rejects(session.send({ type: "stop_task", taskId: "other" }), /Unknown task/);
  assert.deepEqual(await session.send({ type: "stop_task", taskId: "child" }), { stopped: true });
  assert.ok(native.sent.some((c) => c.type === "cancel_subagent" && c.subagentId === "child"));
  const pi = await fixture(t, "pi");
  await assert.rejects(pi.session.send({ type: "stop_task", taskId: "child" }), /cannot stop an individual task/);
  assert.equal(supportsTaskStop("omp"), true);
  assert.equal(supportsTaskStop("pi"), false);
});

test("OMP fallback and rule events become notices; other frames pass through", async (t) => {
  const { native, events } = await fixture(t);
  native.frame({ type: "retry_fallback_applied", from: "a/x", to: "b/y", role: "default", reason: "overloaded" });
  native.frame({ type: "ttsr_triggered", rules: [{ name: "no-console", path: "/r", content: "..." }] });
  const notices = events.filter((e) => e.type === "extension_ui_request" && e.method === "notify");
  assert.equal(notices[0].notifyType, "warning");
  assert.match(notices[0].message, /from a\/x to b\/y: overloaded/);
  assert.match(notices[1].message, /rule: no-console/);
  assert.ok(!JSON.stringify(notices).includes('"content"'), "rule bodies are not shown");
  assert.equal(ompEventNotice({ type: "ttsr_triggered", rules: [] }), undefined);
  assert.equal(ompEventNotice({ type: "agent_start" }), undefined);
});

test("Pi summary retries use the web retry indicator", () => {
  assert.deepEqual(piWebEvent({ type: "summarization_retry_scheduled", attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded" }),
    { type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "Summary request failed: overloaded" });
  assert.deepEqual(piWebEvent({ type: "summarization_retry_finished" }), { type: "auto_retry_end" });
  assert.equal(piWebEvent({ type: "compaction_start", reason: "threshold" }).type, "auto_compaction_start");
});

test("OMP todo results render their phase snapshot; Claude TodoWrite is unchanged", () => {
  const details = { op: "done", storage: "session", phases: [{ name: "Build", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] }, { name: "Ship", tasks: [{ content: "c", status: "abandoned" }, { content: 3 }] }] };
  assert.deepEqual(todoGroups("todo", { op: "done", task: "a" }, details), [
    { name: "Build", items: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] },
    { name: "Ship", items: [{ content: "c", status: "abandoned" }] },
  ]);
  assert.equal(todoGroups("todo", { op: "view" }, undefined), null);
  assert.deepEqual(todoGroups("TodoWrite", { todos: [{ content: "x", status: "pending" }] }), [{ items: [{ content: "x", status: "pending" }] }]);
  assert.equal(getToolPreview({ toolName: "todo", input: { op: "start", task: "b" } }), "start · b");
});
