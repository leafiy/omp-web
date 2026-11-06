# Claude Code + ChatGPT/Codex：本地网页接入草案

> 历史方案说明：用户后来明确要求网站仅作为原生工具的访问层。新源码和 `192.168.52.3` 部署不再使用本页的网页专用代理/密钥设置，改为读取本机 Claude Code 的原生配置和登录；原有本机实例未在远端部署时切换。见[最新部署边界](./native-host-deployment.zh-CN.md)。

首次记录：2026-11-04；最近更新：2026-11-05。状态：**用户已完成 ChatGPT/Codex 设备码授权，随后授权更新并重启 omp-web，由用户测试网页。类型检查、63 项模拟/相关回归、真实 CC + 模拟模型验收、真实 `gpt-6.1-sol` 的对话/工具/恢复/停止、隔离生产构建及构建后基础 API 验收均已通过。代理已由 systemd 托管；网页安排在本轮回复后切换。实际是否上线以 `/opt/omp-web-cc-release-UVFFgUYr/status.json` 的 `active` / `rolled_back` / `failed` 为准，不能仅凭构建通过或切换排程认定生产已更新。**

## 目标和选定路线

只在现有 omp-web 聊天里新增 `Claude Code` 选项，不另开一个 Web UI，也不把 CC TUI 嵌进聊天区域：

```text
omp-web 聊天 → Next.js / SSE → Claude Agent SDK → 本机 Claude Code
                                                  ↓ Anthropic Messages 协议
                                       127.0.0.1 上的 CLIProxyAPI
                                                  ↓ 用户本人的 Codex OAuth
                                        ChatGPT 订阅允许的 OpenAI 模型
```

CC 负责 agent loop 和本机工具，OpenAI 模型负责生成。**这不是 Claude Code 官方的 OpenAI 登录，也不会得到 Claude 模型。** CLIProxyAPI 官方仓库明确提供 Claude Code with a Codex backend 的示例，说明客户端模型名仅用于路由，不会把上游变成 Anthropic 订阅。[1]

本次安装的候选版本：CLIProxyAPI `v8.0.55`（git tag 指向 `e6e5708e677adb2463d45accdd24bc9fd028ddd8`），SDK `0.3.318`，本机 CC `2.1.318`。SDK 的 npm 元数据明确标注对应 CC `2.1.318`。[2][3] 采用 Linux amd64 **no-plugin** 代理包，SHA-256 为 `c6c570600e78ba9ef9773d6d7f787d9a25e62bc178b9daf8da07073ddbffc9b2`，与发布方 checksums.txt 一致。没有更新本机 CC/OMP/Pi。

## 登录方式

CLIProxyAPI v8.0.55 源码提供：

- `-codex-login`：Codex OAuth 浏览器登录。
- `-codex-device-login`：设备码登录。
- `-no-browser`：不自动打开浏览器。[2]

优先使用设备码流程，由用户本人在程序给出的 OpenAI 官方授权页面确认；如果账户不允许设备授权，再使用普通 OAuth。**不要求用户把 access_token、refresh_token、浏览器 Cookie 或密码粘贴进聊天，也不读取/复制 Pi 或已有 Codex 的登录文件。** OAuth 凭据交给代理的独立 `oauth.auth-dir` 保存和刷新。

这是第三方兼容实现。官方支持 Codex 的 ChatGPT 登录，不等于承诺任意代理/客户端组合都受支持；可用模型、额度、兼容性和适用条款仍需用户确认，并通过自己的账号实测。不要把“已登录”或 `/v1/models` 返回成功当作模型对话、工具和恢复都已成功。

## 已编写的源码

