import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FollowUpSession } = await jiti.import("./follow-up-session.ts");
const { parseGeneratedSessionTitle } = await jiti.import("./session-title.ts");

class Native {
  engine = "pi";
  sessionId = "pi:new-title-session";
  sessionFile = "/synthetic/new-session.jsonl";
  cwd = "/synthetic";
  alive = true;
  busy = false;
  name;
  listeners = new Set();
  messages = [];
  requests = [];
  writes = [];
  start = async () => {};
  waitUntilReady = async () => {};
  isAlive = () => this.alive;
  isRunning = () => this.busy;
  getActiveLeafId = () => undefined;
  onDestroy = callback => { this.destroyed = callback; };
  onEvent = callback => { this.listeners.add(callback); return () => this.listeners.delete(callback); };
  emit(event) { for (const listener of this.listeners) listener(event); }
  async send(command) {
    if (command.type === "get_state") return { sessionId: this.sessionId, sessionName: this.name, isStreaming: this.busy, isPromptRunning: this.busy, isSettled: !this.busy };
    if (command.type === "prompt") { this.messages.push({ role: "user", content: command.message }); this.busy = true; return null; }
    if (command.type === "set_session_name") {
      this.name = command.name;
      this.writes.push(command.name);
      this.emit({ type: "session_info_update", sessionId: this.sessionId, title: command.name });
      return null;
    }
    throw new Error(`Unexpected native command ${command.type}`);
  }
  async generateSessionTitle(prompt, signal) {
    this.requests.push({ prompt, signal });
    return new Promise((resolve, reject) => {
      this.resolveTitle = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  finish(text = "Use a session title from the agent, not the user's first question.", extra = {}) {
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra };
    this.messages.push(message);
    this.emit({ type: "message_end", message });
    this.busy = false;
    this.emit({ type: "prompt_done" });
    this.emit({ type: "agent_settled" });
  }
  destroy() { this.alive = false; this.destroyed?.(); }
  async shutdown() { this.destroy(); }
}

function fixture(t, isNew = true) {
  const native = new Native();
  const session = new FollowUpSession(native, () => {}, isNew);
  t.after(() => session.shutdown());
  return { native, session };
}

test("new conversations name themselves once after completion without adding a naming turn to chat", async t => {
  const { native, session } = fixture(t);
  const events = [];
  const detach = session.onEvent(event => events.push(event));
  await session.send({ type: "prompt", message: "How can we fix the conversation list showing my question?" });
  await setImmediate();
  assert.equal(native.requests.length, 0);
  detach();
  native.finish();
  await setImmediate();
  assert.equal(native.requests.length, 1);
  assert.equal(session.isRunning(), true);
  assert.equal((await session.send({ type: "get_state" })).isNamingSession, true);
  const originalMessages = structuredClone(native.messages);
  native.resolveTitle("标题：修复会话列表标题。");
  await setImmediate();
  assert.equal((await session.send({ type: "get_state" })).sessionName, "修复会话列表标题");
  assert.deepEqual(native.messages, originalMessages);
  assert.equal(session.isRunning(), false);
  assert.equal((await session.send({ type: "get_state" })).isNamingSession, false);
  const replay = [];
  session.onEvent(event => replay.push(event))();
  assert.equal(replay.find(event => event.type === "session_info_update")?.title, "修复会话列表标题");
  assert.equal(events.some(event => event.type === "prompt_done"), false, "detached listeners receive no artificial completion");
  await session.send({ type: "prompt", message: "Now handle the mobile layout" });
  native.finish("The mobile layout is corrected.");
  await setImmediate();
  assert.equal(native.requests.length, 1);
});

test("restored conversations never generate or write a title", async t => {
  const { native, session } = fixture(t, false);
  await session.send({ type: "prompt", message: "Continue this old conversation" });
  native.finish();
  await setImmediate();
  assert.deepEqual(native.requests, []);
  assert.deepEqual(native.writes, []);
});

test("an existing native title avoids the extra model request", async t => {
  const { native, session } = fixture(t);
  native.name = "Native generated title";
  await session.send({ type: "prompt", message: "Keep the native title" });
  native.finish();
  await setImmediate();
  assert.deepEqual(native.requests, []);
  assert.deepEqual(native.writes, []);
  assert.equal(native.name, "Native generated title");
});

test("manual rename wins while the naming model is in flight, including an explicit clear", async t => {
  const { native, session } = fixture(t);
  await session.send({ type: "prompt", message: "Name this conversation" });
  native.finish();
  await setImmediate();
  await session.send({ type: "set_session_name", name: "" });
  native.resolveTitle("Late generated title");
  await setImmediate();
  assert.equal(native.requests[0].signal.aborted, true);
  assert.deepEqual(native.writes, [""]);
  assert.equal(native.name, "");
});

test("a native rename discovered after model completion cannot be overwritten", async t => {
  const { native, session } = fixture(t);
  await session.send({ type: "prompt", message: "Name this conversation" });
  native.finish();
  await setImmediate();
  native.name = "Changed outside the web controls";
  native.resolveTitle("Late generated title");
  await setImmediate();
  assert.deepEqual(native.writes, []);
  assert.equal(native.name, "Changed outside the web controls");
});

test("shutdown aborts naming and prevents a late write", async t => {
  const { native, session } = fixture(t);
  await session.send({ type: "prompt", message: "Name this conversation" });
  native.finish();
  await setImmediate();
  await session.shutdown();
  assert.equal(native.requests[0].signal.aborted, true);
  native.resolveTitle("Late generated title");
  await setImmediate();
  assert.deepEqual(native.writes, []);
});

test("invalid model output reports failure instead of using the first question as a title", async t => {
  const { native, session } = fixture(t);
  const events = [];
  session.onEvent(event => events.push(event));
  await session.send({ type: "prompt", message: "Do not copy this as the title" });
  native.finish();
  await setImmediate();
  native.resolveTitle("---");
  await setImmediate();
  assert.deepEqual(native.writes, []);
  assert.equal(events.find(event => event.type === "extension_ui_request")?.notifyType, "warning");
  assert.equal(session.isRunning(), false);
});

const modelUsage = { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };

test("a first turn that is only a skill command with arguments is named from the command and model reply", async t => {
  const { native, session } = fixture(t);
  await session.send({ type: "prompt", message: "/standalone-page image-to-flowchart text-to-flowchart" });
  native.finish("Both standalone flowchart pages are implemented.", modelUsage);
  await setImmediate();
  assert.equal(native.requests.length, 1);
  assert.match(native.requests[0].prompt, /standalone-page image-to-flowchart text-to-flowchart/);
  assert.match(native.requests[0].prompt, /Both standalone flowchart pages are implemented/);
  native.resolveTitle("Standalone flowchart pages");
  await setImmediate();
  assert.deepEqual(native.writes, ["Standalone flowchart pages"]);
});

test("local command output never names a session; the next plain prompt does", async t => {
  const { native, session } = fixture(t);
  await session.send({ type: "prompt", message: "/model claude-test-model" });
  native.finish("Set model to claude-test-model");
  await setImmediate();
  assert.deepEqual(native.requests, []);
  await session.send({ type: "prompt", message: "Fix the sidebar session titles" });
  native.finish("The sidebar now shows native titles.", modelUsage);
  await setImmediate();
  assert.equal(native.requests.length, 1);
  assert.match(native.requests[0].prompt, /Fix the sidebar session titles/);
  assert.doesNotMatch(native.requests[0].prompt, /claude-test-model/);
});

test("a bare command without arguments is not a naming source", async t => {
  const { native, session } = fixture(t);
  await session.send({ type: "prompt", message: "/review" });
  native.finish("Review complete.", modelUsage);
  await setImmediate();
  assert.deepEqual(native.requests, []);
});

test("title normalization handles model wrappers and rejects empty output", () => {
  assert.equal(parseGeneratedSessionTitle('```json\n{"title":"整理 Session 文件夹"}\n```'), "整理 Session 文件夹");
  assert.equal(parseGeneratedSessionTitle('"Improve worktree session grouping"'), "Improve worktree session grouping");
  assert.throws(() => parseGeneratedSessionTitle("```\n---\n```"), /usable session title/);
  assert.equal(Array.from(parseGeneratedSessionTitle("中".repeat(100))).length, 80);
});
