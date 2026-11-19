import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Run both the real hook's scroll handlers AND its message-following effects.
// The synthetic viewport/clock avoids browsers, native agents and real history.
const source = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const start = source.indexOf("  const scrollToBottom = useCallback(");
const handlers = source.slice(start, source.indexOf("  // Load session on mount", start));
const followStart = source.indexOf("  useEffect(() => {\n    completionScrollAllowedRef.current = Date.now()");
const following = source.slice(followStart, source.indexOf("  // Restore only this project's choice", followStart));
assert.ok(start > 0 && handlers.includes("const pauseAutoScroll") && followStart > 0);
const code = ts.transpileModule(`${handlers}
globalThis.pause = pauseAutoScroll; globalThis.intent = markUserScrollIntent;
globalThis.scrolled = handleScrollPositionChange; globalThis.follow = scrollToBottom;
globalThis.renderFollow = () => { ${following} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const ref = (current) => ({ current });
const message = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
function browser(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const scrolls = [], cleanups = [], effects = [], frames = new Map();
  let rendering = false, effectIndex = 0, frameId = 0;
  class KeyboardEvent { constructor(key, target = null) { this.key = key; this.target = target; } }
  class WheelEvent { constructor(deltaY) { this.deltaY = deltaY; } }
  const ctx = vm.createContext({
    Date, KeyboardEvent, WheelEvent, Element: class {},
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
    requestAnimationFrame: (fn) => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    useCallback: (fn) => fn, useMemo: (fn) => fn(),
    useEffect: (fn, deps) => {
      if (!rendering) { cleanups.push(fn()); return; }
      const index = effectIndex++, previous = effects[index];
      if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: fn() };
    },
    PROGRAMMATIC_SCROLL_IGNORE_MS: 700, USER_SCROLL_INTENT_MS: 1200, AUTO_SCROLL_PAUSE_MS: 60_000,
    SCROLL_KEYS: new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]),
    mountedRef: ref(true), autoScrollEnabled: true, autoScrollPausedUntilRef: ref(0),
    autoScrollResumeTimerRef: ref(null), completionScrollAllowedRef: ref(true),
    ignoreProgrammaticScrollUntilRef: ref(0), userScrollIntentUntilRef: ref(0), lastTouchYRef: ref(undefined),
    pendingScrollToUserRef: ref(false), initialScrollDoneRef: ref(true), lastAutoScrollContentRef: ref(null),
    messages: [message("existing history")], streamState: { streamingMessage: null }, agentRunning: false,
    scrollContainerRef: ref({ scrollHeight: 1200, clientHeight: 400, scrollTop: 300,
      scrollTo(options) { this.scrollTop = Math.min(options.top, this.scrollHeight - this.clientHeight); scrolls.push(options); },
    }),
  });
  vm.runInContext(code, ctx);
  const render = () => { rendering = true; effectIndex = 0; ctx.renderFollow(); rendering = false; };
  const paint = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn()); };
  const cleanup = () => { cleanups.forEach((fn) => fn?.()); effects.forEach((effect) => effect.cleanup?.()); };
  t.after(cleanup);
  render(); paint(); scrolls.length = 0; // The reader is already viewing a loaded conversation.
  return { ctx, scrolls, render, paint, cleanup, wheel: (delta = 1) => ctx.intent(new WheelEvent(delta)) };
}

test("reading idle history does not jump when the one-minute pause expires", (t) => {
  const b = browser(t);
  b.wheel(-20);
  t.mock.timers.tick(60_000);
  assert.equal(b.ctx.completionScrollAllowedRef.current, true, "following is allowed again");
  assert.equal(b.scrolls.length, 0, "expiry alone must not move a reader of static history");
  t.mock.timers.tick(120_000);
  assert.equal(b.scrolls.length, 0);
});

test("away from the bottom either wheel direction pauses following without scrolling on expiry", (t) => {
  const b = browser(t);
  b.wheel(-20);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(59_999);
  assert.equal(b.scrolls.length, 0);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(1);
  assert.equal(b.ctx.completionScrollAllowedRef.current, true);
  assert.equal(b.scrolls.length, 0);
  b.wheel(20);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
});

test("further manual scrolling resets the full minute, including scrolling down", (t) => {
  const b = browser(t);
  b.wheel(-20);
  t.mock.timers.tick(40_000);
  b.wheel(20);
  t.mock.timers.tick(20_000);
  assert.equal(b.scrolls.length, 0);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(39_999);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(1);
  assert.equal(b.ctx.completionScrollAllowedRef.current, true);
  assert.equal(b.scrolls.length, 0);
});

test("manually reaching the bottom ends the pause and the next streamed token follows", (t) => {
  const b = browser(t), el = b.ctx.scrollContainerRef.current;
  b.wheel(200);
  el.scrollTop = 798;
  b.ctx.scrolled();
  assert.equal(b.ctx.completionScrollAllowedRef.current, false, "not at the bottom yet");
  el.scrollTop = 799.75; // fractional CSS pixels
  b.ctx.scrolled();
  assert.equal(b.ctx.autoScrollPausedUntilRef.current, 0);
  assert.equal(b.ctx.autoScrollResumeTimerRef.current, null);
  assert.equal(b.scrolls.length, 0, "resuming itself does not scroll");
  b.wheel(20); // overscroll at the edge: no subsequent scroll event
  b.ctx.streamState.streamingMessage = message("next token");
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 1);
  b.wheel(-20);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false, "leaving the bottom pauses immediately");
});

test("touching the bottom restores following but does not override the disabled setting", (t) => {
  const b = browser(t), el = b.ctx.scrollContainerRef.current;
  b.ctx.autoScrollEnabled = false;
  b.render();
  b.ctx.intent({ type: "touchstart", touches: [{ clientY: 120 }] });
  b.ctx.intent({ type: "touchmove", touches: [{ clientY: 100 }] });
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  el.scrollTop = 800;
  b.ctx.scrolled();
  b.ctx.intent({ type: "touchmove", touches: [{ clientY: 80 }] });
  assert.equal(b.ctx.autoScrollPausedUntilRef.current, 0);
  b.ctx.messages = [...b.ctx.messages, message("another reply")];
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
});

test("only messages arriving AFTER the pause expires resume following, not the paused backlog", (t) => {
  const b = browser(t);
  b.wheel();
  b.ctx.messages = [...b.ctx.messages, message("arrived while paused")];
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
  t.mock.timers.tick(60_000);
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
  b.ctx.messages = [...b.ctx.messages, message("arrived after expiry")];
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 1);
});

test("new streaming content follows after expiry but repeated snapshots do not", (t) => {
  const b = browser(t);
  b.wheel();
  b.ctx.streamState.streamingMessage = message("first token");
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
  t.mock.timers.tick(60_000);
  assert.equal(b.scrolls.length, 0);
  b.ctx.streamState.streamingMessage = message("first token and more");
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 1);
  b.ctx.streamState.streamingMessage = structuredClone(b.ctx.streamState.streamingMessage);
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 1, "same streaming content is not a new update");
});

test("unchanged history revalidation preserves the reading position after expiry", (t) => {
  const b = browser(t);
  b.wheel();
  t.mock.timers.tick(60_000);
  b.ctx.messages = structuredClone(b.ctx.messages);
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
});

test("starting or stopping work without new content does not scroll", (t) => {
  const b = browser(t);
  b.ctx.agentRunning = true;
  b.render(); b.paint();
  b.ctx.agentRunning = false;
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
});

test("clearing a streaming placeholder alone does not count as new content", (t) => {
  const b = browser(t);
  b.ctx.streamState.streamingMessage = message("streaming reply");
  b.render(); b.paint();
  b.scrolls.length = 0;
  b.ctx.streamState.streamingMessage = null;
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
});

test("the disabled setting never follows and enabling it alone does not move static history", (t) => {
  const b = browser(t);
  b.ctx.autoScrollEnabled = false;
  b.render(); b.paint();
  b.wheel();
  t.mock.timers.tick(60_000);
  b.ctx.messages = [...b.ctx.messages, message("arrived while disabled")];
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
  b.ctx.autoScrollEnabled = true;
  b.render(); b.paint();
  assert.equal(b.scrolls.length, 0);
});

test("a manual scroll interrupts a follow already scheduled for the next frame", (t) => {
  const b = browser(t);
  b.ctx.messages = [...b.ctx.messages, message("new reply")];
  b.render();
  b.wheel(-20);
  b.paint();
  assert.equal(b.scrolls.length, 0);
});

test("programmatic scrolling does not pause itself; a pointer-driven scroll does", (t) => {
  const b = browser(t);
  b.ctx.follow("instant");
  b.ctx.scrolled();
  assert.equal(b.ctx.completionScrollAllowedRef.current, true);
  b.ctx.intent({ type: "pointerdown" });
  b.ctx.scrollContainerRef.current.scrollTop = 500;
  b.ctx.scrolled();
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(60_000);
  assert.equal(b.scrolls.length, 1, "only the explicit programmatic scroll occurred");
});

test("touch scrolling pauses and unmount cleanup cancels resuming", (t) => {
  const b = browser(t);
  b.ctx.intent({ type: "touchstart", touches: [{ clientY: 80 }] });
  b.ctx.intent({ type: "touchmove", touches: [{ clientY: 100 }] });
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  b.cleanup();
  t.mock.timers.tick(60_000);
  assert.equal(b.scrolls.length, 0);
});
