# Hermes Agent 接入 omp-web：可行性与首版边界

**结论：可行，但应作为第五个引擎接入，不是第五个模型，也不能把 OMP/Pi 的可执行文件换成 `hermes`。** 建议 `omp-web` 服务端连接**本机、已运行、指定 profile 的 Hermes Gateway**；浏览器继续使用现有登录、HTTP 命令和 SSE。理由是 Gateway 不仅能流式回复，还能分别回答三个网页必须知道的问题：这是哪个持久会话、这次提交有没有执行完、这个审批现在还算不算数。[上游接口对照][integration] · [原生会话契约][local]

范围：Nous Research 的 [Hermes Agent v0.23.3][release]（源码 `caafe5389ae585ef77387a962aee05b1bcf17029`），本仓库 `a2b2221`。这是静态调研，不代表任何目标机器已兼容。本次开发 shell 的 `command -v hermes` 未返回路径，不能据此判断生产服务用户的安装状态。未读本机 Hermes 凭据或历史，未启动 CLI/Gateway、安装依赖、调用模型、运行测试、构建或部署。

## 为什么选 Gateway，而不是 ACP 或 HTTP？

| 接入面 | 适用场景 | 对本项目的取舍 |
| --- | --- | --- |
| **共享 Gateway JSON-RPC** | 自有聊天 UI，需要精确会话、逐次提交回执、工具事件、审批、历史与重连。官方 TUI 也连接这个 owner。 | **推荐。** Next.js 通过 `hermes gateway attach --json` 取一次性票据，再连本机 `hermes-gateway-v1` WebSocket。无需给浏览器开 Hermes 端口；代价是要处理版本协商、回放和 owner 不在线。别把独立 `tui_gateway` stdio 的方法表当作共享 Gateway 契约，例如后者拒绝 `session.close`、`session.status`。[连接契约][attach] · [方法对照][integration] |
| **ACP（Agent Client Protocol）** | 已经实现 ACP 的编辑器；`hermes acp` / `hermes-acp` 提供 stdio，支持 prompt、增量、工具、权限请求和取消。 | 真正可选的第二条路；如果将来要给多个 ACP 引擎共用客户端，值得重新评估。当前仓库没有现成 ACP 会话层。此版本的正式 ACP 入口本身也是共享 Gateway 的 viewer，并非「杀掉 stdio 子进程就停止执行」的独立引擎；还要满足 ACP extra。首版不同时维护两套适配。[ACP 说明][acp] · [入口][entry] · [适配源码][acp-gateway] |
| **HTTP API Server** | 已部署 API Server、要复用 OpenAI 客户端的场合。除了 `/v1/chat/completions`，还有 `/v1/runs` 的事件、审批及停止接口。 | 可作为未来远端部署方案，不作为本机自动回退。要另管 HTTP 端点、认证和 run 与本地工作目录/会话的对应关系。`/v1/models` 不是用户实际 provider 的模型选择列表。也不要把 `hermes` 填入 OMP 的 `--mode rpc` 参数，或解析终端彩色输出。[官方集成指南][integration] |

## 最小闭环：新建 → 发送 → 审批或停止 → 刷新恢复

下表是**拟议的映射**，不是已经实现的功能。字段以共享 Gateway 的 [canonical session 类型][sessions]、[admission 类型][receipts]及[上游客户端翻译层][wire]为准。

