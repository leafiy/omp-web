import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { maintainBrowserTitle, subscribeBrowserActivity } = await createJiti(import.meta.url).import("./browser-title.ts");

function browser(t) {
  const document = Object.assign(new EventTarget(), { title: "OMP Web", head: {}, visibilityState: "visible" });
  const window = new EventTarget();
  const observers = new Set(), sources = [], restores = [], cleanups = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  class EventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 1; sources.push(this); }
    close() { this.readyState = 2; }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  for (const [key, value] of Object.entries({ document, window, MutationObserver, EventSource })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restores.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  t.after(() => { cleanups.forEach((fn) => fn()); restores.forEach((fn) => fn()); });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  return { document, window, sources, observers, cleanup: (fn) => cleanups.push(fn) };
}

test("running work blinks a green dot without changing the base title; cleanup removes it", (t) => {
  const env = browser(t);
  const stop = maintainBrowserTitle("workspace - OMP Web", true);
  env.cleanup(stop);
  assert.equal(document.title, "🟢 workspace - OMP Web");
  t.mock.timers.tick(1000);
  assert.equal(document.title, "workspace - OMP Web");
  t.mock.timers.tick(1000);
  assert.equal(document.title, "🟢 workspace - OMP Web");
  stop();
  assert.equal(document.title, "workspace - OMP Web");
  assert.equal(env.observers.size, 0);
  t.mock.timers.tick(5000);
  assert.equal(document.title, "workspace - OMP Web");
});

test("idle has no blinking, and task completion immediately restores the title", (t) => {
  const env = browser(t);
  const finish = maintainBrowserTitle("project - OMP Web", true);
  finish();
  env.cleanup(maintainBrowserTitle("project - OMP Web", false));
  assert.equal(document.title, "project - OMP Web");
  t.mock.timers.tick(5000);
  assert.equal(document.title, "project - OMP Web");
});

test("project switches replace the blinking title, and native title writes cannot fight the phase", (t) => {
  const env = browser(t);
  const first = maintainBrowserTitle("first - OMP Web", true);
  first();
  env.cleanup(maintainBrowserTitle("second - OMP Web", true));
  document.title = "extension title";
  for (const observer of env.observers) observer.callback();
  assert.equal(document.title, "🟢 second - OMP Web");
  t.mock.timers.tick(1000);
  assert.equal(document.title, "second - OMP Web");
  // Observing our own title write must not restore the dot during its off phase.
  for (const observer of env.observers) observer.callback();
  assert.equal(document.title, "second - OMP Web");
});

test("global activity includes other conversations and still clears while the tab is hidden", (t) => {
  const env = browser(t), states = [];
  env.cleanup(subscribeBrowserActivity((running) => states.push(running)));
  assert.equal(env.sources[0].url, "/api/agent/running/events");
  env.sources[0].message({ type: "running", runningSessionIds: ["pi:other-conversation"] });
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(env.sources[0].readyState, 1);
  env.sources[0].message({ type: "running", runningSessionIds: ["pi:second-task"] });
  env.sources[0].message({ type: "running", runningSessionIds: [] });
  assert.deepEqual(states, [true, true, false]);
  assert.equal(env.sources.length, 1);
});

test("malformed frames and connection errors do not pretend that tasks finished", (t) => {
  const env = browser(t), states = [];
  env.cleanup(subscribeBrowserActivity((running) => states.push(running)));
  const source = env.sources[0];
  source.message({ type: "running", runningSessionIds: ["task"] });
  source.onmessage({ data: "not JSON" });
  source.message({ type: "running", runningSessionIds: null });
  source.message({ type: "running", runningSessionIds: [42] });
  source.message({ type: "unrelated", runningSessionIds: [] });
  source.readyState = 0; // EventSource itself retries recoverable errors.
  source.onerror();
  t.mock.timers.tick(6000);
  assert.equal(env.sources.length, 1);
  assert.deepEqual(states, [true]);
});

test("fatal errors retry; stale frames and cleanup cannot resurrect the indicator", (t) => {
  const env = browser(t), states = [];
  const stop = subscribeBrowserActivity((running) => states.push(running));
  env.cleanup(stop);
  const old = env.sources[0];
  old.readyState = 2;
  old.onerror();
  t.mock.timers.tick(5000);
  assert.equal(env.sources.length, 2);
  old.message({ type: "running", runningSessionIds: ["stale"] });
  env.sources[1].message({ type: "running", runningSessionIds: [] });
  assert.deepEqual(states, [false]);
  stop();
  env.sources[1].message({ type: "running", runningSessionIds: ["late"] });
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(10_000);
  assert.deepEqual(states, [false]);
  assert.equal(env.sources.length, 2);
});

test("foreground and online recovery coalesce and replace a half-open stream", (t) => {
  const env = browser(t);
  env.cleanup(subscribeBrowserActivity(() => {}));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  t.mock.timers.tick(100);
  assert.equal(env.sources.length, 2);
  assert.equal(env.sources[0].readyState, 2);
});