- `lib/claude-code-config.ts`：只接受 loopback HTTP origin；必填可执行文件、目标模型和私有代理密钥文件。缺配置明确失败，不回退 Anthropic。
- `lib/claude-code-session.ts`：独立 SDK adapter，初始化不发送模型提示；流式输入、原生 UUID、新建/恢复、停止、权限回调、提问、重连重放与超时拒绝。
- `lib/claude-code-events.ts`：流式快照、完整消息、工具调用/结果转换，防止重复提交最终消息，过滤子代理的私有对话。
- `lib/claude-code-store.ts`：网页展示投影，见下文数据说明。
- 引擎 ID 为 `claude:<nativeUUID>`，已有 OMP/Pi ID 规则不变；新引擎不经过原 OMP/Pi RPC 解码器。
- 引擎选择、标签、设置说明和模型列表已接线；模型列表仅展示服务器配置的目标，不声称代理健康或账号有权使用。
- `lib/claude-code.test.mjs`：9 项模拟 SDK/临时文件测试通过；与 OMP/Pi RPC、会话读取、模型缓存、图片、请求安全、路径和信任相关测试合计 63/63 通过。这批测试不调用真实模型。

SDK 采用官方 `query()`、`initializationResult()`、流式输入、`canUseTool` 和 `interrupt()`。新会话使用精确 `sessionId`，恢复使用精确 `resume`；禁止以 `--continue` 续接最近会话。使用 Claude Code system prompt preset，而不是 SDK 的精简默认提示。[3][4]

### 第一版范围

已通过真实 CC + 本机模拟 Messages 接口验证：初始化无模型请求、文本流及完成、无害 Write 工具的审批和结果、AskUserQuestion 文本作答、关闭/重启 adapter 后按原生 UUID 恢复、停止后正确结束。共 7 次合成模型请求，0 次真实模型请求；不是 OpenAI 兼容性或浏览器端到端验收。

2026-11-05 已通过真实 Codex 模型验收：通过实际会话注册表启动 CC，选择 `gpt-6.1-sol`，共发送 4 条测试提示，覆盖流式文本、一次精确限定到临时文件的 Write 审批及写入、关闭/重启进程后的原生上下文恢复（能回忆首轮随机标记）、流式停止。网页历史投影、消息/entry ID 对齐及侧栏引擎归属也通过直接读取接口验证。未接触业务项目；这是后端验收，不是浏览器端到端验收。

尚未端到端验证：浏览器刷新/断线、多轮 UI 展示、基础图片传递、网页标题。普通文件沿用现有上传落盘与路径引用。

明确暂不支持：终端历史导入、接管正在运行的终端 CC、Fork、树导航、steer/follow-up、队列、手动压缩、后台任务、HTML 导出、删除原生/网页双份历史、切换任意模型、thinking 参数。相应入口已隐藏/禁用或明确报错。CC 自身的自动上下文管理仍由 CC 执行；本阶段未完整适配其压缩进度 UI。

权限使用 `default`，没有 `bypassPermissions`，也没有 `allowedTools` 全放行。安全读取等是否直接运行由 CC 原生规则决定，不能承诺“每一次工具都会弹窗”。需要提示的调用进入浏览器，允许仅本次或拒绝；取消、5 分钟超时和进程退出均拒绝。断线时不批准，重连重放未解决的请求。[4]

### 数据与配置隔离

默认使用 `~/.local/state/omp-web/claude-code/`：

- `native/`：传给 CC 子进程的 `CLAUDE_CONFIG_DIR`，原生历史和状态。
- `sessions/<nativeUUID>.jsonl`：**仅网页展示投影**，使用现有页面能读取的消息结构；不是 CC 上下文，也不传给 CC 当原生会话文件。

CC 原生记录仍由 CC 写入。网页恢复传 native UUID，由 CC 读取 `native/` 的历史。当前不扫描或重写用户的 `~/.claude`。网页投影独立记录已收到的完整消息；极端情况下进程崩溃会造成原生记录和投影不同步，当前尚无离线重建投影工具，必须纳入后续验证。网页改名目前仅修改展示标题，不宣称已改原生标题。

配置只注入 CC 子进程，不全局改 `process.env`。清除继承的 Anthropic/Claude/OpenAI/Codex/OMP/Pi 凭据与模式变量；仅注入本地代理客户端 key。OAuth token 只保存在代理目录。

