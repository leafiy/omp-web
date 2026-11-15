import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("sandbox download survives markdown filtering and resolves to a session-referenced file", async () => {
  const { markdownUrlTransform } = await jiti.import("./markdown-urls.ts");
  const { resolveLocalFileHref } = await jiti.import("./file-links.ts");
  const { isFilePathReferencedByEntries } = await jiti.import("./session-file-references-core.ts");
  for (const path of ["/tmp/review2_已补齐人工标注.tsv", "/other/location/report.tsv"]) {
    const markdown = `[下载文件](sandbox:${path})`;
    let resolved;
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: { a({ href, children }) {
        resolved = resolveLocalFileHref(href, "/project");
        return createElement("a", { href }, children);
      } },
      children: markdown,
    }));
    assert.equal(resolved, path);
    assert.match(html, /href="\//);
    const entries = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: markdown }] } }];
    assert.equal(isFilePathReferencedByEntries(path, entries), true);
    assert.equal(isFilePathReferencedByEntries(`${path}.other`, entries), false);
    assert.equal(isFilePathReferencedByEntries(path, []), false);
  }
});

test("keeps unsafe protocols and sandbox hosts blocked", async () => {
  const { markdownUrlTransform } = await jiti.import("./markdown-urls.ts");
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "sandbox://host/file", "sandbox:relative.tsv"]) {
    assert.equal(markdownUrlTransform(url, "href"), "");
  }
  assert.equal(markdownUrlTransform("sandbox:/tmp/image.png", "src"), "");
  assert.equal(markdownUrlTransform("https://example.com/file.tsv", "href"), "https://example.com/file.tsv");
});
