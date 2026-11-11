import assert from "node:assert/strict";
import test from "node:test";
import { getToolPreview } from "./tool-preview.ts";

const questions = [
  { question: "使用哪种语言？", header: "语言", options: [{ label: "中文" }] },
  { question: "选择哪个环境？", header: "环境", options: [{ label: "本地" }] },
  { question: "是否继续？", header: "确认", options: [{ label: "继续" }] },
];

test("AskUserQuestion preview displays questions instead of object coercion", () => {
  const preview = getToolPreview({ toolName: "AskUserQuestion", input: { questions } });
  assert.equal(preview, "使用哪种语言？ · 选择哪个环境？ · 是否继续？");
  assert.ok(!preview.includes("[object Object]"));
});

test("answered questions display the native result text", () => {
  const result = "User has answered your questions: 使用哪种语言？=中文";
  assert.equal(getToolPreview({ toolName: "AskUserQuestion", input: { questions } }, result), result);
});

test("updated input answers provide a readable fallback", () => {
  assert.equal(getToolPreview({ toolName: "AskUserQuestion", input: {
    questions, answers: { "使用哪种语言？": "中文", "选择哪个环境？": "本地" },
  } }), "使用哪种语言？ → 中文 · 选择哪个环境？ → 本地");
});

test("empty results retain the questions and malformed questions stay readable", () => {
  for (const result of [null, "", "  ", "(no output)"]) {
    assert.equal(getToolPreview({ toolName: "AskUserQuestion", input: { questions } }, result),
      "使用哪种语言？ · 选择哪个环境？ · 是否继续？");
  }
  const preview = getToolPreview({ toolName: "AskUserQuestion", input: { questions: [null, { header: "Choice" }] } });
  assert.ok(!preview.includes("[object Object]"));
});

test("other tools retain familiar previews and structured values use JSON", () => {
  for (const key of ["command", "path", "file_path", "pattern", "query"]) {
    assert.equal(getToolPreview({ toolName: "other", input: { [key]: "example" } }, "ignored result"), "example");
  }
  assert.equal(getToolPreview({ toolName: "other", input: { items: [{ name: "a" }] } }), '[{"name":"a"}]');
  assert.equal(getToolPreview({ toolName: "other", input: {} }), "");
});

test("question summaries remain single line and bounded", () => {
  const preview = getToolPreview({ toolName: "AskUserQuestion", input: { questions } }, "答案\n" + "长".repeat(200));
  assert.equal(preview.length, 120);
  assert.ok(!preview.includes("\n"));
});
