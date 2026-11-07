import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { InlineConfirmation } = await jiti.import("./InlineConfirmation.tsx");

function render(extra = {}) {
  let actions = 0;
  const html = renderToStaticMarkup(React.createElement(InlineConfirmation, {
    title: "Confirm action", message: "Warning <text>\nSave work first", confirmLabel: "Confirm", cancelLabel: "Cancel",
    onConfirm() { actions++; }, onCancel() { actions++; }, ...extra,
  }));
  assert.equal(actions, 0, "rendering a confirmation must never execute its action");
  return html;
}

test("confirmation is an accessible inline group rather than a modal or browser dialog", () => {
  const html = render();
  assert.match(html, /role="group"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /aria-describedby=/);
  assert.match(html, /role="status"/);
  assert.match(html, /Warning &lt;text&gt;/);
  assert.doesNotMatch(html, /aria-modal="true"|role="alertdialog"|position:fixed/);
  const buttons = html.match(/<button[^>]*>.*?<\/button>/g);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], />Cancel<\/button>/);
  assert.match(buttons[1], />Confirm<\/button>/);
  assert.ok(buttons.every((button) => button.includes('type="button"')));
});

test("stale or unavailable actions disable only confirmation, not cancellation", () => {
  const buttons = render({ confirmDisabled: true }).match(/<button[^>]*>.*?<\/button>/g);
  assert.doesNotMatch(buttons[0], /disabled/);
  assert.match(buttons[1], /disabled=""/);
});
