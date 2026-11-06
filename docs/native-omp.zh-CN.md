# 本地 OMP / Pi 执行后端

## 状态与范围

最新多机部署已采用[原生 CLI 访问层](./native-host-deployment.zh-CN.md)：四工具自动发现，配置/登录由各 CLI 管理，访问密码单独保护网页；不再在新部署中注入 CC 的专用 Codex 代理。下文保留各阶段迁移记录，当前接入边界以最新说明为准。

新增独立 Codex CLI 聊天适配：使用 Codex app-server，不进入本节 OMP/Pi RPC；原生登录与上下文由 Codex 管理。用户已授权验证和上线，99 项回归、真实模型目录/空会话恢复、构建和浏览器模拟检查通过，没有发送真实模型提示。发布结果见 `/opt/omp-web-codex-release-c8H1wcVC/status.json`；接口、持久化、权限和验证范围见 [Codex CLI 说明](./codex-cli.zh-CN.md)。

本次源码改造将聊天执行从 `@earendil-works/pi-coding-agent` 的进程内 SDK 改为本机 `omp` 子进程。用户随后授权验证、隔离构建和部署重启。已通过类型检查、12 项模拟测试，以及本地 OMP 18.16.0 的目录查询、新建/恢复、导航、Fork、HTML 导出和旧 Pi 格式历史恢复检查；没有发送模型请求，也没有安装依赖。隔离生产构建已通过，Build ID 为 `XLm7bmSTeo3efW4oW72bA`；构建只出现既有 `instrumentation.ts` 动态依赖警告。生产切换单独执行，最终结果以 `/opt/omp-web-native-release-9I3mUSzs/status.json` 为准（`active` 表示已切换且健康检查通过，`rolled_back` 表示已恢复旧版），不能仅凭源码修改判断是否已上线。

当前新增双引擎选择：默认 OMP，新会话可选择 Pi；已有会话继续使用原引擎。本轮随后获授权验证和上线：类型检查、44 项回归、两种原生进程的隔离 RPC、构建后真实 API 及浏览器交互均已通过，未发送模型提示、未更新引擎、未安装依赖。最终隔离构建为 `7wD-OUaKw27tMHe--9736`，只有此前的 instrumentation 动态依赖警告。发布目录 `/opt/omp-web-engines-release-WWiLuFMS` 内的 `status.json` 记录最终 `active` / `rolled_back` / `failed`，不能将源码/构建验证当作生产已上线。

后续 Pi 登录修正：终端 `/usr/local/bin/pi` 为 1.5.0，网页原先固定使用依赖内的 0.83.0；原有 `~/.pi/agent/auth.json` 含 `openai` OAuth 条目。旧版 OpenAI 提供商只支持 API Key，新版支持 ChatGPT OAuth。源码已改为使用同一本机 Pi，不转换或复制凭据。经本任务授权，类型检查和 41 项回归通过；使用原有登录的真实模型 API 返回 44 个 OpenAI 模型，构建后的桌面/手机浏览器实际显示这些模型并成功选择，未发送模型提示或更新引擎。修复构建为 `eGJZkUkZn-n5p0TsPsw96`；`/opt/omp-web-pi-fix-release-jakHJQ8T/status.json` 记录最终发布结果。发布后会再次查询真实 Pi 模型目录，若 OpenAI 模型仍为空则回滚，不能仅凭预览验证声明生产已修复。

```text
浏览器 → Next.js API / SSE → 所选引擎的本地 RPC 子进程 → 模型与原生工具
```

OMP 使用 `--mode rpc-ui`，Pi 使用本机 `pi --mode rpc`；可通过 `OMP_WEB_PI_EXECUTABLE` 指定一个可执行文件路径，否则使用服务 PATH 中的 `pi`。不接受 shell 命令，不回退到网页依赖内的旧版 Pi。两者都是真实本地 Agent，两种引擎之间不会静默回退。独立的网页终端保持不变。

## 可执行文件与数据

OMP 可执行文件解析顺序：

1. `OMP_WEB_EXECUTABLE`：服务端指定的单个可执行文件路径，不接受拼接的 shell 命令；显式路径失败时直接报错。
2. 服务用户的 `~/.bun/bin/omp`，若可执行。
3. 服务进程 `PATH` 中的 `omp`。

本机目标路径可显式配置为：

```ini
OMP_WEB_EXECUTABLE=/root/2/devbox-distrobox/.bun/bin/omp
```

这份说明不会自动修改 systemd 环境。进程以服务用户身份在所选项目 cwd 中运行；恢复会话使用精确文件路径（OMP `--resume`，Pi `--session`），而不是自动续接最近会话。每个引擎负责自己的持久化、模型、工具和凭据。若 OMP 会话被终端占用，保留原生租约报错，不抢占会话。

