import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { readChatAutoScroll, writeChatAutoScroll, subscribeChatAutoScroll } = await createJiti(import.meta.url).import("./chat-auto-scroll.ts");

function browser(t) {
  const values = new Map();
  const window = new EventTarget();
  const localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const restores = [], cleanups = [];
  for (const [key, value] of Object.entries({ window, localStorage })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restores.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  t.after(() => { cleanups.forEach((fn) => fn()); restores.forEach((fn) => fn()); });
  writeChatAutoScroll(true);
  values.clear();
  return { values, window, localStorage, cleanup: (fn) => cleanups.push(fn) };
}

test("defaults on, persists off, and notifies all same-page subscribers", (t) => {
  const { values, cleanup } = browser(t);
  assert.equal(readChatAutoScroll(), true);
  let first = 0, second = 0;
  const unsubscribe = subscribeChatAutoScroll(() => first++);
  const unsubscribeSecond = subscribeChatAutoScroll(() => second++);
  cleanup(unsubscribeSecond);
  writeChatAutoScroll(false);
  assert.equal(readChatAutoScroll(), false);
  assert.equal(values.get("omp-web:chat-auto-scroll"), "false");
  assert.equal(first, 1); assert.equal(second, 1);
  unsubscribe();
  writeChatAutoScroll(true);
  assert.equal(first, 1); assert.equal(second, 2);
});

test("other tabs' changes and clearing storage update the preference", (t) => {
  const { values, window, cleanup } = browser(t);
  let changes = 0;
  const unsubscribe = subscribeChatAutoScroll(() => changes++);
  cleanup(unsubscribe);
  values.set("omp-web:chat-auto-scroll", "false");
  window.dispatchEvent(Object.assign(new Event("storage"), { key: "omp-web:chat-auto-scroll" }));
  assert.equal(readChatAutoScroll(), false);
  assert.equal(changes, 1);
  values.clear();
  window.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
  assert.equal(readChatAutoScroll(), true);
  assert.equal(changes, 2);
  window.dispatchEvent(Object.assign(new Event("storage"), { key: "unrelated" }));
  assert.equal(changes, 2);
});

test("works in memory when browser storage is blocked", (t) => {
  const { localStorage } = browser(t);
  localStorage.getItem = () => { throw new Error("blocked"); };
  localStorage.setItem = () => { throw new Error("blocked"); };
  writeChatAutoScroll(false);
  assert.equal(readChatAutoScroll(), false);
  writeChatAutoScroll(true);
  assert.equal(readChatAutoScroll(), true);
});
