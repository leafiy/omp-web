import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { startVisiblePolling } = await createJiti(import.meta.url).import("./visible-polling.ts");

function browser(t) {
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  const navigator = { onLine: true };
  const restores = [], cleanups = [];
  for (const [key, value] of Object.entries({ document, window, navigator })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restores.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  t.after(() => { cleanups.forEach((fn) => fn()); restores.forEach((fn) => fn()); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return { document, window, navigator, cleanup: (fn) => cleanups.push(fn) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("polls idle views periodically, then immediately on foreground/network recovery", async (t) => {
  const env = browser(t);
  const calls = [];
  const stop = startVisiblePolling(async (_signal, recovered) => { calls.push(recovered); }, 5000, false);
  env.cleanup(stop);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(5000); await flush();
  assert.deepEqual(calls, [false]);
  env.document.visibilityState = "hidden";
  env.document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(30_000); await flush();
  assert.equal(calls.length, 1);
  env.document.visibilityState = "visible";
  env.document.dispatchEvent(new Event("visibilitychange")); await flush();
  assert.deepEqual(calls, [false, true]);
  env.navigator.onLine = false;
  env.window.dispatchEvent(new Event("offline"));
  t.mock.timers.tick(30_000); await flush();
  assert.equal(calls.length, 2);
  env.navigator.onLine = true;
  env.window.dispatchEvent(new Event("online")); await flush();
  assert.deepEqual(calls, [false, true, true]);
  env.window.dispatchEvent(new Event("focus")); await flush();
  assert.equal(calls.at(-1), true);
  assert.equal(calls.length, 4);
});

test("does not overlap slow requests; recovery events coalesce into one follow-up", async (t) => {
  const env = browser(t);
  let finish;
  const calls = [];
  const stop = startVisiblePolling((signal, recovered) => {
    calls.push({ signal, recovered });
    return new Promise((resolve) => { finish = resolve; });
  }, 5000);
  env.cleanup(stop);
  t.mock.timers.tick(30_000);
  env.window.dispatchEvent(new Event("focus"));
  env.window.dispatchEvent(new Event("online"));
  env.window.dispatchEvent(new Event("focus"));
  assert.equal(calls.length, 1);
  finish(); await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].recovered, true);
  finish(); await flush();
  t.mock.timers.tick(4999);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 3);
  finish(); await flush();
});

test("hide and cleanup abort pending work, and stopped subscribers never restart", async (t) => {
  const env = browser(t);
  let signal, finish, calls = 0;
  const stop = startVisiblePolling((next) => {
    calls++; signal = next;
    return new Promise((resolve) => { finish = resolve; });
  }, 5000);
  env.document.visibilityState = "hidden";
  env.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(signal.aborted, true);
  finish(); await flush();
  env.document.visibilityState = "visible";
  env.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 2);
  assert.equal(signal.aborted, false);
  stop();
  assert.equal(signal.aborted, true);
  finish(); await flush();
  env.window.dispatchEvent(new Event("focus"));
  env.window.dispatchEvent(new Event("online"));
  t.mock.timers.tick(30_000); await flush();
  assert.equal(calls, 2);
});

test("a rejected request retains the polling loop", async (t) => {
  const env = browser(t);
  let calls = 0;
  const stop = startVisiblePolling(async () => { calls++; throw new Error("offline"); }, 5000);
  env.cleanup(stop);
  await flush();
  t.mock.timers.tick(5000); await flush();
  assert.equal(calls, 2);
});
