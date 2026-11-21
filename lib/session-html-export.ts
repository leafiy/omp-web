import type { AgentMessage, AssistantContentBlock, ImageContent, TextContent } from "./types";
import { splitUserMessage } from "./user-message-content";
import { countLines } from "./pasted-text";

/**
 * Self-contained, script-free HTML for a web display projection (engines whose
 * CLI has no native HTML export). Every value is escaped; images are inlined
 * only as validated base64 data URLs of common raster types.
 */
export interface SessionHtmlInput {
  title: string;
  engineLabel: string;
  cwd: string;
  created?: string;
  messages: AgentMessage[];
}

const MAX_TEXT = 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function clip(value: string, max = MAX_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters)` : value;
}

/** Minimal Markdown: fenced code blocks and inline code; everything else keeps its line breaks. */
function markdown(text: string): string {
  const parts = clip(text).split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m);
  return parts.map((part) => {
    const fence = part.match(/^```([^\n]*)\n([\s\S]*?)```[ \t]*$/);
    if (fence) return `<pre class="code"${fence[1].trim() ? ` data-lang="${escape(fence[1].trim())}"` : ""}><code>${escape(fence[2].replace(/\n$/, ""))}</code></pre>`;
    if (!part.trim()) return "";
    const html = escape(part).replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return `<div class="md">${html}</div>`;
  }).join("");
}

function image(block: ImageContent): string {
  const type = block.source.media_type ?? "";
  const data = block.source.data ?? "";
  if (block.source.type !== "base64" || !IMAGE_TYPES.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return `<div class="note">[image]</div>`;
  return `<img alt="" src="data:${type};base64,${data}">`;
}

function blocks(content: string | (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function userHtml(content: string | (TextContent | ImageContent)[]): string {
  return blocks(content).map((block) => {
    if (block.type === "image") return image(block);
    return splitUserMessage(block.text).map((segment) => {
      if (segment.type === "paste") return `<details class="paste"><summary>Pasted text · ${countLines(segment.text)} lines</summary><pre>${escape(clip(segment.text))}</pre></details>`;
      if (segment.type === "file") return `<span class="file">📎 ${escape(segment.file.name)}</span>`;
      return segment.text.trim() ? `<div class="md">${escape(clip(segment.text))}</div>` : "";
    }).join("");
  }).join("");
}

function diffHtml(text: string): string {
  return `<pre class="diff">${clip(text).split("\n").map((line) => {
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
    return kind ? `<span class="${kind}">${escape(line)}</span>` : escape(line);
  }).join("\n")}</pre>`;
}

function resultText(message: Extract<AgentMessage, { role: "toolResult" }> | undefined): string {
  return message ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") : "";
}

function toolHtml(block: Extract<AssistantContentBlock, { type: "toolCall" }>, result?: Extract<AgentMessage, { role: "toolResult" }>): string {
  const input = block.input ?? {};
  const preview = ["command", "file_path", "path", "pattern", "query", "description"].map((key) => input[key]).find((value) => typeof value === "string") as string | undefined;
  const details = result?.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
  const diff = typeof details.diff === "string" ? details.diff : typeof details.patch === "string" ? details.patch : undefined;
  const output = resultText(result);
  const status = !result ? "pending" : result.isError ? "error" : "ok";
  return `<details class="tool ${status}"><summary><b>${escape(block.toolName)}</b>${preview ? ` <span>${escape(preview.slice(0, 160))}</span>` : ""}</summary>`
    + `<pre>${escape(clip(JSON.stringify(input, null, 2) ?? ""))}</pre>`
    + (diff ? diffHtml(diff) : output.trim() ? `<pre class="output">${escape(clip(output))}</pre>` : "")
    + `</details>`;
}

export function renderSessionHtml(input: SessionHtmlInput): string {
  const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
  for (const message of input.messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
  const body = input.messages.map((message) => {
    const time = message.timestamp ? `<time>${escape(new Date(message.timestamp).toISOString().replace("T", " ").slice(0, 19))}</time>` : "";
    if (message.role === "user") return `<section class="msg user"><header>User ${time}</header>${userHtml(message.content)}</section>`;
    if (message.role === "assistant") {
      const content = message.content.map((block) => {
        if (block.type === "text") return markdown(block.text);
        if (block.type === "thinking") return block.thinking.trim() ? `<details class="thinking"><summary>Thinking</summary><pre>${escape(clip(block.thinking))}</pre></details>` : "";
        if (block.type === "toolCall") return toolHtml(block, results.get(block.toolCallId));
        if (block.type === "image") return image(block);
        return "";
      }).join("");
      const error = message.errorMessage ? `<div class="note error">${escape(message.errorMessage)}</div>` : "";
      if (!content && !error) return "";
      return `<section class="msg assistant"><header>${escape(message.model || "Assistant")} ${time}</header>${content}${error}</section>`;
    }
    if (message.role === "bashExecution") return `<section class="msg tool-msg"><header>$ ${escape(message.command)} ${time}</header><pre>${escape(clip(message.output))}</pre></section>`;
    if (message.role === "custom" && message.display) return `<section class="msg note-msg">${userHtml(message.content)}</section>`;
    return "";
  }).join("\n");
  const title = input.title || "Session";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--panel:#f6f7f9;--text:#1f2328;--muted:#656d76;--border:#d0d7de;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--text:#e6edf3;--muted:#8b949e;--border:#30363d;--accent:#58a6ff}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:18px;margin:0 0 4px}.meta{color:var(--muted);font-size:12px;margin-bottom:24px;font-family:ui-monospace,monospace}
.msg{margin:0 0 18px;padding:12px 14px;border:1px solid var(--border);border-radius:8px}
.msg.user{background:var(--panel)}.msg header{color:var(--muted);font-size:11px;margin-bottom:6px;font-family:ui-monospace,monospace}
time{margin-left:6px}.md{white-space:pre-wrap;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel);padding:8px 10px;border-radius:6px;margin:6px 0}
code{font-family:ui-monospace,monospace;font-size:12px}details{margin:6px 0}summary{cursor:pointer;color:var(--muted);font-size:12px}
.tool summary b{color:#16a34a;font-family:ui-monospace,monospace}.tool.error summary b{color:#ef4444}.tool summary span{font-family:ui-monospace,monospace}
.diff .add{color:#16a34a}.diff .del{color:#ef4444}.diff .hunk{color:var(--accent)}
img{max-width:100%;border-radius:6px;margin:6px 0}.file{display:inline-block;padding:2px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;margin:2px 4px 2px 0}
.note{color:var(--muted);font-size:12px}.note.error{color:#ef4444}
</style></head>
<body><main><h1>${escape(title)}</h1><div class="meta">${escape(input.engineLabel)} · ${escape(input.cwd)}${input.created ? ` · ${escape(input.created)}` : ""}</div>
${body || `<p class="note">No messages.</p>`}
</main></body></html>`;
}
