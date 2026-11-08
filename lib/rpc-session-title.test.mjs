import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentRpcClient } = await jiti.import("./agent-rpc-client.ts");
const { generateRpcSessionTitle } = await jiti.import("./rpc-session-title.ts");
const model = { provider: "native-provider", modelId: "selected-model" };
const options = { cwd: "/tmp", engine: "omp", initialModel: model, sessionFile: "/never/resume-this.jsonl", catalogOnly: true };

class FakeTitleClient {
  engine;
  frames = new Set();
  closes = new Set();
  requests = [];
  prompted = Promise.withResolvers();
  state = { model: { provider: model.provider, id: model.modelId }, dumpTools: [] };
  text = "Native Generated Title";
  stopped = false;
  shutdowns = 0;
  startGate;
  constructor(engine = "omp") { this.engine = engine; }
  async start() { await this.startGate; }
  onFrame(listener) { this.frames.add(listener); return () => this.frames.delete(listener); }
  onClose(listener) { this.closes.add(listener); return () => this.closes.delete(listener); }
  frame(frame) { for (const listener of this.frames) listener(frame); }
  async request(command, _timeout, id) {
    this.requests.push({ ...command, id });
    if (command.type === "get_state") return this.state;
    if (command.type === "prompt") {
      this.prompted.resolve(id);
      return this.engine === "pi" ? { disposition: "started" } : undefined;
    }
    if (command.type === "get_last_assistant_text") return { text: this.text };
    throw new Error(`Unexpected title RPC: ${command.type}`);
  }
  destroy() {
    if (this.stopped) return;
    this.stopped = true;
    for (const listener of this.closes) listener(new Error("fake process closed"));
  }
  async shutdown() { this.shutdowns++; }
}

function startFake(client, signal = new AbortController().signal) {
  let received;
  const result = generateRpcSessionTitle({ ...options, engine: client.engine }, "Bounded title prompt", signal, (settings) => {
    received = settings;
    return client;
  });
  return { result, received };
}

function assistant(client, stopReason = "stop", errorMessage) {
  client.frame({ type: "message_end", message: { role: "assistant", stopReason, errorMessage, content: [{ type: "text", text: client.text }] } });
}

test("OMP title generation is isolated and waits for its correlated prompt_result", async () => {
  const client = new FakeTitleClient();
  const { result, received } = startFake(client);
  assert.deepEqual(received, { cwd: "/tmp", engine: "omp", initialModel: model, thinkingLevel: undefined, titleOnly: true });
  const id = await client.prompted.promise;
  let finished = false;
  void result.then(() => { finished = true; });
  assistant(client);
  client.frame({ type: "agent_end" });
  client.frame({ type: "session_settled" });
  client.frame({ type: "prompt_result", id: "some-other-prompt", status: "completed", agentInvoked: true });
  await Promise.resolve();
  assert.equal(finished, false);
  client.frame({ type: "prompt_result", id, status: "completed", agentInvoked: true });
  assert.equal(await result, "Native Generated Title");
  assert.equal(client.shutdowns, 1);
  assert.equal(client.stopped, false);
  assert.equal(client.requests.some((request) => request.type === "set_session_name"), false);
  assert.equal(client.frames.size, 0);
  assert.equal(client.closes.size, 0);
});

test("Pi admission and agent_end are not completion; final retry settles with real text", async () => {
  const client = new FakeTitleClient("pi");
  const { result } = startFake(client);
  await client.prompted.promise;
  let finished = false;
  void result.then(() => { finished = true; });
  assistant(client, "error", "temporary provider error");
  client.frame({ type: "agent_end", willRetry: true });
  await Promise.resolve();
  assert.equal(finished, false);
  assistant(client);
  client.frame({ type: "agent_end", willRetry: false });
  await Promise.resolve();
  assert.equal(finished, false);
  client.frame({ type: "agent_settled", aborted: false });
  assert.equal(await result, "Native Generated Title");
  assert.equal(client.shutdowns, 1);
});

test("native model errors are propagated and terminate the ephemeral process", async () => {
  const client = new FakeTitleClient();
  const { result } = startFake(client);
  const rejected = assert.rejects(result, /native quota exhausted/);
  const id = await client.prompted.promise;
  client.frame({ type: "prompt_result", id, status: "error", agentInvoked: true, error: { message: "native quota exhausted" } });
  await rejected;
  assert.equal(client.stopped, true);
  assert.equal(client.shutdowns, 1);
});

