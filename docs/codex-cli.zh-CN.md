# Codex CLI 网页聊天

状态（2026-11-05）：**用户已授权验证与上线。99 项模拟/相关回归、类型检查、真实 Codex 的模型目录与空会话恢复、隔离构建、构建后 API 和桌面/手机浏览器模拟验证均已通过。生产切换结果见 `/opt/omp-web-codex-release-c8H1wcVC/status.json`：`active` 表示已上线，`rolled_back` 表示已恢复旧版。** 没有读取或复制登录凭据，没有更新 CLI、安装依赖或发送真实模型提示。

> 后续多机部署按用户要求改为纯原生访问层：不再覆写 Codex 的功能开关、沙箱或审批设置，也不删除原生提供方环境变量。新部署使用目标机器自己的 CLI、配置和登录；网页仍只封装已支持的交互。当前边界见[多机部署](./native-host-deployment.zh-CN.md)，订阅统计见[用量面板](./subscription-usage.zh-CN.md)。下文部分内容记录最初接入阶段。

## 上线后怎么用

1. 在聊天页面的引擎菜单选 **Codex CLI**。
2. 选择项目和模型，直接发消息。
3. 需要你授权时，网页会弹出确认；可以拒绝或仅允许这一次。

它直接使用本机 Codex 的登录和配置，不经过 Claude Code 的代理。未登录时，在终端运行 `codex login`；不需要把密码、token 或 Cookie 发到聊天里。

## 本版接入范围

- 新建对话、文字流式回复、模型选择、图片输入传递、停止。
- 命令/文件修改审批和普通文本提问。关闭、取消、超时或停止均不批准；不提供“总是允许”。没有可审查差异的文件审批、永久写入根目录请求、秘密输入和未实现的请求类型拒绝处理。
- 网页历史、标题、重新打开同一个原生会话。首次仅列出网页创建的 Codex 对话，不导入或主动接管终端会话。
- 暂不提供 Fork/树跳转、发送队列、手动压缩、思考强度覆盖、独立 shell 命令、后台任务控制、HTML 导出或历史删除。对应网页控件隐藏，旧客户端请求明确报错。

后端已用假 app-server 验证这些流程；浏览器使用假服务验证文字流式显示、审批、停止、刷新恢复和 390px 布局。真实 Codex 已验证初始化、6 项模型目录、新建空会话和进程重启后的精确恢复。**没有发送真实模型提示，因此真实回复、实际工具执行和图片兼容性仍待用户测试。** 普通文件沿用现有上传/路径引用。

## 维护信息

链路：浏览器 → 现有 Next.js / SSE → `CodexSession` → `codex app-server --listen stdio://`。不复用 OMP/Pi 的 RPC 解码器，不新增公开端口，不安装 Codex SDK。

配置：

| 变量 | 用途 |
| --- | --- |
| `OMP_WEB_CODEX_EXECUTABLE` | 本机单个可执行文件；默认服务 PATH 中的 `codex`，与设置里的 Codex 更新按钮一致 |
| `OMP_WEB_CODEX_HOME` | 可选，指定 Codex 自己的配置/登录/原生历史目录；其次使用 `CODEX_HOME`，默认 `~/.codex` |
| `OMP_WEB_CODEX_STATE_DIR` | 网页展示历史目录，默认 `~/.local/state/omp-web/codex`，不能混入其他引擎的历史目录 |