| 网页动作 | 实现与失败语义 |
| --- | --- |
| 发现 / 连接 | `/api/engines` 只探测服务端可执行文件；「找到程序」不等于「可聊天」。用户选择 Hermes 后才以固定 argv 调 `gateway attach --json`，**不带 `--start`、`--recover`**。仅接受本机回环、期望的子协议与 profile；票据单次有效，重连重新获取，不能写日志、投影、SSE 或返回浏览器。用 `runtime.describe` 核对 profile、创建策略和参数；owner 不在线、版本不匹配或缺必需能力时说明原因，不自动启动/升级/重启服务。[attach][attach] |
| 新建 / 身份 | `session.create` 传所选绝对 `cwd`、稳定的 `request_id` 和已协商的 `source: "tui"`（终端工具策略）；未手选模型时不传覆盖。保存返回的**逻辑** `session_id`；压缩可能轮换物理 transcript，但恢复的仍是创建时的 ID。首版固定一个服务端 profile，网页键 `hermes:<logicalId>`，索引同时绑定 profile、原生 ID、cwd；任何不匹配都拒绝，不能用「最近会话」代替。若将来支持多 profile，先扩展命名空间。[会话身份][local] |
| 发送 / 状态 | 先接上浏览器 SSE，再 `prompt.submit`。原始 wire 用客户端生成的 `input_id`（部分示例/包装层称 `submission_id`）；保留服务端返回的 **`admission_id`**，不要和 JSON-RPC `id` 或浏览器 run ID 混用。ACK 只代表受理。按所属会话、admission、代际归并 `message.delta`、`tool.start` / `tool.complete` 和最终消息，避免增量加全文显示两份。通过 `prompt.receipt` 的 `terminal` 和 `outcome` 判断本次结果；还要看会话是否有 pending 工作才报告空闲。`unknown` 表示执行结果不确定，暂停队列、提示用户，不重发。[回执][receipts] · [事件消费实例][acp-gateway] |
| 审批 / 提问 | 将 `approval.request` / `clarify.request` 投影到现有带 ID 的弹窗。原生 `approval.respond` 要带 `session_id + prompt_id + execution_generation`；只提供原生 choices 中的「仅本次」与「拒绝」，涉及文件修改须先有可审阅内容。问题用 `clarify.respond`。同一会话允许多个待答项；重连从快照的 `prompts` 恢复，别处已回答或过期的弹窗移除。启动时无人可答、不支持的交互、超时均不得批准；SSE 短暂断开不是同意。另区分带 JSON-RPC `id` 的反向请求：不支持的 secret/sudo、桌面或 vault 请求答协议错误，不弹框收集秘密，不把它们当普通事件吞掉。Hermes 原生策略决定何时询问，网页不能承诺每个工具都弹窗。[会话类型][sessions] · [上游审批实现][acp-gateway] · [反向请求][integration] |
| 停止 / 断线 | 优先 `prompt.cancel({session_id, admission_id})`，只停目标提交；点「停止」、取消 ACK、关闭标签页或断开 viewer **均不等于**执行已结束。用回执核对后结算。进程重连时精确 `session.resume`，按 `replay_epoch + seq` 用 `session.events.since` 补漏、去重；若要求快照则重取，而不是继续拼旧流。恢复快照与迟到事件不得结束更新的浏览器 run。关闭网页适配器只 detach 自己，不关闭共享 daemon 或其他终端会话。[回执][receipts] · [快照与回放][sessions] · [多 viewer 语义][local] |
| 历史 / 模型 | 首版只列出本网页登记的会话，不导入或接管终端历史。支持 `session-transcript-v1` 时，`session.transcript` 可按 ID 分页读展示行，不必为了看历史而 resume；按网页的**整 turn**规则组装，不能拿原生一页当一个 turn。模型若要展示从 Gateway `model.options` 取，白名单提取 provider/model 标识和名称，不透传原始配置；查询可能探测自定义端点。没有可验证目录时先沿用原生默认，不猜模型、费用或上下文占用。[历史契约][local] · [模型目录说明][integration] |

**信任边界：** attach ticket 代表本机该 profile 的交互式操作者，不是网页会话级令牌；原生甚至允许同 profile 的授权操作者跨 viewer 附着。因此网页必须自己检查登录、Origin、已登记的 `hermes:` 身份和 cwd，再调用允许的方法；不能做透传任意 RPC 的代理。启动参数、profile、网关地址、凭据、工具/审批策略都不由浏览器提供。原生 provider、登录、memory、skills、MCP 仍由 Hermes 管；网页只取展示所需字段，不复制 `.env`、`state.db` 或跨引擎共享凭据。[原生授权范围][local] · [Hermes home][home] · [仓库约束](../AGENTS.md)

## 仓库里实际要改哪里

