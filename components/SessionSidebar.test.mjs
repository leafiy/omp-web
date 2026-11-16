import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));
const pinsSource = await readFile(new URL("../hooks/useSessionPins.ts", import.meta.url), "utf8");

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("pins use server snapshots and do not read or write device-local preferences", () => {
  assert.doesNotMatch(source, /loadPinnedSessions|PINNED_SESSIONS_STORAGE_KEY/);
  assert.doesNotMatch(pinsSource, /localStorage\.(?:getItem|setItem)/);
  assert.match(pinsSource, /localStorage\.removeItem\("omp-web:pinned-sessions"\)/);
  assert.match(pinsSource, /fetch\("\/api\/sessions\/pins"/);
  assert.match(pinsSource, /JSON\.stringify\(\{ sessionId, pinned \}\)/);
  assert.match(pinsSource, /next\.revision <= latest\.current\.revision/);
  assert.equal(source.match(/applyPinState\(data\.pinState\)/g)?.length, 2);
  assert.match(source, /window\.addEventListener\("online", onVisibilityChange\)/);
});

test("pin button remains hover-only and is disabled while its request is pending", () => {
  assert.match(sessionItemSource, /\{hovered && <button[\s\S]*?onTogglePin\(\)[\s\S]*?disabled=\{pinDisabled\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});
