import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dialogs = new Set(["alert", "prompt", "confirm"]);
const globals = new Set(["window", "globalThis", "self"]);
const root = fileURLToPath(new URL("..", import.meta.url));
function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}
function browserDialogReferences(text, filename = "fixture.tsx") {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const hits = [];
  const global = (node) => ts.isIdentifier(unwrap(node)) && globals.has(unwrap(node).text);
  function visit(node) {
    let forbidden = false;
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      forbidden = ts.isIdentifier(expression) && dialogs.has(expression.text);
    }
    if (ts.isPropertyAccessExpression(node) && global(node.expression)) forbidden ||= dialogs.has(node.name.text);
    if (ts.isElementAccessExpression(node) && global(node.expression) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) forbidden ||= dialogs.has(node.argumentExpression.text);
    if (ts.isVariableDeclaration(node) && node.initializer && global(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      forbidden ||= node.name.elements.some((element) => {
        const name = element.propertyName ?? element.name;
        return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && dialogs.has(name.text);
      });
    }
    if (forbidden) hits.push(`${filename}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return hits;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("the browser-dialog guard catches native calls/aliases but not agent prompts or ARIA alerts", () => {
  for (const source of ["alert('x')", "window.confirm('x')", "window?.prompt('x')", "self['alert']('x')", "const ask = globalThis.confirm", "const { prompt: ask } = window"]) {
    assert.ok(browserDialogReferences(source).length > 0, source);
  }
  assert.deepEqual(browserDialogReferences("agent.prompt('x'); ui.confirm('Title', 'Text'); const body = {confirm: true}; const x = <div role='alert'/>;"), []);
});

test("application sources contain no blocking browser alert, prompt or confirm references", async () => {
  const files = (await Promise.all(["components", "hooks", "app", "lib", "bin", "public"].map((dir) => sourceFiles(join(root, dir))))).flat();
  const hits = [];
  for (const file of files) hits.push(...browserDialogReferences(await readFile(file, "utf8"), file));
  assert.deepEqual(hits, [], "Use a non-blocking frontend confirmation/input/notice instead of browser dialogs");
});
