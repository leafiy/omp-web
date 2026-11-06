# 原生技能面板

左下角“技能”打开独立的只读面板，不再复用“设置”。设置和用量入口保持独立。没有选择项目时会提示先选项目，不会静默跳转。

## 范围

- 面板默认使用当前会话/新聊天的 Agent，也可独立选择 OMP、Pi、Claude Code 或 Codex 查看该项目的目录；不会切换或修改正在进行的聊天。
- OMP：临时 `--no-session --no-ui` RPC 查询 `get_available_commands`，只展示 `source: skill` 的条目。
- Pi：临时 `--no-session` RPC 查询 `get_commands`，只展示 `source: skill` 的条目。
- Claude Code：不持久化的 SDK catalog 查询 `supportedCommands()`，排除原生明确标记为内置的命令及其遮蔽的同名行。该接口混合返回技能与自定义命令，界面明确标注，不伪造路径或启用状态。
- Codex：app-server 的 `skills/list`，只请求所选 cwd，`forceReload: false`；展示原生提供的路径与启用/禁用状态，原生扫描错误只显示安全的概述。
- 原生没有提供、未公开或禁用的技能不一定出现在目录中。空目录不等于磁盘没有技能；读取失败与未安装会明确提示。

面板不安装、启用、禁用或编辑技能，不读取技能正文或登录文件，不替换原生技能目录，不复制其他 Agent 的资源。没有 prompt、thread/start、turn/start 或模型请求。原生初始化仍可能加载 CLI 允许的项目资源，因此应只选择可信项目。安装和管理继续使用各 Agent 的原生流程。

## 接口与隔离

`GET /api/native-skills?engine=<agent>&cwd=<absolute-project-path>`，可用 `refresh=1` 刷新。

- 独立检查密码、Host 和 Origin；只读 GET，拒绝额外命令参数及重复参数。
- cwd 必须是允许访问的现有目录，并在真实路径校验后作为缓存键。
- 缓存按 `engine + cwd` 隔离；并发请求合并，最多同时启动四个目录读取器。通常缓存一分钟，失败短缓存，连续刷新至少间隔五秒。
- 20 秒总超时，成功、失败和超时均清理临时读取器。没有持久聊天记录，也不打断现有会话。
- 旧 `/api/skills` 编辑接口仍被禁用，不能通过恢复旧面板绕过四引擎隔离。

## 验证

`lib/native-skills.test.mjs` 使用模拟目录读取器和 HTTP 服务，覆盖引擎/项目隔离、内置命令排除、禁用状态、未知数据、缓存、并发限制、超时清理和认证。`lib/claude-code.test.mjs` 验证技能目录查询不持久化会话、不发提示。

构建后浏览器检查点击真实“技能”按钮，断言没有设置面板，切换四引擎、刷新错误状态、搜索和手机布局均使用模拟 API；不把模拟结果当作真实账号能力验收。

协议依据：
- [OMP 18.16.0 命令目录](https://github.com/can1357/oh-my-pi/blob/v18.16.0/packages/coding-agent/src/slash-commands/available-commands.ts)
- 本项目固定版本 Claude Agent SDK 的 `Query.supportedCommands()` / `SlashCommand` 类型。
- [Codex SkillsListParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/SkillsListParams.ts)、[SkillsListResponse](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/SkillsListResponse.ts)。旧版不支持接口时明确报告读取失败，不退回另一工具。
