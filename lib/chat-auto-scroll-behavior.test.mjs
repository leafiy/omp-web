import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Run the real hook's scroll handlers with a synthetic viewport and clock.
const source = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const start = source.indexOf("  const scrollToBottom = useCallback(");
const handlers = source.slice(start, source.indexOf("  // Load session on mount", start));
assert.ok(start > 0 && handlers.includes("const pauseAutoScroll"));
const code = ts.transpileModule(`${handlers}\nglobalThis.pause = pauseAutoScroll; globalThis.intent = markUserScrollIntent; globalThis.scrolled = handleScrollPositionChange; globalThis.follow = scrollToBottom;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const ref = (current) => ({ current });
function browser(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const scrolls = [], cleanups = [];
  class KeyboardEvent { constructor(key, target = null) { this.key = key; this.target = target; } }
  class WheelEvent { constructor(deltaY) { this.deltaY = deltaY; } }
  const ctx = vm.createContext({
    Date, KeyboardEvent, WheelEvent, Element: class {},
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
    useCallback: (fn) => fn, useEffect: (fn) => { cleanups.push(fn()); },
    PROGRAMMATIC_SCROLL_IGNORE_MS: 700, USER_SCROLL_INTENT_MS: 1200, AUTO_SCROLL_PAUSE_MS: 60_000,
    SCROLL_KEYS: new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]),
    mountedRef: ref(true), autoScrollEnabledRef: ref(true), autoScrollPausedUntilRef: ref(0),
    autoScrollResumeTimerRef: ref(null), completionScrollAllowedRef: ref(true),
    ignoreProgrammaticScrollUntilRef: ref(0), userScrollIntentUntilRef: ref(0),
    scrollContainerRef: ref({ scrollHeight: 1200, scrollTo: (options) => scrolls.push(options) }),
  });
  vm.runInContext(code, ctx);
  t.after(() => cleanups.forEach((fn) => fn?.()));
  return { ctx, scrolls, wheel: (delta = 1) => ctx.intent(new WheelEvent(delta)), cleanups };
}

test("any wheel direction pauses following for exactly one minute", (t) => {
  const b = browser(t);
  b.wheel(-20);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(59_999);
  assert.equal(b.scrolls.length, 0);
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(1);
  assert.equal(b.ctx.completionScrollAllowedRef.current, true);
  assert.equal(b.scrolls.length, 1);
  assert.equal(b.scrolls[0].top, 1200);
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
  assert.equal(b.scrolls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(b.scrolls.length, 1);
});

test("turning the setting off prevents the resume timer from moving the viewport", (t) => {
  const b = browser(t);
  b.wheel();
  b.ctx.autoScrollEnabledRef.current = false;
  t.mock.timers.tick(60_000);
  assert.equal(b.scrolls.length, 0);
});

test("programmatic scrolling does not pause itself; a pointer-driven scroll does", (t) => {
  const b = browser(t);
  b.ctx.follow("instant");
  b.ctx.scrolled();
  assert.equal(b.ctx.completionScrollAllowedRef.current, true);
  b.ctx.intent({ type: "pointerdown" });
  b.ctx.scrolled();
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  t.mock.timers.tick(60_000);
  assert.equal(b.scrolls.length, 2);
});

test("touch scrolling pauses and unmount cleanup cancels resuming", (t) => {
  const b = browser(t);
  b.ctx.intent({ type: "touchmove" });
  assert.equal(b.ctx.completionScrollAllowedRef.current, false);
  b.cleanups.forEach((fn) => fn?.());
  t.mock.timers.tick(60_000);
  assert.equal(b.scrolls.length, 0);
});
