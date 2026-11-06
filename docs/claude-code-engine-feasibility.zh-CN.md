# 当前 omp-web 接入 Claude Code 的可行性

调研日期：2026-11-04。范围：本机 `/opt/omp-web` 当前工作树及 Anthropic 官方文档。工作树存在大量未提交修改，结论针对所读源码，不代表上游原版或生产构建已具有新增能力。

## 结论

可以改造成 OMP / Pi / Claude Code 三引擎网页，但当前聊天后端不支持 Claude Code，不能只替换可执行文件。独立内嵌终端已经具备启动普通 shell 的结构，因此可作为运行 `claude` TUI 的入口；这不是聊天界面集成，且本次没有实测终端运行 Claude。

本机存在 `/root/2/devbox-distrobox/.local/bin/claude`，版本命令返回 `2.1.318 (Claude Code)`。这不证明认证、服务环境或模型调用可用。

## 源码依据

- `lib/engine.ts:1` 只定义 `"omp" | "pi"`；未知引擎明确拒绝，网页 ID 仅区分 `pi:` 与 OMP。
- `lib/agent-rpc-client.ts:143-166` 按引擎启动 `--mode rpc` / `--mode rpc-ui`，处理其专有 JSONL 协议。Claude Code 使用不同的 CLI / SDK 协议；配置 `OMP_WEB_EXECUTABLE=claude` 不构成兼容。
- `lib/rpc-manager.ts:35-100` 与后续命令分派耦合 OMP/Pi 命令、提示完成、状态和交互框。已经有多引擎入口，但尚不是可直接插入任意 SDK 的通用接口。
- `lib/session-reader.ts:19,92` 从两套 agent sessions 目录扫描并合并历史；需要 Claude 专用历史读取，不能拿现有解析器原样套用。
- `hooks/useAgentSession.ts` 消费 `message_update`、`tool_execution_start/end`、`extension_ui_request` 等网页事件。Claude 原生消息需要转换。
- `lib/terminal-manager.ts:16-22` 使用 node-pty 启动普通 shell，独立于聊天 RPC。
- 现有隔离、身份和生命周期约束见 [native-omp.zh-CN.md](./native-omp.zh-CN.md)。

## 官方可用接入面

建议优先使用 `@anthropic-ai/claude-agent-sdk` TypeScript SDK，在服务器运行 Claude Code，不是只调用 Anthropic Messages API。官方说明 SDK 提供 Claude Code 的工具、agent loop 和上下文管理。[1][2]

官方 TypeScript API 提供：[2]

- `query()` 和流式输入/输出；原生工具调用及结果。
- `canUseTool` 权限回调，可接网页审批；不是所有调用都会进入回调，已有 allow 规则和权限模式可能预批准。
- `resume`、`listSessions()`、`getSessionMessages()` 与 `forkSession()`。
- `interrupt()`、`supportedModels()`、`supportedCommands()` 等控制能力。具体操作有版本和输入模式要求。
- `pathToClaudeCodeExecutable` 可明确绑定已有本机二进制；SDK 也有捆绑二进制机制，接入时必须明确选择并检查版本组合。
- `systemPrompt: { type: 'preset', preset: 'claude_code' }` 使用 Claude Code 系统提示；不能假定 SDK 默认提示就是终端完整提示。
- `settingSources` 控制配置来源；读取 CLAUDE.md 要注意项目配置来源和提示设置，不能笼统承诺所有 CLI 插件/交互都自动等价。

CLI 本身支持 `-p --output-format stream-json --verbose --include-partial-messages`，也有 `--input-format stream-json` 与会话恢复能力。[3] 直接包装 CLI 是另一条路线，但需自行维护交互权限、控制消息、重连和生命周期；仅抓取终端文本不适合作为结构化聊天实现。

## 建议改造范围（设计判断，未实施）

1. 增加 `claude` 引擎及 `claude:<nativeId>` 网页身份；已有会话不能被下拉框重新标记引擎。
2. 在会话管理处增加独立 Claude adapter，复用注册表和 SSE 外壳，不把 Claude SDK 硬塞进 OMP 的传输解析器。
3. 转换文本增量、完整 assistant 消息、tool_use/tool_result、结果/错误和 usage；防止增量与最终消息重复展示，区分主会话和子代理。
4. 独立维护 Claude 会话历史与认证/config 来源。优先使用 SDK 历史 API，避免改写原生 JSONL；恢复只指定目标 session ID，不能使用最近会话代替。
5. 权限回调接入带 ID 的网页对话框，支持允许、拒绝、断线、重连和取消。初始化无人应答时不能默认放行。AskUserQuestion 等结构化提问需单独适配，不能只做通用确认框。
6. 新增按引擎能力显示 UI 的规则；OMP 的树导航、steer、队列撤回、thinking 等不应默认映射到 Claude。不存在等价能力就隐藏或返回明确错误。
7. 文件浏览、上传落盘、Git/worktree、终端与页面布局可复用；图片消息需转换成 SDK 支持的内容块，上传成功不代表任意格式都能被模型理解。

特别注意 Fork：当前网页消息 Fork 定义为“该用户消息之前”，官方 `forkSession({upToMessageId})` 定义为“包含指定消息”；必须处理边界差异。[2]

## 风险与边界

- 原生 SDK/CLI 的一轮 result 与整个进程结束、后台任务全部完成不是一回事；官方说明非交互运行可能继续等待后台工作。不能直接照搬 OMP settled 规则。[3]
- 非交互模式会加载项目 hooks/MCP 等，可能在首次模型请求前执行项目资源；增加 Claude 引擎需要明确可信目录和配置加载策略。[3]
- 复用会话历史不等于实时接管一个已经在终端运行的 Claude 进程；同一会话并发写入应单独防护。
- Claude 认证独立，不能拷贝 OMP/Pi 凭据。SDK 官方对第三方产品提供 claude.ai 登录或订阅额度有明确限制，除非事先获准，应使用官方支持的 API key 路线。个人本地包装与面向他人的产品不能混为一谈；本次未核实本机登录状态，也不承诺订阅可用于 SDK 集成。[1]
- 若需求是立即在浏览器使用 Claude 而非统一 omp-web，可参考已有 [候选调研](./claude-code-web-ui-research.zh-CN.md) 的 CloudCLI/HAPI；该文件记录的是此前调研，不是本次部署验证。

## 推荐推进

先做最小垂直切片：新建 Claude 会话 → 流式聊天 → 一次工具审批 → 停止 → 刷新恢复；验证后再补历史导入、模型选择、附件、Fork 和子代理。工作量属于新增后端适配，而非一项配置开关；未做原型前不给确定工期。

本次没有安装依赖、调用模型、启动聊天 agent、运行测试、构建或重启服务。仅源码/官方文档调研与一次 `claude --version`；新增本文件，不改现有实现。

## 官方来源

1. Agent SDK overview（含认证使用限制）：https://code.claude.com/docs/en/agent-sdk/overview.md
2. TypeScript API reference：https://code.claude.com/docs/en/agent-sdk/typescript.md
3. Run Claude Code programmatically：https://code.claude.com/docs/en/headless.md

在线文档会变化；实现时需锁定 SDK 版本，并按目标 CLI 能力验证，不能把最新文档中所有 API 一概视为已安装版本可用。
