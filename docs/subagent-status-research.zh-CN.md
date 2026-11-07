# 四引擎子 agent / 后台任务状态调研

本文保留最初的静态调研结论；后续实现、运行验证与本机发布状态见 [子 agent 状态](./subagent-status.zh-CN.md)。

## 范围与结论

基于 `/opt/omp-web` 源码 HEAD `bbbaf22` 的静态调研，覆盖 Claude Code、Codex CLI、OMP、Pi。可以实现统一展示，但需要四种来源适配，不能只改一个 loading 图标。

本次没有运行测试、引擎、模型请求、构建或部署，也没有复现截图会话。源码缺口已确认，但不能据此断言截图中的五组任务当时的实际状态。源码与生产构建是否完全一致也未验证。没有修改既有 README 工作区变更。

## 1. Claude Code

证据：

- `lib/claude-code-session.ts:167` 跳过带 `parent_tool_use_id` 的帧；这是保护主聊天记录的隔离，不能直接取消。
- `lib/claude-code-events.ts:48–70` 同样隔离子 transcript；除 init 在 session 中处理外，大多数 system 帧不会转成 Web 事件。
- `lib/claude-code-session.ts:238–250` 的 `finishTurn()` 清除 busy 并发出 `agent_settled`，没有后台任务集合参与判断。
- 本机 `node_modules/@anthropic-ai/claude-agent-sdk/package.json` 为 0.3.318；其官方类型 `sdk.d.ts:3838` 定义 `SDKBackgroundTasksChangedMessage`，`:6401–` 定义 task notification/progress/started/updated。

可用协议：

- `system/background_tasks_changed`：后台任务**全量替换**快照，不是增量。SDK 明确推荐用于活动指示，避免丢失起止事件后指示器永久卡住。
- task 条目包含 task_id、可选 run_id、task_type、description、parent_task_id、subagent_type、ambient。
- `task_started/task_updated/task_progress/task_notification`：详细生命周期、用量、最近工具和可选摘要；完成状态包括 completed/failed/stopped。
- `ambient` 任务应排除在工作中计数外；不能让常驻 watcher 导致永远忙碌。
- 快照是进程范围，重启必须重置；不同 CLI 版本可能缺字段或不提供重新初始化快照。SDK 类型存在不等于运行中的 CLI 一定发送全部事件。

建议：单独消费任务元数据，然后继续过滤子 transcript。背景集合不随主轮次 result 清空。利用 run_id 拒绝旧运行事件。不要把快照缺少的任务直接标记为成功：它只证明已不在后台运行，具体结果由终态事件提供。

## 2. OMP

证据：

- `lib/rpc-manager.ts:43–49` 已允许转发 get_subagents/get_subagent_messages/cancel_subagent/steer_subagent。
- 同一文件的 handleFrame 将未特别处理的事件转发；OMP session_settled 与 agent_end 已做区分，不能回退为 agent_end 即完成。
- 仓库已有官方来源入口：`docs/native-omp.zh-CN.md:113–115`。
- 本机既有源码缓存 `/tmp/omp-rpc-usage-types.ts:82–87,397,704–718` 包含 set_subagent_subscription（off/progress/events）、get_subagents，以及 subagent_lifecycle/subagent_progress/subagent_event。
- `/tmp/omp-rpc-mode.ts:2431–2478` 展示订阅、快照、子 transcript 查询处理。

建议：初始化注册订阅、取得 snapshot，生命周期和进度归一化后送前端；重连用快照对账。当前 Web FORWARDED_COMMANDS 未包含 set_subagent_subscription；应由适配器内部设置或显式接入，而非以为现有转发已完成端到端支持。

限制：以上原生协议来自已有缓存，未在本轮重新确认安装二进制与对应源码版本。需要后续针对部署版本验证，尤其是订阅默认值、注册表覆盖的任务种类及 session_settled 与长期协作 agent 的关系。

官方源码入口：
- https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts
- https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-subagents.ts

## 3. Codex CLI

证据：

- `lib/codex-events.ts:22` 将 collabAgentToolCall 当作普通工具；item completed 结束的是协作**调用**，不等于接收方 agent 已完成。
- `lib/codex-session.ts:124–137` 只接受当前 busy 主线程、当前 turn 的帧。不能直接放宽这些判断，否则子线程消息会污染主聊天，甚至提前结束主轮次。
- `lib/codex-session.ts:144–149` 根据主线程 turn/completed 结束当前 turn。
- 既有官方协议缓存 `/tmp/omp-codex-protocol-v0.155.1/v2-ThreadItem.ts:83–119` 中，collabAgentToolCall 有 receiverThreadIds、agentsStates；同时包含 subAgentActivity。
- 同一缓存 ServerNotification.ts 有 thread/status/changed。版本来源由 `docs/codex-cli.zh-CN.md:50–52` 记录。

