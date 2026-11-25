# Claude Code 高级控制：Fork、Rewind、权限模式、MCP 等

记录日期：2026-11-21。状态：**仅完成源码编写，未运行测试、类型检查、构建或真实 CC**。回归入口见文末，需另行授权运行。

依据：锁定的 `@anthropic-ai/claude-agent-sdk` 0.3.318 类型定义（`sdk.d.ts`）。所有能力都调用本机 CC 的原生控制请求，网页不替 CC 做决定，也不改写原生 transcript。

## 功能与实现

| 功能 | 网页入口 | 原生接口 | 实现位置 |
| --- | --- | --- | --- |
| Fork | 用户消息上的“新会话” | `forkSession(id, { dir, upToMessageId })` | `ClaudeCodeSession.fork` |
| Rewind（代码/对话） | 用户消息上的“回退” | `rewindFiles(uuid, { dryRun })`、`resumeSessionAt` | `rewindPreview` / `rewind`、`ClaudeRewindDialog` |
| HTML 导出、完整历史 | 顶栏“完整历史” | 无原生导出：渲染网页投影 | `lib/session-html-export.ts`、export 路由 |
| 权限模式 | 输入栏模式按钮 | `setPermissionMode`、`Options.permissionMode` | `set_permission_mode` |
| 始终允许 | 工具审批弹窗 | `canUseTool` 的 `suggestions` → `updatedPermissions` | `permission()`、`lib/claude-permissions.ts` |
| ExitPlanMode | 审批弹窗显示计划 | `setMode` 权限更新 | `permission()` |
| MCP elicitation | 输入/选择弹窗 | `Options.onElicitation` | `elicit()`、`lib/claude-elicitation.ts` |
| 压缩状态 | 输入栏压缩提示、压缩按钮 | `status: compacting`、`compact_boundary` | `lib/claude-system-events.ts` |
| 系统事件 | 通知、状态栏（新出现的状态持续 1 秒才显示，瞬时 hook 不会让布局跳动） | `api_retry`、`hook_*`、`notification`、`permission_denied` 等 | 同上，`includeHookEvents: true`；延迟在 `ExtensionStatusBar` |
| 后台任务 | 任务面板“停止”、运行提示“转到后台” | `stopTask`、`backgroundTasks(toolUseId)` | `stop_task` / `background_tasks` |
| 工具展示 | 工具块 | Edit/Write 结果的 `structuredPatch` | `claudeToolResultDiff`、`lib/tool-input-diff.ts` |
| MCP 面板 | 顶栏 “MCP” | `mcpServerStatus`、`reconnectMcpServer`、`toggleMcpServer` | `ClaudeMcpPanel`、`lib/claude-mcp.ts` |

## Fork 与 Rewind 的边界

- 网页发送时把自己生成的原生 UUID 写入投影（`nativeUuid`）。SDK 文档确认这个 UUID 就是原生用户条目的 UUID，可直接用于 `forkSession` / `rewindFiles`。旧投影没有该字段：只在文字唯一可配对时按出现顺序匹配，否则明确报错，不猜测。
- **Fork** 的语义仍是“该用户消息之前”：`upToMessageId` 取原生链中前一条（`forkSession` 本身是含该条）。Fork 会重映射全部 UUID；新投影按链位置换成新 UUID，对不齐时留空并回退到文字匹配。原会话身份不变，不需要释放旧注册表键。原生 fork 不复制文件检查点。
- **Rewind 代码**：主会话开启 `enableFileCheckpointing`。只能恢复 CC 自己编辑过、且有检查点的文件；Shell 命令、外部修改和远程副作用不会撤销。开启前产生的修改没有检查点，预览会显示不可用。
- **Rewind 对话**：投影追加 `native_rewind` 标记，父节点为目标消息的父节点，旧分支保留在文件中；随后关闭当前 CC 进程（内存中仍有后续轮次）。下次启动用 `resume + resumeSessionAt`，直到新分支上收到助手回复才视为提交。第一条消息不能回退对话（请新建对话），只能恢复代码。原生压缩之前的消息不在原生链中，会明确报错。
- 运行中、有排队消息、待处理弹窗或模型切换时都拒绝 Fork/Rewind。

## 权限