初版 `settingSources: []`，禁用 hooks、插件和自动发现的 MCP，显式关闭后台任务。这样初次选择项目不会加载它的 shell hooks/MCP；同时不声称完整复刻终端插件、skills、CLAUDE.md 的配置体验。工具仍以 omp-web 服务用户权限执行，这不是操作系统沙箱。[4][5]

## 部署前配置（示例，不会被网页自动应用）

### 代理 v8.0.55

以下是 v8 配置结构；不要和 v6/v7 的顶层字段混用。[6]

```yaml
server:
  host: "127.0.0.1"
  port: 8317
management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
access:
  api-keys:
    - "<随机生成的本地客户端密钥，不是 OpenAI token>"
oauth:
  auth-dir: "<独立的私有 OAuth 目录>"
client:
  claude:
    show-codex-commentary: true
```

必须只配置本人需要的 Codex 认证来源，不接公共中转，不加入 Anthropic key，不配置跨提供商兜底。代理仅监听 loopback；OAuth 目录权限 `0700`，配置和 key 文件 `0600`。不启用远程管理、不暴露凭据接口、不记录完整请求内容。登录前应核对版本和配置，不执行网络上的一键脚本。

`show-codex-commentary` 用于展示 Codex 的公共进度文本，不是泄露私有 reasoning；作者文档有说明。[1]

### omp-web 环境

```ini
OMP_WEB_CC_EXECUTABLE=/root/2/devbox-distrobox/.local/bin/claude
OMP_WEB_CC_BASE_URL=http://127.0.0.1:8317
OMP_WEB_CC_MODEL=gpt-6.1-sol
OMP_WEB_CC_API_KEY_FILE=<仅服务用户可读的本地代理 key 文件绝对路径>
# 可选，不要指向现有 OMP/Pi/Claude 数据目录
OMP_WEB_CC_STATE_DIR=<专用网页 CC 状态目录绝对路径>
```

`BASE_URL` 不加 `/v1`。key 文件内容与代理 `access.api-keys` 一致；它只认证本机代理请求。模型由服务器固定，同时设为 CC 的默认 Opus/Sonnet/Haiku 路由目标，避免辅助请求意外跑向别的模型。本轮已从已登录代理的模型目录中选择并实际验证 `gpt-6.1-sol`，未读取 OAuth 凭据内容。候选配置保存为 staging 下的 `claude-code.candidate.env`；切换任务将其安装到 `/etc/omp-web/claude-code.env`（0600），并通过 `omp-web.service.d/30-claude-code.conf` 加载。只保存代理 key 的路径，不把 key 或 OAuth token 写入 unit。

## 本轮验证记录与剩余步骤

用户在本轮确认了三项：隔离安装/测试、本地代理安装启动及个人授权、授权后少量真实订阅请求验证。**没有授权生产构建切换或重启。**

