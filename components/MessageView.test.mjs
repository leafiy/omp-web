import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("sent ordinary files render as cards beside images, not path references or metadata", async () => {
  const { appendFileAttachments } = await jiti.import("../lib/file-attachments.ts");
  const text = appendFileAttachments("Please review", [{ name: "review.csv", path: "/project/.omp-web-attachment-a/review.csv", size: 12 }]);
  const html = renderMessage({ role: "user", content: [
    { type: "text", text },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ] });
  assert.match(html, /data-file-attachment/);
  assert.match(html, />review.csv</);
  assert.match(html, />12 B</);
  assert.match(html, /Please review/);
  assert.match(html, /<img/);
  assert.doesNotMatch(html, /&lt;file-attachment&gt;|&quot;path&quot;|\[@review.csv\]/);
  assert.doesNotMatch(html, /Remove attachment/);
});

test("sent text has a quick edit action without native history navigation", () => {
  const html = renderMessage({ role: "user", content: "original input", timestamp: 1 }, { onEditContent() {} });
  assert.match(html, /aria-label="Edit"/);
  assert.match(html, /without rewriting history/);
  assert.doesNotMatch(html, /Edit from here/);
});

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});
