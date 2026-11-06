import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { slashArgumentCompletions } = await jiti.import("./slash-command-arguments.ts");
const { claudeSlashCommands } = await jiti.import("./claude-code-commands.ts");
const hint = "<low|medium|high|xhigh|max|auto|ultracode [on|off]>";
const commands = [{ name: "effort", argumentHint: hint }];
const values = (text, catalog = commands) => slashArgumentCompletions(text, catalog).map((item) => item.value);

test("effort offers literal parameters after the command separator", () => {
  assert.deepEqual(values("/effort "), ["low", "medium", "high", "xhigh", "max", "auto", "ultracode"]);
  assert.deepEqual(values("/effort h"), ["high"]);
  assert.deepEqual(values("/effort H"), ["high"]);
  assert.deepEqual(values("/effort x"), ["xhigh"]);
  assert.deepEqual(values("/effort nope"), []);
});

test("nested optional arguments belong only to their native branch", () => {
  assert.deepEqual(values("/effort ultracode "), ["on", "off"]);
  assert.deepEqual(values("/effort ultracode of"), ["off"]);
  assert.deepEqual(values("/effort high "), []);
  assert.deepEqual(values("/effort ultracode on "), []);
});

test("completion replaces only the partial token and preserves spacing", () => {
  assert.deepEqual(slashArgumentCompletions("/effort\tultracode  of", commands), [
    { value: "off", text: "/effort\tultracode  off " },
  ]);
  assert.deepEqual(slashArgumentCompletions("/effort h", commands), [
    { value: "high", text: "/effort high " },
  ]);
});

test("other native commands and aliases use their own explicit hints", () => {
  const catalog = [{ name: "format", argumentHint: "[json|text] [brief|full]" }, { name: "f", argumentHint: "<json|text>" }];
  assert.deepEqual(values("/format json ", catalog), ["brief", "full"]);
  assert.deepEqual(values("/f t", catalog), ["text"]);
  assert.deepEqual(values("/absent ", catalog), []);
});

test("opaque placeholders, prose, malformed or oversized hints are not fabricated choices", () => {
  for (const argumentHint of ["", "<path>", "[level]", "<file> [on|off]", "[on|off] (optional)", "<on||off>", "<on|off", "<on|off>]", "<on|off>".repeat(100), "<on|off>".repeat(16)]) {
    assert.deepEqual(values("/test ", [{ name: "test", argumentHint }]), [], argumentHint);
  }
  for (const input of ["/effort", "effort ", "hello /effort ", "/effort high\n", "/effort \nlow"]) assert.deepEqual(values(input), []);
});

test("native effort hints win; only the builtin effort receives the syntax fallback", () => {
  const row = (extra = {}) => ({ name: "effort", description: "Effort", argumentHint: "", ...extra });
  const native = claudeSlashCommands([row({ builtin: true, argumentHint: "<low|high>" })]);
  assert.deepEqual(values("/effort ", native), ["low", "high"]);
  for (const argumentHint of ["", "[level]", "<level>"]) {
    const fallback = claudeSlashCommands([row({ builtin: true, argumentHint })]);
    assert.deepEqual(values("/effort ", fallback), ["low", "medium", "high", "xhigh", "max", "auto", "ultracode"]);
    assert.deepEqual(values("/effort ultracode ", fallback), ["on", "off"]);
  }
  assert.deepEqual(values("/effort ", claudeSlashCommands([row()])), []);
  assert.deepEqual(values("/effort ", claudeSlashCommands([row({ argumentHint: "<path>", builtin: true })])), []);
});
