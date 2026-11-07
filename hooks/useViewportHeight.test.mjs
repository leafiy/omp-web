import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldUseVisualViewportHeight } = await jiti.import("./useViewportHeight.ts");

test("uses the visual viewport for a focused editor when the keyboard shrinks it", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    innerHeight: 844,
    viewportHeight: 510,
    viewportScale: 1,
  }), true);
});

test("keeps the composer visible while focus leaves the editor and the keyboard is still closing", () => {
  assert.equal(shouldUseVisualViewportHeight({ hasFocusedEditable: false, innerHeight: 844, viewportHeight: 420, viewportScale: 1, wasUsingVisualViewport: true }), true);
  assert.equal(shouldUseVisualViewportHeight({ hasFocusedEditable: false, innerHeight: 844, viewportHeight: 844, viewportScale: 1, wasUsingVisualViewport: true }), false);
});

test("a previous keyboard measurement never turns pinch zoom into a height override", () => {
  assert.equal(shouldUseVisualViewportHeight({ hasFocusedEditable: false, innerHeight: 844, viewportHeight: 420, viewportScale: 2, wasUsingVisualViewport: true }), false);
});

test("keeps the dynamic viewport height when no editor is focused", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: false,
    innerHeight: 844,
    viewportHeight: 510,
    viewportScale: 1,
  }), false);
});

test("does not mistake pinch zoom for an open keyboard", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    innerHeight: 844,
    viewportHeight: 422,
    viewportScale: 2,
  }), false);
});

test("keeps the dynamic viewport height when the visual viewport is not reduced", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    innerHeight: 844,
    viewportHeight: 844,
    viewportScale: 1,
  }), false);
});
