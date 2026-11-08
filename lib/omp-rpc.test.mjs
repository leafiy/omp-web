import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentFrameDecoder, AgentRpcClient } = await jiti.import("./agent-rpc-client.ts");
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { openSessionManager, buildSessionContext } = await jiti.import("./session-reader.ts");
const { getPiAgentDir } = await jiti.import("./engine-paths.ts");

function line(frame) { return Buffer.from(JSON.stringify(frame) + "\n"); }

function chunkFrames(frame, split = 10) {
  const bytes = Buffer.from(JSON.stringify(frame));
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += split) parts.push(bytes.subarray(offset, offset + split));
  return parts.map((part, index) => ({ type: "rpc_chunk", chunkId: "chunk-1", index, count: parts.length, byteLength: bytes.length, data: part.toString("base64") }));
}

test("JSONL preserves split UTF-8 and embedded Unicode line separators", () => {
  const decoder = new AgentFrameDecoder();
  const frames = [];
  const expected = { type: "message_update", text: "中文\u2028still one frame\nnext line" };
  for (const byte of line(expected)) decoder.push(Buffer.from([byte]), (frame) => frames.push(frame));
  decoder.finish();
  assert.deepEqual(frames, [expected]);
});

test("v2 reassembles chunks before dispatch and rejects invalid/interleaved sequences", () => {
  const expected = { type: "response", id: "r", success: true, data: "你好".repeat(100) };
  const frames = chunkFrames(expected);
  const decoder = new AgentFrameDecoder();
  const received = [];
  frames.forEach((frame) => decoder.push(line(frame), (item) => received.push(item)));
  assert.deepEqual(received, [expected]);
  decoder.finish();
  for (const invalid of [
    { ...frames[0], index: 1 },
    { ...frames[0], byteLength: 100_000_000 },
    { ...frames[0], data: "not base64!" },
  ]) assert.throws(() => new AgentFrameDecoder().push(line(invalid), () => {}));
  const interrupted = new AgentFrameDecoder();
  interrupted.push(line(frames[0]), () => {});
  assert.throws(() => interrupted.push(line({ type: "agent_end" }), () => {}), /Interrupted/);
  const unfinished = new AgentFrameDecoder();
  unfinished.push(line(frames[0]), () => {});
  assert.throws(() => unfinished.finish(), /middle/);
});