OMP 数据目录继续由 `OMP_CODING_AGENT_DIR`、`PI_CODING_AGENT_DIR`、`~/.omp/agent` 按优先级选择。Pi 子进程使用独立的 `OMP_WEB_PI_AGENT_DIR` 或 `~/.pi/agent`，并仅在子进程环境中把它设为 `PI_CODING_AGENT_DIR`；不会误用目前服务指向 OMP 的同名变量。两者数据目录解析到同一路径时拒绝使用。各引擎自己发现项目配置、扩展、技能和凭据，不复制 OAuth、API Key 或配置到另一引擎。

OMP 的 RPC 模式本身可能有不同于 TUI 的默认设置（例如后台任务、memory/advisor 等协议默认值）；显式 OMP 配置优先。使用同一本地二进制不意味着每项终端交互都有网页界面。

## 选择引擎与历史归属

- 网页引擎选择器设置新会话使用的 OMP / Pi，并记住选择。切换引擎会打开同一项目下的新对话，不转换原会话，也不停止它仍在执行的后台任务。旧对话可从侧栏继续打开；侧栏显示所属引擎。
- `/api/agent/new` 接受 `engine`，未提供时仍为 OMP。已有会话命令、SSE、历史、Fork、改名和 HTML 导出都由会话 ID 决定引擎，不能用当前下拉框选择覆盖旧会话。
- OMP 的网页 ID 保持原样；Pi 的网页 ID 为 `pi:<原生ID>`，避免两个数据目录内相同 UUID 发生冲突。前缀只用于网页/API/cache，原始 JSONL 的 ID、内容和父子关系不改写。旧 OMP 链接继续有效。
- 历史分别扫描两种 Agent 数据目录，再合并显示；父会话解析只在同一引擎内进行。位于 OMP 数据目录的旧 Pi 格式历史保持此前 OMP 归属，不按格式猜测引擎或自动迁移。
- 模型目录、默认模型与 thinking 信息由所选原生进程查询；后端缓存包含 `engine + cwd`，浏览器的模型选择也按引擎隔离。切换到 Pi 不会沿用 OMP 的认证或模型列表。
- Pi 项目资源信任使用其真实 `ProjectTrustStore`，保存在 Pi 数据目录。网页的确认只更新 Pi 信任，不替 OMP 授权；运行中的 Pi 会话需要新建会话才能加载新批准的资源。OMP 沿用自身信任规则。

本轮验证使用临时 HOME 和两套临时 Agent 目录：两引擎均完成无提示的新建、精确恢复、before-message Fork、HTML 导出和再次新建空会话；同一原生 UUID 在两目录中分别解析为 OMP ID 与 `pi:` ID，父会话不会跨引擎关联。构建后 API 实际创建了两种空会话，错误引擎切换返回 409，模型缓存与各自原生查询一致。浏览器验证使用拦截的模型/会话响应，覆盖切换、过期模型响应、历史恢复、Pi 配置隔离、OMP 更新入口、中英文和 390px 手机布局；未把浏览器模拟发送交给真实模型。详情保存在发布目录的 `native-verification.json`、`api-verification.json` 和 `verification.json`。

Pi 的登录/配置使用和网页相同的本机程序与独立数据目录：

```sh
PI_CODING_AGENT_DIR="${OMP_WEB_PI_AGENT_DIR:-$HOME/.pi/agent}" "${OMP_WEB_PI_EXECUTABLE:-pi}"
```

已有有效登录无需重新登录；需要配置时使用 Pi 的 `/login`、`/model`。服务与交互终端 PATH 不一致时，把 `OMP_WEB_PI_EXECUTABLE` 设为终端实际 Pi 的绝对路径。本机当前路径为 `/usr/local/bin/pi`。不要在继承服务 `PI_CODING_AGENT_DIR` 的终端里不加区分地启动 Pi；也不要用网页依赖内的旧版 CLI 重写新版登录。网页设置面板说明相应目录；“更新 OMP”只影响 OMP。


## 已实现的接入

