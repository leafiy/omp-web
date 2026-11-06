import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, filterModelOptions, buildSlashCommandLayout, slashCommandsForEngine } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelScopeWarningBanner, {
      warnings: ['No models match pattern "ghost-gateway/*"'],
    }),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(renderToStaticMarkup(React.createElement(ModelScopeWarningBanner, { warnings: [] })), "");
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("slash-command layout keeps Claude native commands in their own group", () => {
  const native = { name: "review", description: "Review project changes", source: "claude", argumentHint: "<path>" };
  const web = { name: "copy", description: "Copy the last response", source: "builtin" };
  const layout = buildSlashCommandLayout([native, web], {});
  assert.deepEqual(layout.commands, [web, native]);
  assert.deepEqual(layout.groups.map((group) => group.source), ["builtin", "claude"]);
  assert.deepEqual(layout.groups.flatMap((group) => group.items.map((item) => item.index)), [0, 1]);
});

test("Claude native commands replace web aliases and bypass extended-chat filtering", () => {
  const native = ["usage", "compact", "help", "review"].map((name) => ({ name, source: "claude", description: name }));
  const commands = slashCommandsForEngine("claude", native);
  for (const command of native) assert.deepEqual(commands.filter((row) => row.name === command.name), [command]);
  assert.equal(commands.some((row) => row.name === "reload"), false);
  assert.equal(commands.some((row) => row.name === "session"), false);
  assert.ok(commands.some((row) => row.source === "builtin" && row.name === "copy"));
  assert.deepEqual(slashCommandsForEngine("claude", native, true), native);
  assert.ok(!slashCommandsForEngine("codex", []).some((row) => row.name === "compact"));
  assert.ok(slashCommandsForEngine("omp", []).some((row) => row.name === "compact"));
});

test("filters model options by name and id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "OpenAI").length, 0);
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});
