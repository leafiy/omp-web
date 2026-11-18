import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { maintainBrowserTitle, showRunningFavicon, subscribeBrowserActivity } = await createJiti(import.meta.url).import("./browser-title.ts");

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

function faviconBrowser(t, reduced = false) {
  const env = browser(t);
  const original = { rel: "icon", href: "/original.png" }, links = new Set([original]);
  document.head.appendChild = (link) => links.add(link);
  const link = { setAttribute() {}, remove() { links.delete(this); } };
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  window.matchMedia = () => motion;
  const image = {};
  let count = 0;
  const canvas = { getContext: () => ({ clearRect() {}, drawImage() {}, beginPath() {}, arc() {}, fill() {} }), toDataURL: () => `frame-${++count}` };
  document.createElement = (tag) => tag === "canvas" ? canvas : tag === "link" ? link : image;
  return { ...env, links, original, link, image, motion };
}

test("the favicon pulses without changing the project title; completion removes only the badge icon", (t) => {
  const env = faviconBrowser(t);
  env.cleanup(maintainBrowserTitle("project - OMP Web"));
  const stop = showRunningFavicon();
  env.cleanup(stop);
  env.image.onload();
  assert.ok(env.links.has(env.link));
  const first = env.link.href;
  t.mock.timers.tick(220);
  assert.notEqual(env.link.href, first);
  assert.equal(document.title, "project - OMP Web");
  stop();
  assert.deepEqual([...env.links], [env.original]);
  const last = env.link.href;
  t.mock.timers.tick(1000);
  assert.equal(env.link.href, last);
});

test("reduced motion uses a static badge and respects live preference changes", (t) => {
  const env = faviconBrowser(t, true);
  env.cleanup(showRunningFavicon());
  env.image.onload();
  const still = env.link.href;
  t.mock.timers.tick(220);
  assert.equal(env.link.href, still);
  env.motion.matches = false;
  env.motion.dispatchEvent(new Event("change"));
  t.mock.timers.tick(220);
  assert.notEqual(env.link.href, still);
  env.motion.matches = true;
  env.motion.dispatchEvent(new Event("change"));
  t.mock.timers.tick(220);
  assert.equal(env.link.href, still);
});

test("a task ending before its favicon loads cannot leave an activity badge", (t) => {
  const env = faviconBrowser(t);
  showRunningFavicon()();
  env.image.onload?.();
  assert.deepEqual([...env.links], [env.original]);
});

test("project switches update the plain title even after a native title write", (t) => {
  const env = browser(t);
  maintainBrowserTitle("first - OMP Web")();
  env.cleanup(maintainBrowserTitle("second - OMP Web"));
  document.title = "extension title";
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
