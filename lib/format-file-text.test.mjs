import assert from "node:assert/strict";
import test from "node:test";
import { formatFileText } from "./format-file-text.ts";

test("JSON formatting retains token spellings, duplicate keys and final newline", async () => {
  const text = '{"x":9007199254740993,"x":["a, }",{}]}\n';
  assert.equal(await formatFileText("data.json", text), '{\n  "x": 9007199254740993,\n  "x": [\n    "a, }",\n    {}\n  ]\n}\n');
});

test("formatting JS changes spacing without executing the source", async () => {
  assert.equal(await formatFileText("script.js", "const x=1+2;\n"), "const x = 1 + 2;\n");
});

test("invalid drafts and unsupported formats are rejected", async () => {
  await assert.rejects(formatFileText("data.json", "{"));
  await assert.rejects(formatFileText("script.ts", "const = ;"));
  await assert.rejects(formatFileText("notes.md", "plain text"));
});
