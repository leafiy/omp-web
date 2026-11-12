import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Replay the actual browser event branch, not a copy of its merge algorithm.
const source = readFileSync(new URL('../hooks/useAgentSession.ts', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function extractMessageText('), source.indexOf('function readCompactResult('));
const branch = source.slice(source.indexOf('      case "message_end": {'), source.indexOf('      case "tool_execution_start": {'));
assert.ok(helpers && branch);
function browser(initial = [], optimistic = null) {
  let messages = initial;
  const context = vm.createContext({
    optimisticUserMessageRef: { current: optimistic },
    messageRevision: { current: 0 }, sessionIdRef: { current: 'pi:test' },
    historyClientCache: { invalidate() {} }, agentRunningRef: { current: true },
    normalizeToolCalls: message => message,
    setMessages: updater => { messages = updater(messages); },
    dispatch() {}, setAgentPhase() {},
  });
  vm.runInContext(ts.transpileModule(`${helpers}\nfunction receive(event) { switch (event.type) { ${branch} } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { context, messages: () => messages };
}
function replay(initial, optimistic, events) {
  const state = browser(initial, optimistic);
  for (const message of events) state.context.receive({ type: 'message_end', message });
  return state.messages();
}
const original = { role: 'user', content: [{ type: 'text', text: 'test' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'original' } }], timestamp: 100 };
const delivered = { role: 'user', content: [{ type: 'text', text: 'test' }, { type: 'text', text: '[Image: original 3022x778, displayed at 2000x515. Multiply coordinates by 1.51 to map to original image.]' }, { type: 'image', mimeType: 'image/png', data: 'resized' }], timestamp: 101 };

test('Pi image echo replaces the optimistic first message after resizing', () => {
  const result = replay([original], original, [delivered]);
  assert.equal(result.length, 1);
  assert.equal(result[0], delivered);
});

test('a custom event before the Pi echo must not leave two user bubbles', () => {
  const custom = { role: 'custom', content: 'startup notice', customType: 'notice', display: true, timestamp: 100 };
  const result = replay([original], original, [custom, delivered]);
  assert.equal(result.filter(message => message.role === 'user').length, 1);
  assert.ok(result.includes(custom));
  assert.ok(result.includes(delivered));
});

test('a history snapshot containing the Pi first message must not be appended again', () => {
  const fromHistory = structuredClone(delivered);
  const result = replay([fromHistory], original, [delivered]);
  assert.equal(result.filter(message => message.role === 'user').length, 1);
});

test('later same-text queue deliveries are not deduplicated', () => {
  const later = { ...delivered, timestamp: 102 };
  const result = replay([original], original, [delivered, later]);
  assert.equal(result.filter(message => message.role === 'user').length, 2);
});

test('a previous equal-text turn is not mistaken for a missing placeholder', () => {
  const previous = { role: 'user', content: 'test', timestamp: 1 };
  const pending = { role: 'user', content: 'test', timestamp: 2 };
  const echo = { role: 'user', content: 'test', timestamp: 3 };
  const result = replay([previous], pending, [echo]);
  assert.equal(result.length, 2);
  assert.equal(result[0], previous);
});

test('plain text replaces its own placeholder even after an extension message', () => {
  const pending = { role: 'user', content: 'hello', timestamp: 1 };
  const echo = { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 2 };
  const custom = { role: 'custom', content: 'notice', display: true };
  const result = replay([pending], pending, [custom, echo]);
  assert.equal(result.filter(message => message.role === 'user').length, 1);
  assert.equal(result[0], echo);
});

// Exercise the actual send callback as well: one first send, one native prompt,
// with the real event branch handling fake Pi startup and image echo events.
const sendStart = source.indexOf('  const handleSend = useCallback(async ');
const sendChunk = source.slice(sendStart, source.indexOf('  const executeBash =', sendStart));
assert.ok(sendStart >= 0 && sendChunk.includes('}, [isNew,'));
const sendCode = `globalThis.send = ${sendChunk.slice(sendChunk.indexOf('async ('), sendChunk.lastIndexOf('}, ['))}};`;
for (const hasImages of [false, true]) test(`first Pi send issues one prompt (${hasImages ? 'image' : 'text'})`, async () => {
  const state = browser();
  const ctx = state.context;
  const trace = [];
  const ref = current => ({ current });
  Object.assign(ctx, {
    agentRunningRef: ref(false), bashRunningRef: ref(false),
    promptRunIdRef: ref(0), completionRevisionRef: ref(0), rpcPromptPendingRef: ref(false),
    pendingScrollToUserRef: ref(false), completionScrollAllowedRef: ref(false),
    ensuringNewSessionRef: ref(null), mountedRef: ref(true),
    sessionIdRef: ref(null), session: null, isNew: true, newSessionCwd: '/test', newSessionModel: null,
    cancelEventStreamGrace() {}, setAgentRunning() {}, setPendingModel() {},
    closeEvents() {}, addNotice() {}, opts: {},
    EventStreamConnectionError: class extends Error {},
    async ensureNewSession() { trace.push('new'); ctx.sessionIdRef.current = 'pi:test'; return 'pi:test'; },
    async ensureEventsConnected() { trace.push('connected'); },
    async sendAgentCommand(sid, command) {
      assert.equal(sid, 'pi:test');
      trace.push(command.type);
      if (command.type === 'prompt') {
        ctx.receive({ type: 'message_end', message: { role: 'custom', content: 'startup', display: true } });
        ctx.receive({ type: 'message_end', message: hasImages ? delivered : { role: 'user', content: 'test', timestamp: 101 } });
      }
    },
    promoteNewSession() { trace.push('promoted'); },
  });
  vm.runInContext(ts.transpileModule(sendCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const first = ctx.send('test', hasImages ? [{ data: 'original', mimeType: 'image/png' }] : undefined);
  assert.equal(await ctx.send('test'), false, 'a concurrent submit must be refused');
  assert.equal(await first, true);
  assert.deepEqual(trace, ['new', 'connected', 'prompt', 'promoted']);
  assert.equal(state.messages().filter(message => message.role === 'user').length, 1);
});
