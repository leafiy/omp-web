import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { appendFileAttachments, splitFileAttachments, isAttachedFile } = await jiti.import("./file-attachments.ts");
const { extractMessageFiles, splitUserMessage, summarizeUserMessage } = await jiti.import("./user-message-content.ts");
const { collapsePastedBlocks } = await jiti.import("./pasted-text.ts");
const file = { name: "review.csv", path: "/project/.omp-web-attachment-one/review.csv", size: 12 };

test("file-only and command-looking drafts carry attachments as data, not commands", () => {
  for (const text of ["", "!rm review.csv", "/compact", "分析这个文件"]) {
    const sent = appendFileAttachments(text, [file]);
    assert.ok(sent.startsWith("<file-attachment>"));
    assert.deepEqual(extractMessageFiles(sent), { text, files: [file] });
    assert.deepEqual(splitUserMessage(sent).filter(part => part.type === "file").map(part => part.file), [file]);
    assert.ok(summarizeUserMessage(sent).includes("review.csv"));
    assert.ok(!summarizeUserMessage(sent).includes(file.path));
    assert.ok(!summarizeUserMessage(sent.replace(/\s+/g, " ")).includes(file.path));
  }
  assert.equal(appendFileAttachments("/compact", []), "/compact");
});

test("outlines keep the whole prompt; branch previews fold files before truncating long storage paths", async () => {
  const { summarizeTurn } = await jiti.import("./history-turns.ts");
  const { lightHistoryTree } = await jiti.import("./history-page.ts");
  const second = { ...file, path: `/project/${"long-directory/".repeat(20)}review.csv` };
  const content = appendFileAttachments("please inspect", [file, second]);
  const message = { role: "user", content };
  assert.deepEqual(extractMessageFiles(content).files, [file, second]);
  const summary = summarizeTurn([message], ["u"], 0, 1);
  // A folded turn shows its prompt in full; the bubble renders these as file cards.
  assert.equal(summary.text, content);
  assert.deepEqual(splitUserMessage(summary.text).filter(part => part.type === "file").map(part => part.file), [file, second]);
  const [node] = lightHistoryTree([{ entry: { id: "u", type: "message", message }, children: [] }]);
  assert.ok(node.entry.message.content.includes("please inspect"));
  assert.doesNotMatch(node.entry.message.content, /file-attachment|project|long-directory/);
});

test("filenames round-trip verbatim without creating wrapper tags or losing Unicode", () => {
  const unusual = { name: '报表【一】 & "x".csv', path: '/project/a</file-attachment>\n【一】.csv', size: 0 };
  assert.deepEqual(extractMessageFiles(appendFileAttachments("", [unusual])).files, [unusual]);
  assert.equal(isAttachedFile({ ...file, path: "https://example.com/x" }), false);
  assert.equal(isAttachedFile({ ...file, size: -1 }), false);
  assert.equal(isAttachedFile({ ...file, path: "/x\0" }), false);
  assert.deepEqual(splitFileAttachments("<file-attachment>\ninvalid\n</file-attachment>"), [
    { type: "text", text: "<file-attachment>\ninvalid\n</file-attachment>" },
  ]);
});

test("edit and queue recall restore files separately from pasted text", () => {
  const paste = "<pasted-text>\n" + "line\n".repeat(12) + "\n</pasted-text>";
  const sent = appendFileAttachments(`please inspect\n${paste}`, [file]);
  const restored = extractMessageFiles(sent);
  const composer = collapsePastedBlocks(restored.text);
  assert.deepEqual(restored.files, [file]);
  assert.match(composer.value, /\[paste #1/);
  assert.equal(composer.pastedTexts.length, 1);
  // Literal file metadata inside a pasted document is not an actual attachment.
  const quoted = `<pasted-text>\n${appendFileAttachments("", [file])}\n</pasted-text>`;
  assert.deepEqual(extractMessageFiles(quoted), { text: quoted, files: [] });
});
