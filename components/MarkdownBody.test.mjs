import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
      }, markdown),
    ),
  );
}

test("renders Chinese strong emphasis ending in punctuation inside nested quotes", () => {
  const html = renderMarkdown("> > **注意：**层级增加后，手机上仍应保留足够的文字宽度。");
  assert.match(html, /<strong>注意：<\/strong>层级增加后/);
});

test("renders Chinese strong questions adjacent to following prose", () => {
  const html = renderMarkdown("**是否允许我运行本地 Markdown 渲染测试，复现并验证修复？**仅使用现有依赖。");
  assert.match(html, /<strong>是否允许我运行本地 Markdown 渲染测试，复现并验证修复？<\/strong>仅使用/);
});

test("preserves code, escaped markers and incomplete streaming emphasis", () => {
  for (const markdown of [
    "`**注意：**层`",
    "```text\n**注意：**层\n```",
    "> > ```text\n> > **注意：**层\n> > ```",
    String.raw`\*\*注意：\*\*层`,
    "**注意：",
  ]) {
    const html = renderMarkdown(markdown);
    assert.doesNotMatch(html, /<strong>|<em>/);
    assert.match(html, /注意/);
  }
});

test("supports Chinese italic, combined emphasis and ordinary Markdown", () => {
  assert.match(renderMarkdown("*注意：*层"), /<em>注意：<\/em>层/);
  assert.match(renderMarkdown("***注意：***层"), /<em><strong>注意：<\/strong><\/em>层/);
  const html = renderMarkdown("**bold** and *italic* and ~~removed~~");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>removed<\/del>/);
});

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});
