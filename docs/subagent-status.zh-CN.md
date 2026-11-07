# 子 agent / 后台任务状态

本功能为 Claude Code、OMP、Codex CLI、Pi 提供独立任务状态，不将子 agent 的私有对话混入主聊天。

## 展示与生命周期

输入框上方可展开任务面板，分别显示主轮次和关联工作。主轮次空闲时仍可发送新消息；后台任务不会随下一轮输入清空。子 agent 内的 shell 显示为嵌套项，不重复计为一个顶层工作组。

- 主轮次完成不代表后台完成；仍有已知任务时保留 SSE、状态对账和后端进程。
- 会话侧栏沿用运行指示；后台任务也计入运行会话集合。此版不新增侧栏任务数字。
- 刷新重新获取进程快照；同进程旧 revision 和已退役 epoch 的数据不能覆盖新状态。
- 连接中断显示状态待确认，不把旧 running 状态当作当前事实。
- 完成音效等到已知关联工作结束；未知任务不会被虚构为成功。刷新后仍可收到已知后台任务的结束音效。
- Claude 的后台任务若主动唤醒主 agent，总结过程重新显示为工作中；主轮次结束不取消子 agent 仍待用户回答的审批。
- 点击任务行，在现有右侧面板中打开独立标签页，读取该任务的状态和对话；不会替换主聊天。活动任务详情每 3 秒刷新，关闭面板停止读取。
- 详情接口 `GET /api/agent/[id]/tasks/[taskId]` 只接受当前进程已登记的任务 ID，不接受文件路径，不自动创建／恢复 Agent。Claude 使用 SDK 子 transcript 读取接口；OMP 使用原生子 transcript 命令；Codex 仅查询当前父线程 spawn 的已知子线程；Pi 使用扩展已上报的子消息。
- 每次详情最多返回 100 条、64,000 字符，不返回隐藏推理或任意 SDK 元数据。没有原生对话时明确显示不可用，不能拿主历史代替。
- 当前只读展示，不新增取消/steer 子 agent 按钮，也不更改原生权限策略。

## 引擎差异

| 引擎 | 数据来源 | 边界 |
| --- | --- | --- |
| Claude Code | background_tasks_changed、task_started/updated/progress/notification | 原生全量后台集合；ambient watcher 不参与活动计数；run_id 过滤旧运行事件 |
| OMP | progress 订阅、生命周期事件、get_subagents 快照 | 只跟踪原生 registry 覆盖的子 agent；不伪装成通用 shell 任务清单 |
| Codex CLI | 主线程已验证的 collabAgentToolCall、已关联子线程状态通知及只读 thread/read | spawn 调用完成不等于子线程完成；未关联线程和子 transcript 不进入主对话；查询失败标未知 |
| Pi | subagent 工具进度中的官方示例 details.results | 扩展格式不统一，未知格式降级；示例 exitCode 初始为 0，不能当作已完成，最终工具结果才确认终态 |

任务状态为进程范围的观测，不是新的持久化调度器。网页服务重启后不能凭旧历史恢复真实后台执行状态；不支持上报的第三方 Pi 扩展仍需要扩展自身增加生命周期协议。

## 本轮验证

隔离发布目录：`/opt/omp-web-tasks-stage-Knhh0eP5`。

- 相关适配器与 i18n 回归、TypeScript 检查和隔离生产构建；具体最终结果见该目录日志。
- 全量测试与未修改 HEAD 在独立目录对比。两者存在同样的 16 项既有失败（旧 SDK wrapper、skill-lock/update 与主机名环境相关），没有新增失败；不能宣称全仓测试全部通过。
- 浏览器：四引擎，主轮次先结束、后台仍运行、继续输入、SSE 保活、刷新恢复、旧 revision、断线恢复、390px 手机布局；音效在最后一个子任务结束后仅触发一次。
- 本机实际 Claude Code 2.1.318 + 实际 Agent 子任务 + 实际 Bash `sleep 5`：父轮次先结束、子任务继续运行、终态可见、子对话隔离。模型响应来自隔离网络中的确定性本地服务，未调用真实模型；不是只注入 Web SSE 的模拟。
- 另一次使用默认原生模型的尝试未观察到子 agent 启动，未计为通过。不能宣称实际模型账号端到端验证成功。

## 本机发布

用户最初要求先更新本机，随后追加 UI、快捷编辑与撤回需求，并授权更新本机、GitHub 和 `192.168.52.3`。整批版本与最终状态路径见 [UI 调整](./ui-refinements.zh-CN.md)。

当前交互进程由 `omp-web.service` 承载，本机切换通过独立 systemd 延迟任务执行，以免切断尚未发送的回复。保留上一版本 `.next`，失败自动恢复，不升级依赖或任何 Agent，不改变原生登录配置。

用户随后提出六项 UI 调整，原延迟切换在触发前暂停，状态记录为 `deferred`。追加修改及快捷编辑／撤回已单独验证，整批版本使用新发布目录 `/opt/omp-web-ui-stage-WcNACZgQ`，不再执行旧候选目录的切换。上一节保留状态面板阶段的验证记录。

整批版本的本机最终状态以 `/opt/omp-web-ui-stage-WcNACZgQ/local-status.json` 为准：只有 `phase: active` 表示切换与发布后检查已成功；`scheduled` 不代表已上线。回滚目录为同发布目录的 `backup.next`。旧 `/opt/omp-web-tasks-stage-Knhh0eP5/local-status.json` 仅记录之前候选的暂停状态。
