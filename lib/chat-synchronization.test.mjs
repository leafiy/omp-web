import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Replay the actual hook callbacks with an in-memory server and no native CLI,
// browser, model requests or user transcripts. This covers the idle call site,
// not merely a second implementation of the synchronization policy.
const source = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
function callback(name, end) {
  const start = source.indexOf(`  const ${name} = useCallback(async `);
  const chunk = source.slice(start, source.indexOf(end, start));
  assert.ok(start >= 0 && chunk.lastIndexOf("}, [") > 0, `callback boundary: ${name}`);
  return `globalThis.${name} = ${chunk.slice(chunk.indexOf("async ("), chunk.lastIndexOf("}, ["))}};`;
}
const code = ts.transpileModule([
  source.match(/^const EVENT_STREAM_STALE_MS = .*$/m)[0],
  callback("loadSession", "  const loadContext"),
  callback("finishPromptWithoutStream", "  const waitForPromptSettlement"),
  callback("reconcileAgentState", "\n  useEffect("),
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const ref = (current) => ({ current });
const history = (text) => ({
  sessionId: "pi:test", filePath: "/fake/session.jsonl", tree: [], leafId: text,
  context: { messages: [{ role: "assistant", content: text }], entryIds: [text], thinkingLevel: "off", model: null },
});
function browser() {
  const trace = [];
  let persisted = history("old"), remote = { running: false };
  const view = { messages: persisted.context.messages, entryIds: persisted.context.entryIds, applied: 0, draft: "unsent work" };
  const ctx = vm.createContext({
    console, DOMException, EventSource: { OPEN: 1 },
    mountedRef: ref(true), sessionIdRef: ref("pi:test"), promptRunIdRef: ref(0),
    agentEventRevisionRef: ref(0), contextRevisionRef: ref(0), thinkingChangeRevisionRef: ref(0),
    agentRunningRef: ref(false), sdkAgentActiveRef: ref(false), rpcPromptPendingRef: ref(false), localPromptRequestInFlightRef: ref(false),
    optimisticUserMessageRef: ref(null), completionRevisionRef: ref(0), bashRunningRef: ref(false),
    taskSnapshotRef: ref(null), taskStatusStaleRef: ref(false), historySyncNeededRef: ref(false),
    eventSourceRef: ref(null), eventConnectionAttemptRef: ref(null), lastStreamEventAtRef: ref(Date.now()),
    historyLoadRevision: ref(0), messageRevision: ref(0), knownSessionNameRef: ref(""),
    loadedWindowRef: ref({ messages: view.messages, entryIds: view.entryIds }),
    historyUrl: (sid) => `/history/${sid}`,
    historyClientCache: { load: async () => persisted, peek: () => null, invalidate() {} },
    HistoryRequestError: class extends Error {},
    fetch: async (url) => { trace.push(["GET", url]); return { ok: true, json: async () => remote }; },
    hasActiveTasks: () => false, normalizeQueuedMessages: (q) => q,
    applyTaskSnapshot() {}, setTaskStatusStale() {}, setQueuedMessages() {}, setIsCompacting() {},
    setAgentRunning() {}, setAgentPhase() {}, dispatch() {}, setBashRunning() {}, waitForBashSettlement() {},
    cancelEventStreamGrace() {}, scheduleEventStreamClose() {}, notifyPromptStage() {}, notifyCompletion() {},
    closeEvents() { trace.push(["close"]); ctx.eventSourceRef.current = null; },
    async ensureEventsConnected(sid, observeOnly) { trace.push(["attach", sid, observeOnly]); ctx.eventSourceRef.current = { readyState: 1 }; },
    settleUiStage() { const previous = ctx.agentRunningRef.current; ctx.agentRunningRef.current = false; return previous; },
    applyHistoryWindow(d) {
      view.messages = d.context.messages; view.entryIds = d.context.entryIds; view.applied++;
      ctx.loadedWindowRef.current = { messages: view.messages, entryIds: view.entryIds };
    },
    setMessages(messages) { view.messages = messages; }, setEntryIds(ids) { view.entryIds = ids; },
    setData() {}, setActiveLeafId() {}, setCurrentModelOverride() {}, setError() {}, setThinkingLevel() {},
    setLoading() {}, setHistoryPage() {}, setHistoryTurnStates() {}, onSessionNameChange() {},
    setNativeSteeringAvailable() {}, setContextUsage() {}, setSystemPrompt() {}, setExtensionStatuses() {}, setExtensionWidgets() {},
  });
  vm.runInContext(code, ctx);
  return {
    ctx, view, trace,
    persist: (value) => { persisted = value; },
    state: (value) => { remote = value; },
    poll: (recovered = false, signal = new AbortController().signal) => ctx.reconcileAgentState("pi:test", signal, recovered),
  };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("an idle device displays a remote completed turn without refresh and preserves its draft", async () => {
  const b = browser(), latest = history("remote final answer");
  b.persist(latest);
  await b.poll();
  assert.equal(b.view.messages, latest.context.messages);
  assert.equal(b.view.entryIds, latest.context.entryIds);
  assert.equal(b.view.draft, "unsent work");
  assert.deepEqual(b.trace, [["GET", "/api/agent/pi%3Atest"]]);
  assert.equal(b.ctx.agentRunningRef.current, false);
});

test("discovers remote work, attaches passively, then displays the settled result", async () => {
  const b = browser();
  b.state({ running: true, state: { isStreaming: true, isPromptRunning: true } });
  b.persist(history("remote prompt"));
  await b.poll();
  assert.equal(b.ctx.agentRunningRef.current, true);
  assert.equal(b.ctx.promptRunIdRef.current, 1);
  assert.deepEqual(b.trace[1], ["attach", "pi:test", true]);
  assert.equal(b.view.messages[0].content, "remote prompt");
  b.state({ running: true, state: { isStreaming: false, isPromptRunning: false } });
  b.persist(history("completed"));
  await b.poll();
  assert.equal(b.ctx.agentRunningRef.current, false);
  assert.equal(b.view.messages[0].content, "completed");
});

test("idle snapshots cannot settle a local send still waiting for submission", async () => {
  const b = browser();
  b.ctx.agentRunningRef.current = true;
  b.ctx.localPromptRequestInFlightRef.current = true;
  b.ctx.optimisticUserMessageRef.current = { role: "user", content: "being sent" };
  b.view.messages = [b.ctx.optimisticUserMessageRef.current];
  await b.poll();
  assert.equal(b.ctx.agentRunningRef.current, true);
  assert.equal(b.view.messages[0].content, "being sent");
});

// Drive the send callback and its real SSE handshake together. The route can
// only emit `connected` after a cold native session has finished resuming.
const streamCode = ts.transpileModule([
  source.match(/^const EVENT_STREAM_CONNECT_TIMEOUT_MS = .*;$/m)[0],
  source.slice(source.indexOf("class EventStreamConnectionError"), source.indexOf("function createNoticeId")),
  source.slice(source.indexOf("  const closeEvents ="), source.indexOf("  const respondToExtensionUi =")),
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const sendCode = streamCode + ts.transpileModule(callback("handleSend", "  const executeBash ="),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

for (const resumeMs of [100, 6_000]) {
  test(`one click submits one prompt when session resume takes ${resumeMs}ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = browser(), sid = b.ctx.sessionIdRef.current, prompts = [], notices = [], streams = [];
    let ready = false;
    class Stream {
      static OPEN = 1;
      readyState = 0;
      constructor() { streams.push(this); if (ready) queueMicrotask(() => this.connect()); }
      connect() {
        if (this.readyState !== 0) return;
        this.readyState = Stream.OPEN;
        this.onmessage({ data: JSON.stringify({ type: "connected", sessionId: sid }) });
      }
      close() { this.readyState = 2; }
    }
    Object.assign(b.ctx, {
      useCallback: (fn) => fn, EventSource: Stream, setTimeout, clearTimeout,
      session: { id: sid }, isNew: false, opts: {}, eventSourceSessionIdRef: ref(null),
      handleAgentEventRef: ref(null), pendingScrollToUserRef: ref(false),
      completionScrollAllowedRef: ref(true), autoScrollPausedUntilRef: ref(0),
      setMessages: (update) => { b.view.messages = update(b.view.messages); },
      addNotice: (notice) => notices.push(notice.message),
      sendAgentCommand: async (id, command) => prompts.push([id, command.type, command.message]),
    });
    vm.runInContext(sendCode, b.ctx);
    const sending = b.ctx.handleSend("first click");
    await b.poll(); // Idle snapshot during startup: the prompt hasn't been submitted yet.
    t.mock.timers.tick(resumeMs);
    await flush();
    assert.deepEqual(prompts, [], "do not submit before the listener is attached");
    ready = true;
    streams.forEach((stream) => stream.connect());
    assert.equal(await sending, true, notices.join("; "));
    assert.deepEqual(prompts, [[sid, "prompt", "first click"]]);
  });
}

test("unchanged conditional history responses keep the same displayed message array", async () => {
  const b = browser(), same = b.view.messages;
  await b.poll(); await b.poll();
  assert.equal(b.view.messages, same);
  assert.equal(b.view.applied, 0);
});

for (const change of ["new run", "SSE lifecycle", "unmount", "cancel"]) {
  test(`ignores a state response superseded by ${change}`, async () => {
    const b = browser(), controller = new AbortController();
    let resolve;
    b.ctx.fetch = () => new Promise((done) => { resolve = done; });
    b.persist(history("stale"));
    const pending = b.poll(false, controller.signal);
    if (change === "new run") b.ctx.promptRunIdRef.current++;
    if (change === "SSE lifecycle") b.ctx.agentEventRevisionRef.current++;
    if (change === "unmount") b.ctx.mountedRef.current = false;
    if (change === "cancel") controller.abort();
    resolve({ ok: true, json: async () => ({ running: false }) });
    await pending;
    assert.equal(b.view.messages[0].content, "old");
    assert.equal(b.view.applied, 0);
  });
}

test("late history cannot overwrite a newer local prompt", async () => {
  const b = browser();
  let resolve;
  b.ctx.historyClientCache.load = () => new Promise((done) => { resolve = done; });
  const pending = b.poll();
  await flush();
  assert.equal(typeof resolve, "function");
  b.ctx.promptRunIdRef.current++;
  b.ctx.messageRevision.current++;
  b.view.messages = [{ role: "user", content: "new local prompt" }];
  resolve(history("stale remote result"));
  await pending;
  assert.equal(b.view.messages[0].content, "new local prompt");
});

test("a lifecycle change during settlement cannot stop a newer native continuation", async () => {
  const b = browser();
  b.ctx.agentRunningRef.current = true;
  b.ctx.sdkAgentActiveRef.current = true;
  let resolve;
  b.ctx.historyClientCache.load = () => new Promise((done) => { resolve = done; });
  const pending = b.poll();
  await flush();
  assert.equal(typeof resolve, "function");
  b.ctx.agentEventRevisionRef.current++;
  resolve(history("previous turn"));
  await pending;
  assert.equal(b.ctx.agentRunningRef.current, true);
  assert.equal(b.view.messages[0].content, "old");
});

test("weak network: missed messages appear when the stream goes silent without an offline event", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const b = browser();
  const streams = [];
  class Stream {
    static OPEN = 1;
    readyState = 0;
    constructor(url) {
      this.url = url; streams.push(this);
      queueMicrotask(() => { this.readyState = Stream.OPEN; this.emit("connected"); });
    }
    emit(type) { this.onmessage({ data: JSON.stringify({ type, sessionId: "pi:test" }) }); }
    close() { this.readyState = 2; }
  }
  Object.assign(b.ctx, {
    Date, EventSource: Stream, setTimeout, clearTimeout, useCallback: (fn) => fn,
    eventSourceSessionIdRef: ref(null), handleAgentEventRef: ref(null),
  });
  vm.runInContext(streamCode, b.ctx);
  b.state({ running: true, state: { isStreaming: true } });
  await b.poll();
  for (let beat = 0; beat < 4; beat++) {
    t.mock.timers.tick(30_000);
    streams[0].emit("heartbeat");
    await b.poll();
  }
  assert.equal(streams.length, 1, "healthy quiet streams stay attached");
  b.persist(history("reply missed on the silent stream"));
  for (let tick = 0; tick < 24; tick++) {
    t.mock.timers.tick(5_000);
    await b.poll(); // No focus/online event, no refresh, no SSE messages.
    if (b.view.messages[0].content === "reply missed on the silent stream") break;
  }
  assert.equal(b.view.messages[0].content, "reply missed on the silent stream");
  assert.equal(streams.length, 2, "the half-open stream is replaced");
  assert.equal(streams[0].readyState, 2);
  assert.match(streams[1].url, /\?observe=1$/);
  assert.equal(b.view.draft, "unsent work");
});

test("weak network: history catches up while event-stream reconnection still fails", async () => {
  const b = browser();
  b.state({ running: true, state: { isStreaming: true } });
  await b.poll();
  b.persist(history("persisted while disconnected"));
  b.ctx.eventSourceRef.current.readyState = 0; // CONNECTING, but short HTTP requests work.
  b.ctx.ensureEventsConnected = async () => { throw new Error("stream unavailable"); };
  await b.poll();
  assert.equal(b.view.messages[0].content, "persisted while disconnected");
  assert.equal(b.ctx.agentRunningRef.current, true);
  assert.equal(b.view.draft, "unsent work");
});

test("foreground recovery repairs a half-open stream and reloads missed history", async () => {
  const b = browser();
  b.ctx.agentRunningRef.current = true;
  b.ctx.eventSourceRef.current = { readyState: 1 };
  b.state({ running: true, state: { isStreaming: true } });
  b.persist(history("missed while suspended"));
  await b.poll(true);
  assert.ok(b.trace.some(([action]) => action === "close"));
  assert.ok(b.trace.some(([action, , passive]) => action === "attach" && passive === true));
  assert.equal(b.view.messages[0].content, "missed while suspended");
});

test("an SSE reconnect requests catch-up history even while the agent stays busy", async () => {
  const b = browser();
  b.ctx.agentRunningRef.current = true;
  b.ctx.eventSourceRef.current = { readyState: 1 };
  b.ctx.historySyncNeededRef.current = true;
  b.state({ running: true, state: { isStreaming: true } });
  b.persist(history("missed before SSE reconnected"));
  await b.poll();
  assert.equal(b.view.messages[0].content, "missed before SSE reconnected");
  assert.equal(b.ctx.historySyncNeededRef.current, false);
});