- 两种引擎的新会话、精确路径恢复、模型和 thinking 切换。空白会话在首条消息前可能尚未落盘；不能为强制落盘而擅自发送模型请求。
- 提示、图片、steer/follow-up、取消、压缩及命令输出。
- OMP `prompt_result` / `session_settled` 与 Pi 的原生提示响应 / `agent_settled` 分别适配为网页完成事件；`agent_end` 不等于重试、压缩和后台工作已经结束。
- `select` / `confirm` / `input` / `editor` 工具和扩展弹窗，保留请求 ID、取消、过期时间以及重连重放。初始化阶段尚无网页可回答的弹窗会明确取消并提示，绝不自动批准。
- 模型列表通过所选引擎的短生命周期 `--no-session` RPC 查询，并按引擎/项目缓存；查询不主动发送模型提示，但仍会加载该引擎允许的原生项目资源。
- 命令补全使用 OMP `get_available_commands` 或 Pi `get_commands`；网页保留少量本地便利命令。
- 消息 Fork 使用 OMP `branch` / Pi `fork`（均为该用户消息之前）；整段 `/fork` 使用 OMP `fork` / Pi `clone`。切换后释放旧注册项与子进程，返回带正确引擎身份的新网页 ID。
- 会话改名和 HTML 导出交给所属引擎；历史查看只读解析 JSONL，不再移动或改写 OMP 首行固定宽度标题槽。
- LF-only JSONL、请求 ID 匹配、退出传播、EOF 清理与超时终止；OMP 支持 v2 分块协商，Pi 使用有大小上限的完整 JSONL 行，不等待 OMP 的 ready 事件。
- 页面显示会话实际使用的 OMP / Pi 引擎；Web 版本与 Agent 版本分开，不把 Pi 包版本标成 OMP 版本。

## 网页更新 OMP 并重启

> 后续统一设置改造：左下角入口改为“设置”，提供 Pi、OMP、Claude Code、Codex 四个更新按钮；共享更新锁，旧 `/api/omp/update` 仍只更新 OMP。用户已授权上线，82 项测试、构建、基础 API 和浏览器模拟检查通过，没有实际升级任何 CLI。发布结果见 `/opt/omp-web-settings-release-dh8GTLne/status.json`；新实现和说明见 [软件更新](./software-updates.zh-CN.md)。以下记录最初的 OMP 专用更新实现。

模型设置入口打开的“本地 OMP 配置”面板提供“更新 OMP 并重启”按钮。技能、插件入口也使用同一面板。确认框会说明：操作会下载/安装本机 OMP 更新，并在成功后重启 `omp-web.service`；所有网页中的运行任务和内嵌终端都会中断，未落盘内容可能丢失，应先结束任务、保存工作。

- `POST /api/omp/update` 仅接受 `{ "confirm": true }`，复用网页的 Host、Origin 和密码校验；不接受客户端提供的命令、路径或服务名。`GET` 只读查询状态和缓存的 OMP 版本（最多执行有超时限制的 `omp --version`），不会触发更新。无密码部署仍只应放在可信网络/VPN 内：能使用网页的人也能点击更新按钮。
- 仅支持本机这种 Linux、root、systemd `omp-web.service` 部署；开发服务器或其他服务会显示不可用。执行前同时核对当前控制组与 systemd `InvocationID`，避免重启错误服务。
- 使用聊天相同的 OMP 可执行文件与 Agent 数据目录，调用官方 `omp update`，不执行 Pi 包更新，也不更新 omp-web 自身。将该可执行文件的目录置于子进程 `PATH` 首位，避免官方更新器更新另一个安装。保留 OMP 自己的更新通道，不传 `--force`、`--plugins`、`--canary` 或 `--stable`。
- 更新前后调用同一可执行文件的 `--version`。只有更新退出码为 0 且更新后的版本输出有效，才执行 `systemctl --system --no-ask-password --no-block restart omp-web.service`。已是最新版本时也会重启，以重新加载进程。版本检查不等于新版 RPC 协议或模型调用兼容性验证。
- 同时只允许一个更新任务；显示更新输出的末尾 16,384 字符。更新超时/失败或版本检查失败时不发起重启，保留错误信息，不自动重试。网页层不另做二进制回滚，安装/替换行为由官方更新器负责。
- 状态原子写入服务用户的 `${XDG_STATE_HOME:-$HOME/.local/state}/omp-web/omp-update.json`（文件权限 `0600`），与 OMP 配置、凭据、会话分离。服务意外中断更新后不会自动重复安装。只有新的 systemd 实例返回状态后，页面才认为重启成功并自动刷新；断网本身不算成功。
- 本按钮实现不改写 `autoResume`，也不删除或修复已有父子会话。官方更新器对其自身安装及配置的处理遵循上游行为。