- 网页模式只有 `default`、`acceptEdits`、`plan`、`auto`；`bypassPermissions`、`dontAsk` 不提供。`auto` 是否可用由 CC 按账号/模型判断，失败显示原生错误。运行中也可切换（与终端 Shift+Tab 一致）。网页选择写入投影，进程重启后恢复；未选择时由 CC 自己的设置决定。
- “始终允许”只采用 CC 为本次调用给出的追加型建议（`addRules`、`addDirectories`、非 bypass 的 `setMode`），删除类建议从不应用。分两档：仅本会话（改写为 `session`），或保存到 CC 原生给出的位置（通常是项目 `.claude/settings.local.json`，由 CC 自己写入）。`suppressAlwaysAllowRule` 时不提供。
- ExitPlanMode：显示计划，选项为“批准并自动接受编辑”“批准并逐个审批编辑”“继续规划”（可附反馈，作为拒绝消息交给 CC）。

## Elicitation

- 表单只支持扁平对象中的字符串、数字、布尔、枚举和枚举数组；其他结构直接拒绝（decline）并提示。字段逐个弹窗，非必填可跳过；数字/格式校验失败最多重问三次。
- URL 模式只显示 http/https 链接，由用户自己打开；其他协议拒绝。

## MCP 面板

只返回名称、状态、范围、传输类型、版本、错误和工具名，**不返回** command/args/env/url/headers。启用/禁用只作用于本会话；新增和修改服务器、OAuth 登录仍在终端 `claude mcp` / `/mcp` 中完成。读取面板会按需启动该会话的 CC 进程。

## 回归入口（需授权运行）

```sh
node --test lib/claude-advanced.test.mjs lib/claude-code.test.mjs lib/tool-preview.test.mjs
```

测试使用模拟 SDK 和临时目录，不调用真实 CC 或模型。真实 CC 上的 `rewindFiles`、`resumeSessionAt`、`forkSession` 行为、hook 事件和 elicitation 尚未实测。

## OMP / Pi 对照（2026-11-21）

依据：OMP 上游 `docs/rpc.md` 与 `src/modes/rpc/rpc-types.ts`（main 分支），本机 OMP 16.4.2 的 `src/tools/todo.ts`；本机 Pi 1.6.0 的 `dist/modes/rpc/rpc-types.d.ts`、`dist/core/agent-session.d.ts` 和内置 MCP 扩展。只接入原生 RPC 明确提供的能力；未运行任何引擎。

| 功能 | OMP | Pi | 网页处理 |
| --- | --- | --- | --- |
| Fork | `branch` / `fork` | `fork` / `clone` | 早已接入 |
| Rewind 对话 | `navigate_tree`（“从这里编辑”） | RPC 无导航 | OMP 早已接入；Pi 不提供 |
| Rewind 代码 | 无文件检查点 | 无 | 不提供 |
| HTML 导出、完整历史 | `export_html` | `export_html` | 早已接入 |
| 权限模式 / 始终允许 | 无 RPC 控制（plan 只见于 goal 约束） | 无 | 不提供 |
| MCP elicitation | MCP 仅作 `xd://` 设备，无 elicitation | 内置 MCP 扩展未处理 elicitation | 不提供 |
| 压缩状态 | `auto_/manual_compaction_*` | `compaction_*`（带 reason） | 早已接入；**新增** Pi `summarization_retry_*` → 重试提示 |
| 系统事件 | `notice`、`retry_fallback_applied`、`ttsr_triggered` | 重试事件 | `notice` 早已接入；**新增** OMP 模型回退、规则注入通知（不显示规则正文）。OMP/Pi 无 hook 事件帧 |
| 后台任务 | `cancel_subagent`（无后台 bash 控制） | 无 | **新增** OMP 任务面板“停止”；“转到后台”无原生支持 |
| 工具展示 | 编辑结果自带 diff；`todo` 工具结果 `details.phases` | 编辑结果自带 diff | diff 早已接入；**新增** OMP `todo` 按阶段显示清单，标题显示操作和目标 |
| MCP 面板 | 无 RPC 状态接口（改配置需重启进程） | `/mcp`、`/mcp reconnect` 等命令，只返回文本通知 | 不做结构化面板；Pi 的 `/mcp` 仍可从命令菜单执行 |

新增代码：`lib/omp-rpc-events.ts`、`lib/pi-rpc-adapter.ts`（重试映射）、`AgentSessionWrapper` 的 `stop_task`、`lib/tool-input-diff.ts` 的 `todoGroups`。回归入口：`node --test lib/native-advanced.test.mjs lib/omp-rpc.test.mjs`（需授权运行）。