- **引擎发现与能力开关：** [`lib/agent-executable.ts`](../lib/agent-executable.ts)、[`app/api/engines`](../app/api/engines/route.ts)、[`lib/engine.ts`](../lib/engine.ts)。新增 `hermes` 与单可执行文件覆盖（建议名 `OMP_WEB_HERMES_EXECUTABLE`），保持旧链接和默认 OMP。特别要把 `engine !== "codex"` 这类删除、导出、消息 Fork 判断改为显式支持列表，否则只增加类型就会错误开放动作。选择器、输入区和旧客户端请求要有一致的能力限制。
- **会话适配：** 在 [`lib/rpc-manager.ts`](../lib/rpc-manager.ts) 分派独立 `HermesSession`，实现 [`FollowUpNativeSession`](../lib/follow-up-session.ts)，复用启动锁、注册表、SSE 及 [`useAgentSession`](../hooks/useAgentSession.ts) 的 run-ID 保护，不复用 OMP/Pi JSONL 解码器。区分网页待发送队列与已被 Hermes 接收的 admission，不让两边各投一次。首版不另发模型请求自动命名。上游 Node 客户端可对照，但 [`@hermes/shared` 在这个 tag 为 private workspace 包][shared]，不能假定有可安装的公共 SDK。
- **索引与历史：** [`lib/session-reader.ts`](../lib/session-reader.ts)、[`lib/engine-paths.ts`](../lib/engine-paths.ts) 与恢复路由目前依赖按引擎找文件、读取 header。[`WebSessionTranscript`](../lib/web-session-transcript.ts) 只接受 CC/Codex provider 和 UUID；不要放宽成「任意原生 ID 拼文件名」。建议用独立的网页索引/展示缓存和安全的本地文件键，保留精确原生 ID 与 profile 映射。索引给侧栏和恢复用，Gateway 的历史才是事实来源；网关离线时可以展示已缓存历史并标注离线，不能伪造空历史或把展示记录作为上下文发回模型。
- **先不开放：** `!`/`!!`、任意 slash 命令、图片输入、原生 steer、消息 Fork、删除、导出、权限模式修改、MCP 管理及子任务控制。隐藏控件且服务端明确拒绝；Hermes 原生存在近似操作，并不证明它符合网页语义。模型选择可在第二步接 [`app/api/models`](../app/api/models/route.ts)，缓存至少区分 engine、cwd、profile；会话先用原生默认，不阻塞最小闭环。

## 下一步与验收门槛（均未执行）

1. **先用假 Gateway 验证协议，不需要 Hermes 登录。** 覆盖缺少 owner/能力时明确不可用、两个 cwd 的并发创建、ACK 前先到增量、审批断线重放、另一 viewer 先回答、旧代际点击无效、停止后迟到的完成、重启后 `unknown` 不重投、票据不出现在浏览器或日志里。上游的 [会话测试][up-test] 和 [恢复测试][recover-test] 可参考，但不能替代本仓库的回归。
2. **再单独授权目标机器的无模型检查。** 确认服务用户的 Hermes 版本、profile 和已有 owner；先只 attach + `runtime.describe`。创建及恢复空会话会写 Hermes 原生状态，另行确认后再做。不在生产 profile 上用一条“测试消息”强制落盘。
3. **最后单独授权真实端到端。** 在指定测试目录/profile 中，验证一次文字流、一次可拒绝的工具审批、停止、刷新恢复同一会话。通过后再谈模型选择、附件和高级功能；安装、构建、部署与服务重启不属于调研授权。

[release]: https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.3
[integration]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/website/docs/developer-guide/programmatic-integration.md
[attach]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/website/docs/developer-guide/gateway-internals.md#hermes-gateway-attach
[local]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/website/docs/developer-guide/gateway-local-sessions.md
[acp]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/website/docs/user-guide/features/acp.md
[entry]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/acp_adapter/entry.py
[acp-gateway]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/acp_adapter/gateway_server.py
[sessions]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/tui_gateway/contracts/canonical_sessions.py
[receipts]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/tui_gateway/contracts/canonical.py
[wire]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/apps/shared/src/gateway-canonical.ts
[shared]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/apps/shared/package.json
[home]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/hermes_constants.py
[up-test]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/tests/gateway/test_local_session.py
[recover-test]: https://github.com/NousResearch/hermes-agent/blob/v0.23.3/tests/gateway/test_local_session_recovery.py