建议：建立由已确认的协作调用关联出的 child thread 集合，独立处理子线程状态；保留主线程 transcript/turn 隔离。先从 collab 条目提取 ID 和已知状态，再按实际版本验证子线程订阅和 thread/read/status 补偿能力。spawn 调用完成只代表派发完成。子线程审批必须按所属关系路由，不能无条件接受任意线程请求。

限制：本轮只核对既有 v0.155.1 协议缓存，没有确认当前 CLI 的全部协议细节与通知投递行为；不能宣称只监听一个通知便能完整追踪。

官方来源：https://github.com/openai/codex/tree/rust-v0.155.1/codex-rs/app-server-protocol/schema/typescript

## 4. Pi

证据：

- 本机官方包 `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json` 为 1.5.0。
- 其 `examples/extensions/subagent/index.ts:165,323–326,557–565,631–638` 在工具 onUpdate 中提供 `details.results`，覆盖 single/parallel/chain。
- 子 agent 是扩展提供的能力，不能由示例推断所有第三方扩展的数据契约。
- Web `hooks/useAgentSession.ts` 处理 tool_execution_start/end，但没有 tool_execution_update 分支，也没有专门的子任务集合。

建议：先接通 tool_execution_update/partialResult，再对官方示例或明确支持的扩展 details 做结构化适配。不能仅按工具名叫 subagent 就假定 payload 相同。缺少结构化数据时展示“子 agent 工具运行中（详细状态不可用）”；不伪造数量、百分比或后台终态。第三方 fire-and-forget 扩展若不报告生命周期，需要扩展增加桥接事件，单靠 Web 无法可靠感知。

## 5. 统一 UI 与状态模型（建议，尚未实现）

独立维护两个维度：

1. 主轮次：生成、工具执行、等待审批、空闲。
2. 关联工作：子 agent / 后台命令 / 其他任务；运行、等待、成功、失败、停止、状态未知。

任务记录建议包含：engine、sessionId、processEpoch、taskId、runId、parentTaskId、kind、title、status、lastActivity、usage（可选）、ambient、source、capabilities。

- 任务列表不能在下一轮 prompt 开始时清空；后台工作可能跨轮次。
- 不复用 sessionBusy 控制全部交互：后台工作中仍应允许用户输入；是否支持 steering/stop 由能力决定。
- 输入框上方常驻摘要，例如“主 agent 本轮已结束 · 后台仍有 5 个子 agent 运行”；展开显示每个任务及最近活动。
- 左侧会话列表也显示后台数量；可选区分审批等待和异常。
- 普通工具卡“调用已返回”和“任务已结束”明确分开。
- 完成提示音区分主轮次结束和关联工作全部结束，后者需主轮次、队列和已知非 ambient 工作共同对账。未知/失联状态不能宣称全部完成。
- 后台工作存在时继续 SSE / 合适的轮询。当前 hooks/useAgentSession.ts 的 idle grace 和状态轮询只基于主运行标志，需要同步改动。
- 后端 idle 销毁策略也要考虑后台集合，避免 UI 能显示但进程被提前回收。
- 浏览器重连应先取得完整任务快照，再处理带 revision 的增量；旧 epoch/run 的事件不能覆盖新状态。
- 服务重启后历史“运行中”不能当成当前事实：恢复查询失败时显示未知/已断开，而不是永久 spinner 或直接成功。
- 子任务详情单独展示，默认不把子 agent 私有 transcript 混入主对话。

## 6. 落地顺序与验证条件

建议统一基础层先行，然后四个 adapter：Claude 与 OMP 优先接生命周期，Codex 接子线程关联，Pi 接已知扩展进度；最后统一接快照、SSE、重连、会话列表和完成音效。详细 transcript、单个取消/steer 可作为后续功能，不能为只读状态需求放宽原生权限。

涉及文件：lib/claude-code-session.ts、lib/claude-code-events.ts、lib/codex-session.ts、lib/codex-events.ts、lib/rpc-manager.ts、agent API/SSE、hooks/useAgentSession.ts、components/ChatWindow.tsx；新增共享任务状态存储/投影及任务面板。

后续需单独授权运行验证。最小回归场景：

- 主轮次已结束、多个子任务仍在跑：摘要持续显示，输入仍可用，无误报全部完成。
- spawn 工具返回后子任务继续运行；最后一个任务终止后才更新整体状态。
- 子任务失败/取消/审批等待/嵌套任务；无重复计数，无主聊天污染。
- 乱序、重复、旧 run 事件；SSE 重连、页面刷新、切换会话、服务重启。
- ambient watcher 不阻塞完成；无能力引擎明确降级。
- Pi parallel/chain 进度，以及未知第三方扩展 payload。

静态调研不替代以上验证；当前没有提交修复或宣称功能已上线。