- Codex 自己读取/刷新自己的登录，网页适配器不打开 auth 文件、不把代理 OAuth 或 OMP/Pi 登录转换给 Codex。子进程只清除网页访问密码、网页专用变量和父进程会话信息，保留操作者为原生 CLI 配置的提供方环境。部署不从来源机器复制这些环境或登录。
- 网页 ID 是 `codex:<原生 UUID>`。恢复只传精确 `threadId`，不传投影文件路径或“最近会话”。网页投影不是模型上下文；崩溃时两者可能有短暂差异，尚无离线重建工具。已有活动线程明确拒绝附着；不承诺跨终端进程的租约接管。
- 创建/恢复只传工作目录、精确线程 ID 和用户明确选择的模型，不强制覆盖原生沙箱、审批或审核器设置。网页不主动添加免审批/全权限参数，实际权限由该 CLI 配置决定；**不是所有读写都会弹窗**。
- 启动不再添加 `features.*=false` 覆盖；原生指令、技能、hooks、插件和 MCP 由 Codex 自己管理。初始化可能加载这些本机资源，所以无模型提示不等于完全没有初始化副作用。网页不是完整 TUI，未封装的操作仍明确拒绝，不自动批准无法呈现的交互。
- 只处理所属 `threadId` 和当前 `turnId` 的事件；子线程和迟到的旧 turn 不能污染聊天或提前结束新请求。`turn/start` 回复前的事件先缓冲；停止确认不是完成，等待匹配的 `turn/completed`。完成只表示该 turn 完成，不替用户管理任意 shell 后台进程。
- 模型列表来自原生 `model/list`，支持分页；不硬编码订阅模型，也不把目录出现等同于账号一定可调用。实测目录默认是 `gpt-6-astra`，该项目实际原生默认是 `gpt-6-sol`，因此网页不把目录默认冒充项目配置。未手选时由 `thread/start` 决定并返回真实选择。切换选择应用于下一次原生 turn。目录加载不创建聊天、不发模型提示，但会启动短生命周期 app-server。
- 权限回调保留原始 JSON-RPC 请求 ID；网页使用另一个 UI ID。重连重放待决弹窗，原生撤销请求会关闭网页弹窗，迟到的浏览器答复不能重新批准。
- 当前只投影公开回复、推理摘要和常见工具结果；不编造工具清单、费用或 token 使用量。
- 实测 0.155.1 会延迟保存没有消息的线程，直接重启恢复会报 `no rollout found`。新建后通过原生 `thread/read(includeTurns: true)` 触发持久化，不发送占位提示、不改写原生 JSONL。该版本对空分页历史可能在成功落盘后返回精确错误 `list_turns is not supported yet`；只有返回路径位于当前 Codex 的 sessions 内、文件名匹配刚创建的 UUID，且文件非空时才接受这个特定诊断。仅检查该新建文件的元数据，不读取内容或认证文件。其他错误仍然失败。真实全进程重启恢复与回归测试均已通过。

源码：`lib/codex-config.ts`、`codex-rpc-client.ts`、`codex-events.ts`、`codex-session.ts`。CC/Codex 复用 `web-session-transcript.ts` 的展示存储，但原生上下文和登录保持分开。`lib/codex.test.mjs` 使用假进程/假 app-server，不调用真实 CLI 或模型；已随 99 项回归通过。

协议依据是已安装 npm 包版本 **0.155.1** 对应的官方类型，而非推测 OMP/Pi 协议可复用：

- [Codex app-server](https://github.com/openai/codex/tree/rust-v0.155.1/codex-rs/app-server)
- [官方 TypeScript 协议](https://github.com/openai/codex/tree/rust-v0.155.1/codex-rs/app-server-protocol/schema/typescript)
- [配置 schema](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json)

发布目录 `/opt/omp-web-codex-release-c8H1wcVC` 保存 `tests-regression.log`、`typecheck.log`、`native-result.json`、`api-result.json`、`browser-result.json` 和桌面/手机截图。浏览器的全部 API 由假服务接管，且预览的可执行文件另设拒绝启动的防护替身；合成发送不可能落到真实 Codex。

构建 ID：`xOg6DkMaXFUeH1BA8cV1M`。只替换 `.next`，不修改依赖或原生 CLI；旧构建备份为发布目录的 `backup.next`。独立 systemd 切换任务在当前回复后运行，检查首页、静态资源、四工具更新状态、安全校验、CC 配置和真实 Codex 模型目录；失败自动回滚。实际结果以 `status.json` 为准。真实模型对话未获本轮授权，留给用户测试。