test("Pi final assistant errors cannot become fake titles", async () => {
  const client = new FakeTitleClient("pi");
  const { result } = startFake(client);
  const rejected = assert.rejects(result, /provider rejected request/);
  await client.prompted.promise;
  assistant(client, "error", "provider rejected request");
  client.frame({ type: "agent_settled", aborted: false });
  await rejected;
  assert.equal(client.stopped, true);
});

test("tool exposure, model mismatch and session persistence fail before any title prompt", async () => {
  for (const state of [
    { model: { provider: model.provider, id: model.modelId }, dumpTools: [{ name: "bash" }] },
    { model: { provider: "different-provider", id: model.modelId }, dumpTools: [] },
    { model: { provider: model.provider, id: model.modelId }, dumpTools: [], sessionFile: "/unexpected/session.jsonl" },
  ]) {
    const client = new FakeTitleClient();
    client.state = state;
    const { result } = startFake(client);
    await assert.rejects(result, /tools|active model|persists/);
    assert.equal(client.requests.some((request) => request.type === "prompt"), false);
    assert.equal(client.stopped, true);
    assert.equal(client.shutdowns, 1);
  }
});

test("cancellation during startup terminates and awaits process shutdown", async () => {
  const client = new FakeTitleClient();
  client.startGate = Promise.withResolvers().promise;
  const controller = new AbortController();
  const { result } = startFake(client, controller.signal);
  const rejected = assert.rejects(result, /cancel title now/);
  controller.abort(new Error("cancel title now"));
  await rejected;
  assert.equal(client.stopped, true);
  assert.equal(client.shutdowns, 1);
  assert.equal(client.requests.length, 0);
});

test("an already cancelled request never creates a process", async () => {
  const controller = new AbortController();
  controller.abort();
  let created = false;
  await assert.rejects(generateRpcSessionTitle(options, "prompt", controller.signal, () => { created = true; throw new Error("must not create"); }), { name: "AbortError" });
  assert.equal(created, false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.sent = [];
  child.stdin.on("data", (bytes) => child.sent.push(JSON.parse(bytes.toString())));
  child.frame = (frame) => child.stdout.write(JSON.stringify(frame) + "\n");
  child.kill = () => { child.exitCode = 0; child.emit("close", 0, null); return true; };
  child.stdin.once("finish", child.kill);
  return child;
}

for (const engine of ["omp", "pi"]) {
  test(`${engine} titleOnly disables discovery and attests the native empty active-tool set`, async () => {
    const child = fakeChild();
    let launch;
    const client = new AgentRpcClient({ ...options, engine, titleOnly: true }, (...args) => { launch = args; return child; });
    try {
      const args = launch[1];
      assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
      for (const flag of ["--no-session", "--no-tools", "--no-extensions", "--no-skills"]) assert.ok(args.includes(flag));
      assert.equal(args.includes("--no-ui"), false, "guard attestation must remain observable");
      assert.equal(args.includes(options.sessionFile), false);
      assert.equal(args.includes("--resume") || args.includes("--session"), false);
      if (engine === "pi") {
        assert.ok(args.includes("--no-mcp"));
        assert.deepEqual(args.slice(args.indexOf("--exclude-tools"), args.indexOf("--exclude-tools") + 2), ["--exclude-tools", "*"]);
      }
      const guardPath = args[args.indexOf(engine === "pi" ? "--extension" : "--trusted-extension") + 1];
      const { default: registerGuard } = await import(pathToFileURL(guardPath).href);
      const hooks = new Map();
      let active = ["unexpected_custom_tool"];
      registerGuard({
        on: (event, handler) => hooks.set(event, handler),
        setActiveTools: async (names) => { active = names; },
        getActiveTools: () => active,
      });
      const started = client.start();
      if (engine === "omp") child.frame({ type: "ready", supportedProtocolVersions: [1] });
      else child.frame({ type: "response", id: child.sent[0].id, success: true, data: { sessionId: "ephemeral-pi" } });
      let ready = false;
      void started.then(() => { ready = true; });
      await Promise.resolve();
      assert.equal(ready, false, "native RPC readiness alone is not proof of tool denial");
      const context = { ui: { notify: (message) => child.frame({ type: "extension_ui_request", method: "notify", message }) } };
      await hooks.get("session_start")({}, context);
      await started;
      assert.deepEqual(active, []);
      active = ["late_tool"];
      await hooks.get("before_agent_start")({}, context);
      assert.deepEqual(active, []);
      assert.deepEqual(hooks.get("tool_call")(), { block: true, reason: "Tools are disabled for conversation title generation." });
      await client.shutdown();
      await assert.rejects(access(dirname(guardPath)), { code: "ENOENT" });
    } finally { await client.shutdown(); }
  });
}