实现文件：`lib/omp-update.ts`、`lib/omp-update-types.ts`、`app/api/omp/update/route.ts` 及 `components/OmpNativeSettings.tsx` 中的更新控件。更新命令依据：[OMP v18.16.0 官方更新实现](https://github.com/can1357/oh-my-pi/blob/v18.16.0/packages/coding-agent/src/cli/update-cli.ts)。

更新按钮此前隔离构建 `BUuxST_vjTEB72_nJ51_g` 的发布因生产检查返回 `Untrusted API request` 而回滚，记录在 `/opt/omp-web-update-release-2CIbRe9O/status.json`。本轮已确认原因：Node v24.18.0 的 `fetch` 忽略脚本指定的 Host，实际 Host 仍是回环地址，和保留的命名主机 Origin 不一致。新发布任务改用 `node:http.request`；相同命名主机请求已返回 200，错误 Host 和跨站 Origin 仍返回 403，未放宽网页安全规则。新构建同时包含更新按钮，但没有执行真实 OMP 更新；发布健康检查也不创建 Agent 会话或查询模型。

## 有意限制

旧版模型认证、插件和技能面板依赖进程全局目录，尚未按引擎隔离，因此 `/api/auth`、`/api/models-config`、`/api/plugins`、`/api/skills` 继续由 proxy 返回 409。设置面板展示所选引擎的原生配置与登录方式；不会把 OMP 的凭据当成 Pi 凭据，也不会把旧面板重新挂在错误的引擎标签下。

- Pi 的 `none/default/full` 工具预设已从聊天入口移除；旧浏览器发送的 `toolNames` 请求明确拒绝，不能悄悄把“关闭工具”变成“全工具”。
- OMP 的 `set_tools`、原始 TUI 输入、`abort_compaction`，以及当前网页 Pi 适配未接入的导航、队列撤回、工具枚举/切换、资源重载和子代理控制等操作，明确禁用或报错，不伪装成功。Pi `/fork` 使用原生整段克隆，消息 Fork 使用原生 before-entry fork；本机新版 Pi 支持的额外操作不等于网页已接入。
- 普通 shell 使用各自原生 `bash`。OMP RPC 不支持 `excludeFromContext`，因此拒绝 `!!`；Pi 使用其原生支持的字段。独立网页终端不受此差异影响。
- OMP 队列召回仅移除仍待处理的文本消息，已开始投递的内容不会撤回；网页 Pi 适配尚未接入队列召回，控件隐藏。尚不提供完整的图片队列草稿恢复。
- 子代理可以由 OMP 的工具执行；本次没有实现完整 Agent Hub、专用子代理控制面板或所有 TUI-only 界面。
- OMP 与 Pi 的项目资源和信任策略互不替代。模型目录查询也可能初始化资源；只使用可信项目、网络或 VPN。网页终端与 Agent 都有服务用户的权限。
- 不保证历史展示层完整表达每个引擎的所有特有元数据。原始记录保留不动；Pi 包既提供只读历史投影，也提供 Pi 引擎的本地 CLI，但不会在 OMP 会话中执行 Pi。

## 文件与协议依据

- `lib/agent-rpc-client.ts`：两种原生进程的启动、传输与协议差异。
- `lib/rpc-manager.ts`：网页命令/事件适配、注册表和生命周期。
- `lib/session-reader.ts`：只读会话视图、OMP 元数据的内存投影。
- `lib/engine.ts`、`lib/engine-paths.ts`：引擎类型、网页 ID 命名空间和独立数据目录。
- `app/api/models/route.ts`：原生模型目录查询。
- 设置面板、`proxy.ts`：按引擎显示配置说明，隔离未按引擎改造的旧编辑接口。
- `lib/omp-rpc.test.mjs`：模拟子进程和只读临时会话的测试；不会调用真实 OMP 或模型。
- [OMP 官方 RPC 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)
- [OMP RPC 类型](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [OMP 会话格式](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts)

## 验证与发布授权范围

1. 已授权并通过：使用已有依赖进行 `node_modules/.bin/tsc --noEmit --incremental false` 与 `node --test lib/omp-rpc.test.mjs`（12/12）。不安装依赖。
2. 已授权并通过：本地 `omp --version` 为 `omp/18.16.0`；隔离临时会话的 RPC 查询得到 27 个可用模型、90 条命令及原生 `task`、`web_search`、`eval` 等工具。恢复、导航、Fork、导出和旧格式历史检查通过。临时样本在检查后清理；没有发送模型提示。OMP 初始化可能查询提供商目录。
3. 如另获允许，进行一次最小模型对话，以及工具、提问弹窗、停止、恢复、Fork、图片、压缩和后台任务的端到端检查。模型请求可能计费。
4. 已授权并完成隔离构建，发布目录 `/opt/omp-web-build-native-zDLrs76g`。独立切换任务先保留旧 `.next` 到 `/opt/omp-web-next-before-native-9I3mUSzs`，再切换产物并重启。随后检查首页/静态资源、旧 Pi API 的 409 响应、原生模型目录和一个无提示的 OMP 会话；空健康检查会话按正常 10 分钟空闲超时关闭。失败时自动恢复旧构建。当前对话由待重启服务承载，因此切换任务在完成回复后启动，并将结果写入上述状态文件。不要在运行中的生产 `.next` 内直接构建。

未经对应授权，不执行上述步骤，不把静态源码审阅当作运行成功证明。