test("physical frames are bounded, malformed JSON and truncated UTF-8 fail closed", () => {
  const decoder = new AgentFrameDecoder();
  decoder.maxFrameBytes = 10;
  assert.throws(() => decoder.push(Buffer.from("x".repeat(11)), () => {}), /limit/);
  assert.throws(() => new AgentFrameDecoder().push(Buffer.from("{bad}\n"), () => {}));
  assert.throws(() => new AgentFrameDecoder().push(Buffer.from([0xff, 10]), () => {}));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.sent = [];
  child.stdin.on("data", (bytes) => child.sent.push(JSON.parse(bytes.toString())));
  child.frame = (frame) => child.stdout.write(line(frame));
  child.kill = () => { child.exitCode = 0; child.emit("close", 0, null); return true; };
  child.stdin.once("finish", () => child.kill());
  return child;
}

test("transport launches ONLY OMP without a shell and correlates out-of-order replies", async () => {
  const child = fakeChild();
  let launch;
  const client = new AgentRpcClient({ cwd: "/tmp", sessionFile: "/tmp/a b.jsonl", initialModel: { provider: "p", modelId: "m" } }, (...args) => { launch = args; return child; });
  try {
    child.frame({ type: "ready", supportedProtocolVersions: [1] });
    await client.start();
    assert.equal(launch[2].shell, false);
    assert.deepEqual(launch[1], ["--mode", "rpc-ui", "--resume", "/tmp/a b.jsonl", "--model", "p/m"]);
    assert.ok(!launch[0].endsWith("/pi"));
    const first = client.request({ type: "get_state" });
    const second = client.request({ type: "get_available_models" });
    child.frame({ type: "response", id: child.sent[1].id, success: true, data: { models: [] } });
    child.frame({ type: "response", id: child.sent[0].id, success: true, data: { sessionId: "native" } });
    assert.deepEqual(await first, { sessionId: "native" });
    assert.deepEqual(await second, { models: [] });
    client.write({ type: "extension_ui_response", id: "dialog-7", cancelled: true });
    assert.equal(child.sent.at(-1).id, "dialog-7");
  } finally { await client.shutdown(); }
});

test("spawn failure rejects readiness and never falls back to Pi", async () => {
  const child = fakeChild();
  let launches = 0;
  const client = new AgentRpcClient({ cwd: "/tmp" }, () => { launches++; return child; });
  child.emit("error", new Error("ENOENT"));
  await assert.rejects(client.start(), /Cannot start local OMP/);
  await client.shutdown();
  assert.equal(launches, 1);
});

test("v2 negotiation precedes queries and process exit rejects pending requests", async () => {
  const child = fakeChild();
  const client = new AgentRpcClient({ cwd: "/tmp", catalogOnly: true }, () => child);
  child.frame({ type: "ready", supportedProtocolVersions: [1, 2] });
  const started = client.start();
  await Promise.resolve();
  assert.equal(child.sent[0].type, "negotiate_protocol");
  child.frame({ type: "response", id: child.sent[0].id, command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
  await started;
  const pending = client.request({ type: "get_state" });
  child.kill();
  await assert.rejects(pending, /OMP exited/);
  await client.shutdown();
});

test("Pi uses the configured local executable with isolated config and a get_state handshake", async (t) => {
  const previousExecutable = process.env.OMP_WEB_PI_EXECUTABLE;
  process.env.OMP_WEB_PI_EXECUTABLE = "/tmp/local pi";
  t.after(() => {
    if (previousExecutable === undefined) delete process.env.OMP_WEB_PI_EXECUTABLE;
    else process.env.OMP_WEB_PI_EXECUTABLE = previousExecutable;
  });
  const child = fakeChild();
  let launch;
  const client = new AgentRpcClient({ engine: "pi", cwd: "/tmp", sessionFile: "/tmp/pi exact.jsonl" }, (...args) => { launch = args; return child; });
  try {
    const started = client.start();
    assert.equal(launch[0], "/tmp/local pi");
    assert.deepEqual(launch[1], ["--mode", "rpc", "--session", "/tmp/pi exact.jsonl"]);
    assert.equal(launch[2].env.PI_CODING_AGENT_DIR, getPiAgentDir());
    assert.equal(launch[2].env.OMP_CODING_AGENT_DIR, undefined);
    assert.equal(launch[2].shell, false);
    assert.equal(child.sent[0].type, "get_state");
    child.frame({ type: "response", id: child.sent[0].id, command: "get_state", success: true, data: { sessionId: "pi-native" } });
    await started;
    assert.equal(child.sent.length, 1);
  } finally { await client.shutdown(); }
});

test("Pi catalog never persists or negotiates OMP framing, and fails without fallback", async () => {
  const child = fakeChild();
  let launch;
  let launches = 0;
  const client = new AgentRpcClient({ engine: "pi", cwd: "/tmp", catalogOnly: true }, (...args) => { launch = args; launches++; return child; });
  const started = client.start();
  assert.deepEqual(launch[1], ["--mode", "rpc", "--no-session"]);
  child.emit("error", new Error("Pi unavailable"));
  await assert.rejects(started, /Cannot start local Pi/);
  await client.shutdown();
  assert.equal(launches, 1);
  assert.throws(() => new AgentFrameDecoder(false).push(line(chunkFrames({ type: "agent_end" })[0]), () => {}), /Pi RPC does not support/);
});

class FakeOmp {
  alive = true;
  sent = [];
  subagents = [];
  state = { sessionId: "native-session", sessionFile: "/tmp/fake-omp-session.jsonl", isSettled: true, systemPrompt: ["native", "tools"], dumpTools: [{ name: "task", description: "OMP subagents" }] };
  onFrame(listener) { this.frameListener = listener; return () => {}; }
  onClose(listener) { this.closeListener = listener; return () => {}; }
  async start() {}
  isAlive() { return this.alive; }
  frame(frame) { this.frameListener(frame); }
  write(frame) { this.sent.push(frame); }
  async request(command, _timeout, id) {
    this.sent.push({ ...command, id });
    if (command.type === "get_state") return this.state;
    if (command.type === "get_subagents") return { subagents: this.subagents };
    if (command.type === "branch" || command.type === "fork") {
      this.state = { ...this.state, sessionId: "forked", sessionFile: "/tmp/fake-omp-fork.jsonl" };
      return { cancelled: false };
    }
    return undefined;
  }
  async shutdown() { this.alive = false; this.closeListener(new Error("closed")); }
  destroy() { void this.shutdown(); }
}

async function wrapperFixture(t) {
  const native = new FakeOmp();
  const session = new AgentSessionWrapper({ cwd: "/tmp" }, native);
  const events = [];
  session.onEvent((event) => events.push(event));
  await session.start();
  t.after(() => session.shutdown());
  return { native, session, events };
}

test("native title updates invalidate sidebar metadata without completing the prompt", async t => {
  const { native, session, events } = await wrapperFixture(t);
  await session.send({ type: "prompt", message: "work" });
  const cached = { data: [], ts: Date.now() };
  globalThis.__piSessionListCache = cached;
  t.after(() => { globalThis.__piSessionListCache = undefined; });
  native.frame({ type: "session_info_update", sessionId: "another-session", title: "Unrelated" });
  assert.equal(globalThis.__piSessionListCache, cached);
  assert.equal(events.some(event => event.type === "session_info_update"), false);

  native.frame({ type: "session_info_update", sessionId: "native-session", title: "Agent title" });
  assert.equal(globalThis.__piSessionListCache, undefined);
  assert.equal(events.find(event => event.type === "session_info_update")?.title, "Agent title");
  assert.equal(session.isRunning(), true);
  assert.equal(events.some(event => event.type === "prompt_done" || event.type === "agent_settled"), false);

  globalThis.__piSessionListCache = cached;
  native.frame({ type: "session_info_update", sessionId: "native-session" });
  assert.equal(globalThis.__piSessionListCache, undefined);
  assert.equal(events.at(-1).title, "");
  const replay = [];
  session.onEvent(event => replay.push(event))();
  assert.equal(replay.find(event => event.type === "session_info_update")?.title, "");
});

test("state reconciliation discovers generated titles without replacing a newer title event", async t => {
  const { native, session, events } = await wrapperFixture(t);
  const cached = { data: [], ts: Date.now() };
  globalThis.__piSessionListCache = cached;
  t.after(() => { globalThis.__piSessionListCache = undefined; });
  native.state = { ...native.state, sessionName: "Generated asynchronously" };
  assert.equal((await session.send({ type: "get_state" })).sessionName, "Generated asynchronously");
  assert.equal(globalThis.__piSessionListCache, undefined);
  assert.equal(events.find(event => event.type === "session_info_update")?.title, "Generated asynchronously");

  const request = native.request.bind(native);
  native.request = async (...args) => {
    const snapshot = await request(...args);
    if (args[0].type === "get_state") {
      native.frame({ type: "session_info_update", sessionId: "native-session", title: "Newer title" });
    }
    return snapshot;
  };
  assert.equal((await session.send({ type: "get_state" })).sessionName, "Newer title");
  assert.equal(events.filter(event => event.type === "session_info_update").at(-1)?.title, "Newer title");
});

test("OMP subscribes to native child progress and replays tasks after parent settlement", async t => {
  const { native, session } = await wrapperFixture(t);
  assert.ok(native.sent.some(c => c.type === "set_subagent_subscription" && c.level === "progress"));
  native.subagents = [{ id: "child", agent: "worker", status: "running" }];
  native.frame({ type: "subagent_lifecycle", payload: { id: "child", agent: "worker", status: "started" } });
  native.frame({ type: "session_settled" });
  assert.equal(session.isRunning(), true);
  assert.equal((await session.send({ type: "get_state" })).tasks.tasks[0].active, true);
  const replay = []; session.onEvent(e => replay.push(e))();
  assert.equal(replay[0].type, "task_snapshot");
  native.frame({ type: "subagent_lifecycle", payload: { id: "child", status: "completed" } });
  native.subagents = [];
  assert.equal(session.isRunning(), false);
});

test("prompt acceptance/yield/settled are distinct; background work stays busy", async (t) => {
  const { native, session, events } = await wrapperFixture(t);
  await session.send({ type: "prompt", message: "work" });
  const id = native.sent.at(-1).id;
  assert.equal(session.isRunning(), true);
  native.frame({ type: "agent_start" });
  native.frame({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true });
  assert.ok(!events.some((event) => event.type === "prompt_done"));
  native.frame({ type: "prompt_result", id, status: "completed", sessionSettled: false });
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(session.isRunning(), true);
  native.frame({ type: "session_settled" });
  assert.equal(session.isRunning(), false);
  assert.equal(events.at(-1).type, "agent_settled");
});

test("a state response cannot erase a newer activity event", async (t) => {
  const { native, session } = await wrapperFixture(t);
  const request = native.request.bind(native);
  native.request = async (...args) => {
    const snapshot = await request(...args);
    if (args[0].type === "get_state") native.frame({ type: "agent_start" });
    return snapshot;
  };
  const state = await session.send({ type: "get_state" });
  assert.equal(state.isPromptRunning, true);
  assert.equal(session.isRunning(), true);
});

test("local-only command responses and late results cannot complete a newer prompt", async (t) => {
  const { native, session, events } = await wrapperFixture(t);
  await session.send({ type: "prompt", message: "/status" });
  const oldId = native.sent.at(-1).id;
  native.frame({ type: "response", command: "prompt", id: oldId, success: true, data: { agentInvoked: false } });
  assert.equal(session.isRunning(), false);
  await session.send({ type: "prompt", message: "new task" });
  native.frame({ type: "agent_start" });
  native.frame({ type: "prompt_result", id: oldId, status: "completed", sessionSettled: true });
  assert.equal(session.isRunning(), true);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
});

test("native state exposes native tools and joins prompt blocks; UI ids are preserved", async (t) => {
  const { native, session, events } = await wrapperFixture(t);
  assert.equal((await session.send({ type: "get_state" })).systemPrompt, "native\n\ntools");
  assert.equal((await session.send({ type: "get_tools" }))[0].name, "task");
  await assert.rejects(session.send({ type: "set_tools", toolNames: [] }), /local OMP configuration/);
  native.frame({ type: "extension_ui_request", method: "confirm", id: "approval", title: "Approve?", message: "write" });
  const replay = [];
  session.onEvent((event) => replay.push(event))();
  assert.equal(replay.find(event => event.type === "extension_ui_request")?.id, "approval");
  await session.send({ type: "extension_ui_response", id: "approval", confirmed: false });
  assert.deepEqual(native.sent.at(-1), { type: "extension_ui_response", id: "approval", confirmed: false });
  native.frame({ type: "manual_compaction_start" });
  assert.equal(events.at(-1).type, "compaction_start");
});

test("fork-before-message uses native branch and disposes the mutated process", async (t) => {
  const { native, session } = await wrapperFixture(t);
  const result = await session.send({ type: "fork", entryId: "user-entry" });
  assert.ok(native.sent.some((command) => command.type === "branch" && command.entryId === "user-entry"));
  assert.equal(result.newSessionId, "forked");
  assert.equal(session.isAlive(), false);
});

test("history browsing never rewrites OMP title slots and adapts model roles/leaf metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-web-history-"));
  const file = join(directory, "session.jsonl");
  const entries = [
    { type: "title", v: 1, title: "Native title", pad: "    " },
    { type: "session", version: 3, id: "native", cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z" },
    { type: "model_change", id: "model", parentId: null, model: "provider/model", role: "default" },
    { type: "message", id: "user", parentId: "model", message: { role: "user", content: "hello" } },
    { type: "model_change", id: "small", parentId: "user", model: "provider/small", role: "smol" },
    { type: "model_usage", id: "late", parentId: "small", activeLeafId: "user" },
  ];
  const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  try {
    await writeFile(file, original);
    const view = openSessionManager(file);
    assert.equal(view.getSessionName(), "Native title");
    assert.equal(view.getLeafId(), "user");
    const context = buildSessionContext(view.getEntries(), "small");
    assert.deepEqual(context.model, { provider: "provider", modelId: "model" });
    assert.deepEqual(context.entryIds, ["user"]);
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

class FakePi extends FakeOmp {
  state = { sessionId: "pi-native", sessionFile: "/tmp/fake-pi-session.jsonl", isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  async request(command, timeout, id) {
    if (command.type === "prompt") {
      this.sent.push({ ...command, id });
      if (command.message !== "/local") {
        this.state = { ...this.state, isStreaming: true };
        this.frame({ type: "agent_start" });
      }
      this.frame({ type: "response", command: "prompt", id, success: true });
      return undefined;
    }
    if (command.type === "clone") {
      this.sent.push({ ...command, id });
      this.state = { ...this.state, sessionId: "pi-cloned", sessionFile: "/tmp/fake-pi-cloned.jsonl" };
      return { cancelled: false };
    }
    if (command.type === "get_commands") {
      this.sent.push({ ...command, id });
      return { commands: [{ name: "native-command", source: "extension" }] };
    }
    return super.request(command, timeout, id);
  }
}

async function piFixture(t) {
  const native = new FakePi();
  const session = new AgentSessionWrapper({ engine: "pi", cwd: "/tmp" }, native);
  const events = [];
  session.onEvent((event) => events.push(event));
  await session.start();
  t.after(() => session.shutdown());
  return { native, session, events };
}

test("Pi acceptance and retry yields stay busy until native agent_settled", async (t) => {
  const { native, session, events } = await piFixture(t);
  await session.send({ type: "prompt", message: "work" });
  native.frame({ type: "agent_end", willRetry: true, messages: [] });
  native.frame({ type: "auto_retry_start", attempt: 1, delayMs: 10 });
  assert.equal(session.isRunning(), true);
  assert.equal((await session.send({ type: "get_state" })).isPromptRunning, true);
  assert.ok(!events.some((event) => event.type === "prompt_done"));
  native.frame({ type: "auto_retry_end", success: true });
  native.state = { ...native.state, isStreaming: false };
  native.frame({ type: "agent_settled" });
  assert.equal(session.isRunning(), false);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(events.at(-1).type, "agent_settled");
});

test("Pi local command completion, queue events, compaction and namespaced state stay native", async (t) => {
  const { native, session, events } = await piFixture(t);
  assert.equal(session.sessionId, "pi:pi-native");
  assert.equal((await session.send({ type: "get_state" })).engine, "pi");
  await session.send({ type: "prompt", message: "/local" });
  assert.equal(session.isRunning(), false);
  assert.ok(events.some((event) => event.type === "prompt_done"));
  native.frame({ type: "queue_update", steering: ["one"], followUp: ["two"] });
  native.state = { ...native.state, pendingMessageCount: 2 };
  const state = await session.send({ type: "get_state" });
  assert.deepEqual(state.queuedMessages, { steering: ["one"], followUp: ["two"] });
  assert.equal(state.pendingMessageCount, 2);
  native.frame({ type: "compaction_start", reason: "overflow" });
  assert.equal(events.at(-1).type, "auto_compaction_start");
  native.frame({ type: "compaction_end", reason: "overflow", aborted: false });
  assert.equal(events.at(-1).type, "auto_compaction_end");
  const commands = await session.send({ type: "get_commands" });
  assert.equal(commands.commands[0].source, "pi");
  assert.equal(commands.commands[0].nativeSource, "extension");
});

test("Pi forks before messages, clones the current session, and returns web IDs", async (t) => {
  const before = await piFixture(t);
  const result = await before.session.send({ type: "fork", entryId: "user-entry" });
  assert.ok(before.native.sent.some((command) => command.type === "fork" && command.entryId === "user-entry"));
  assert.equal(result.newSessionId, "pi:forked");
  assert.equal(before.session.isAlive(), false);
  const whole = await piFixture(t);
  const cloned = await whole.session.send({ type: "fork", includeEntry: true });
  assert.ok(whole.native.sent.some((command) => command.type === "clone"));
  assert.equal(cloned.sessionId, "pi:pi-cloned");
  assert.equal(whole.session.isAlive(), false);
});

test("task details enforce ownership and keep native OMP and Pi transcript sources separate", async t => {
  const { native, session } = await wrapperFixture(t);
  const before = native.sent.length;
  await assert.rejects(session.send({ type: "get_task_detail", taskId: "foreign" }), /Unknown task/);
  assert.equal(native.sent.length, before);
  native.frame({ type: "subagent_lifecycle", payload: { id: "child", status: "started", agent: "worker" } });
  const request = native.request.bind(native);
  native.request = async (command, ...args) => {
    if (command.type === "get_subagent_messages") {
      assert.equal(command.subagentId, "child");
      assert.equal(command.sessionFile, undefined);
      return { messages: [{ role: "assistant", content: "OMP CHILD" }] };
    }
    return request(command, ...args);
  };
  assert.equal((await session.send({ type: "get_task_detail", taskId: "child" })).messages[0].text, "OMP CHILD");
  const piNative = new FakePi();
  const pi = new AgentSessionWrapper({ engine: "pi", cwd: "/tmp" }, piNative);
  await pi.start(); t.after(() => pi.shutdown());
  piNative.frame({ type: "tool_execution_start", toolName: "subagent", toolCallId: "call" });
  piNative.frame({ type: "tool_execution_update", toolCallId: "call", partialResult: { details: { mode: "single", results: [{ agent: "worker", exitCode: 0, messages: [{ role: "assistant", content: "PI CHILD" }] }] } } });
  const sent = piNative.sent.length;
  assert.equal((await pi.send({ type: "get_task_detail", taskId: "call:0" })).messages[0].text, "PI CHILD");
  assert.equal(piNative.sent.length, sent, "Pi detail reads the extension's update, not an invented RPC command");
});

test("Pi startup dialogs cancel, active dialogs replay/expire, and unsupported commands never reach stdin", async (t) => {
  const native = new FakePi();
  const session = new AgentSessionWrapper({ engine: "pi", cwd: "/tmp" }, native);
  native.frame({ type: "extension_ui_request", id: "startup", method: "confirm", title: "Startup" });
  assert.deepEqual(native.sent.at(-1), { type: "extension_ui_response", id: "startup", cancelled: true });
  await session.start();
  t.after(() => session.shutdown());
  const events = [];
  session.onEvent((event) => events.push(event));
  native.frame({ type: "extension_ui_request", id: "live", method: "input", title: "Input", timeout: 5 });
  const replay = [];
  session.onEvent((event) => replay.push(event))();
  assert.equal(replay.find(event => event.type === "extension_ui_request")?.id, "live");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(events.some((event) => event.method === "cancel" && event.targetId === "live"));
  const sent = native.sent.length;
  for (const type of ["get_tools", "set_tools", "navigate_tree", "clear_queue", "reload", "abort_compaction", "get_subagents"]) {
    await assert.rejects(session.send({ type }));
  }
  assert.equal(native.sent.length, sent);
});

test("Pi settling an old run cannot finish a newer prompt still in preflight", async (t) => {
  const { native, session, events } = await piFixture(t);
  await session.send({ type: "prompt", message: "first" });
  const preflight = Promise.withResolvers();
  const request = native.request.bind(native);
  native.request = (command, timeout, id) => {
    if (command.type !== "prompt") return request(command, timeout, id);
    native.sent.push({ ...command, id });
    return preflight.promise;
  };
  const pending = session.send({ type: "prompt", message: "/delayed" });
  const id = native.sent.at(-1).id;
  native.state = { ...native.state, isStreaming: false };
  native.frame({ type: "agent_settled" });
  assert.equal(session.isRunning(), true);
  assert.ok(!events.some((event) => event.type === "prompt_done" || event.type === "agent_settled"));
  native.frame({ type: "response", command: "prompt", id, success: true });
  preflight.resolve();
  await pending;
  assert.equal(session.isRunning(), false);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
});

test("resume rejects an engine mismatch and compares the unqualified native header ID before spawning", async () => {
  await assert.rejects(startRpcSession("pi:native", "/not-opened.jsonl", "/tmp", { engine: "omp" }), /engine does not match/);
  const directory = await mkdtemp(join(tmpdir(), "omp-web-pi-identity-"));
  const file = join(directory, "session.jsonl");
  try {
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "different", cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z" }) + "\n");
    await assert.rejects(startRpcSession("pi:native", file, "/tmp"), /file identity does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
