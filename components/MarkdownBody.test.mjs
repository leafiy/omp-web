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

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        ...props,
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

test("preserves sandbox download links through the full sanitization pipeline", () => {
  for (const path of ["/tmp/review2_已补齐人工标注.tsv", "/outside/project/report.tsv"]) {
    const html = renderMarkdown(`[下载文件](sandbox:${path})`);
    const href = path.split("/").map(encodeURIComponent).join("/");
    assert.ok(html.includes(`<a href="${href}">下载文件</a>`), html);
    assert.doesNotMatch(html, /target=/);
  }
});

test("keeps unsafe links blocked with local protocol normalization enabled", () => {
  for (const url of ["javascript:alert%281%29", "data:text/html,hello", "sandbox://host/file", "sandbox:relative.tsv"]) {
    const html = renderMarkdown(`[link](${url})`);
    assert.doesNotMatch(html, /href="(?:javascript:|data:|sandbox:|\/\/host)/);
  }
  assert.doesNotMatch(renderMarkdown('<a href="javascript:alert(1)" onclick="alert(1)">bad</a>'), /href="javascript:|onclick=/);
});

test("offers a separate session-scoped download next to the preview link", () => {
  const sessionId = "pi:12345678-1234-1234-1234-123456789abc";
  const html = renderMarkdown("[下载文件](sandbox:/tmp/标注.tsv)", { sessionId });
  assert.match(html, /<a href="\/tmp\/%E6%A0%87%E6%B3%A8.tsv">下载文件<\/a>/);
  assert.match(html, /href="\/api\/files\/[^" ]+\?type=download&amp;sessionId=pi%3A12345678-1234-1234-1234-123456789abc"/);
  assert.match(html, /download="标注.tsv"/);
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
