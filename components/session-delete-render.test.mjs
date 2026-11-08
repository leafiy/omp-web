import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const engine = await jiti.import("../lib/engine.ts");
const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const item = source.slice(source.indexOf("function SessionItem("));
const compiled = ts.transpileModule(item + "\nexports.SessionItem = SessionItem;", {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Render the real row, with hover on and all transient editing/deleting state off.
// No browser fetches, agents or actual session mutations are involved.
function renderRow(id, { hovered = true, selected = false } = {}) {
  let state = 0;
  const context = {
    React, require, exports: {}, ...engine,
    useI18n: () => ({ t: (key) => key }),
    useState: (initial) => [state++ === 0 ? hovered : initial, () => {}],
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    formatRelativeTime: () => "now",
  };
  vm.runInNewContext(compiled, context);
  return renderToStaticMarkup(React.createElement(context.exports.SessionItem, {
    session: { id, name: "Fixture", modified: "2026-01-01T00:00:00Z", messageCount: 1 },
    isSelected: selected, onClick() {},
  }));
}

for (const id of ["fixture", "pi:fixture", "claude:fixture"]) {
  test(`${engine.engineForSession(id)} sidebar row exposes deletion on hover`, () => {
    assert.match(renderRow(id), /title="sidebar.deleteWithShiftClick"/);
  });
}
test("selected Claude row exposes deletion without hover (touch)", () => {
  assert.match(renderRow("claude:fixture", { hovered: false, selected: true }), /title="sidebar.deleteWithShiftClick"/);
});
test("unselected rows keep actions hidden when not hovered", () => {
  assert.doesNotMatch(renderRow("claude:fixture", { hovered: false }), /title="sidebar.deleteWithShiftClick"/);
});
test("Codex deletion stays unavailable until its native store is supported", () => {
  assert.doesNotMatch(renderRow("codex:fixture"), /title="sidebar.deleteWithShiftClick"/);
});