1. 已在 `/opt/omp-web-cc-stage-xz6Irk3R` 安装依赖，使用 `npm install --ignore-scripts --omit=optional --no-audit --no-fund`；原安装目录的 `node_modules` 未修改。`package-lock.json` 已同步回源码目录。SDK 的 API SDK peer 在隔离目录为 1.5.0，Pi 自己仍解析到其 0.91.1 依赖。
2. `tsc --noEmit --incremental false` 通过；63/63 回归通过。首轮发现并修正了 SDK UUID 类型问题；两项旧 Pi 测试受到宿主 `PI_CODING_AGENT_DIR` 影响，改用独立 OMP/Pi/CC 测试目录后通过，没有放宽目录隔离检查。
3. `cc-native-mock-smoke.mjs` 使用真实本机 CC 和合成 loopback 模型通过上述 6 项验收。停止时 CC 2.1.318 返回的特定 unfinished-turn diagnostic 已归一为用户取消；增加回归，认证等真实错误仍显示。日志见 staging 的 `typecheck.log`、`tests-regression.log`、`native-mock.log`；模拟脚本只在隔离目录，不属于正式服务。
4. 代理位于 `/opt/omp-web-cc-proxy-v8.0.55`，私有运行目录为其 `runtime/`。仅监听 `127.0.0.1:8317`；无 key 的 `/v1/models` 返回 401，有 key 返回 200（未登录时模型数为 0）；两种 management 路径和 management.html 均返回 404。不启用系统启动，不配置 systemd，不公开端口。
5. 用户在 2026-11-05 完成新的设备码授权，已确认代理私有目录有 1 个凭据文件（只检查数量和权限，未读取 token），目录 `0700`、凭据文件 `0600`。模型目录返回 200 和 14 个模型 ID；目录包含未实测的模型，不能把它们都视为可用。设备码不写入文档。备用人工向导为 `/opt/omp-web-cc-proxy-v8.0.55/login-wizard.sh`，已通过 `bash -n`，未代用户运行交互向导。
6. 真实模型验收通过：`cc-live-smoke.mjs` 经原生会话注册表提交 4 条提示，完成流式文本、无害 Write（仅批准指定临时路径和指定内容）、网页历史/侧栏归属、进程重启后的上下文恢复、流式停止；assistant 消息的模型标识为 `gpt-6.1-sol`。一次提示可包含多轮模型/工具交互，所以不能将 4 条提示说成恰好 4 个上游请求。结果见 staging 的 `live-smoke.log` 和 `live-check-cHB7Pq/result.json`。
7. 用户随后明确授权“重启更新 omp-web，我来测试”。在 `/opt/omp-web-cc-release-UVFFgUYr` 按锁文件安装完整构建依赖（显式包含 dev/optional，跳过生命周期脚本），复用相同版本/同一 Node ABI 的既有 SQLite 原生模块。首次构建因继承线上 `NODE_ENV=production` 而漏装构建工具；补齐后构建和 TypeScript 检查通过，仅保留既有 instrumentation 动态依赖警告。Build ID：`cG8k_Qy7bIUmFMYr6dsaK`。
8. 构建后 loopback 预览验收通过：首页/静态资源、正确模型目录、实际 CC 空会话的 POST API。模型目录只接受已登记的项目 cwd；测试先创建临时会话登记项目，再读取目录，没有放宽文件访问规则。这轮未发送新模型提示，浏览器交互由用户测试。
9. 代理已迁移为并启用 `omp-web-cc-proxy.service`；仍仅监听 `127.0.0.1:8317`，管理端点不开放，私有授权目录不变。切换任务在独立 systemd 单元中执行，不受被重启网页进程的控制组影响；核对原进程/构建及源码摘要后停服、替换依赖与 `.next`、加载 CC 环境并启动。随后检查首页/静态资源、CC 模型 API、OMP 更新状态、Host/Origin 防护和代理目录；不发送模型请求、不更新 OMP/Pi/CC。
10. 旧构建和依赖已分别完整备份至发布目录的 `backup.next`、`backup.node_modules`；失败时自动恢复，并撤销本次新增的网页 CC drop-in。切换结果记录在 `status.json` 和 `cutover.log`。`active` 才表示上线且基础检查通过；`rolled_back` 表示仍使用旧版。不要在生产 `.next` 内构建。

真实模型验收仅使用隔离项目和独立 CC 数据目录，已经消耗少量 OpenAI 订阅额度，没有导入或使用 Anthropic 登录/API key。网页是否已切换须查上述状态文件；浏览器操作仍待用户验收。

## 来源

1. [CLIProxyAPI v8.0.55：Claude Code with a Codex backend](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.55/examples/claude-code-codex/README.md)
2. [v8.0.55 CLI 参数及登录分派](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.55/cmd/server/main.go)
3. [Claude Agent SDK 0.3.318 npm 元数据](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.318)
4. [官方 TypeScript SDK 参考](https://code.claude.com/docs/en/agent-sdk/typescript.md)
5. [官方非交互运行文档](https://code.claude.com/docs/en/headless.md)
6. [CLIProxyAPI v8.0.55 配置样例](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.55/config.example.yaml)
