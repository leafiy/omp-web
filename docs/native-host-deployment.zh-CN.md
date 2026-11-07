# 多机部署：原生 Agent 的网页访问层

## 边界

网站只负责访问认证、聊天界面、终端、转发，以及必要的网页会话索引/显示缓存。它不分发模型配置、API key、OAuth 登录或原生历史，不在机器间复制这些数据。

- OMP、Pi、Claude Code、Codex 都调用服务用户已安装的原生可执行文件。
- 原生工具自己加载自己的登录、模型、技能、插件、hooks 和权限配置。网页不再向 CC 注入专用 Codex 代理密钥，也不强制覆盖 Codex 的功能/审批配置。
- 明确手选模型时，通过原生接口应用该次选择；没有选择时不猜测或覆盖原生默认。
- 原生历史归原生 CLI 管理。CC/Codex 目前仍有私有的网页消息投影，用于页面恢复；这不是模型配置或凭据仓库，也不参与原生上下文构造。
- 网页不等于完整 TUI，部分交互仍未封装。需要完整终端功能时，用原生 CLI；不要把未实现的网页操作理解为已受支持。
- 不执行登录 shell 来“搜设置”，也不读取 shell rc 或复制临时 export 的密钥。若工具依赖特定运行环境，由机器管理员给该工具/服务提供相应环境。

## 自动发现

`lib/agent-executable.ts` 只检查文件元数据，不启动程序或读取登录文件：

1. 管理员明确指定的可执行文件（指定错误就报错，不暗中换安装）。
2. 服务 PATH。
3. 当前用户的 `.local/bin`、`.bun/bin`、npm/pnpm 用户目录、当前 Node 附近及常见系统目录。
4. NVM、fnm 的已安装 Node 目录。

相对 PATH 和网页自身 `node_modules` 中的旧 Agent 依赖不会成为自动执行后端。`GET /api/engines` 返回所选路径和安装状态；没找到的工具在新聊天选择器中标注并禁用。设置里的更新/版本功能使用同一份路径选择。

现有 `OMP_WEB_EXECUTABLE`、`OMP_WEB_PI_EXECUTABLE`、`OMP_WEB_CC_EXECUTABLE`、`OMP_WEB_CODEX_EXECUTABLE` 仅用于特殊安装路径覆盖，不包含模型或凭据。

## 访问密码

推荐在每台机器独立创建私有文件：

```ini
OMP_WEB_REQUIRE_PASSWORD=1
PI_WEB_PASSWORD_FILE=/etc/omp-web/access-password
```

网页登录用户名固定为 **pi**，与 Pi 工具的登录无关。密码文件由服务用户独占（0600），一行密码；不能是符号链接、空文件或公开可读文件。文件不可读时失败关闭，不会退回无密码模式。旧 `PI_WEB_PASSWORD` 环境变量仍兼容，但不能与密码文件同时设置非空值。

密码不放进代码、构建、启动参数或 Agent/终端子进程环境。`bin/web-password.js` 是启动器和请求校验共用的读取入口。更换密码后重启网页，确保旧 SSE/终端连接也被断开。

所有普通接口都经过密码校验；只有准确匹配的聊天/终端 SSE 路径绕开代理缓冲，它们自行执行同样的密码、Host 和 Origin 检查。普通文件或旧接口名以 `/events` 结尾不能绕过认证，活动会话事件流也要求认证。

Basic Auth 本身不加密传输。公网使用必须加 HTTPS；私有部署只绑定可信隧道地址，或绑定 loopback 后通过 SSH 转发。不要监听公网通配地址。

## 可重复发布

1. 在独立目录测试、构建，不能覆盖运行中的 `.next`。
2. 用 `scripts/package-native-host.sh <构建目录> <新归档路径>` 打包。脚本只读取已构建产物和依赖，白名单不包括 `.env`、Agent 用户目录、凭据、原生历史或网页消息投影。
3. 在目标机器解压到一个新发布目录。Node/平台不同，需要在目标机重建已有原生依赖，不能盲用另一 ABI 的 `.node` 文件。
4. 在目标机生成独立访问密码；服务环境只配置网页访问和运行环境，不导入来源机器的 Agent 设置。
5. 用目标用户运行程序，验证未登录/错误密码被拒绝、正确密码可访问、SSE 也受保护、四工具路径正确，再切换服务链接。
6. 失败时停用新服务或恢复旧发布链接。软件更新和模型请求不是部署验证的默认步骤。

## 本次远端结果：192.168.52.3

- URL：`http://192.168.52.3:2225`，只监听该 tun0 地址，没有监听公网网卡或公网 IPv6。
- SSH/服务用户：root。网页和终端具有该用户权限，不是额外的沙箱。
- 服务：`omp-web.service`，已启用开机启动；隧道地址暂不可用时重试，不回退到公网监听。
- 当前程序链接：`/opt/omp-web` → `/opt/omp-web-releases/20261107-followup-eNobApPg`。此前 UI/子 agent 版及更早发布目录保留用于回滚；依赖仍使用首次版本 `/opt/omp-web-releases/20261105-native-host-cYZladu2/node_modules`，不能删除。
- 访问密码：远端 `/etc/omp-web/access-password`，0600，未输出到聊天。
- 网站运行环境：`/etc/omp-web/web.env`，仅网站运行与认证字段，没有 Agent 模型配置或密钥。
- 原生路径均自动选择 `/root/.local/bin/` 下的四个工具，未选到旧 `.bun/bin/omp` 或网页依赖里的旧 Pi。
- 版本：OMP 18.16.0、Pi 1.5.0、CC 2.1.318、Codex 0.166.0。
- 目标 Node 22.22.1（ABI 127）。只离线重建了已有 SQLite 依赖；SQLite 和真实 PTY 的只含 `printf` 测试通过。没有安装/升级四个工具。
- 122 项本地测试、类型检查和隔离构建通过。远端首页、API、三个 SSE、错误密码、跨源请求和编码路径认证检查通过。测试没有发送模型消息，也没有读取/复制 Agent 登录文件。
- 已补充独立的[订阅用量](./subscription-usage.zh-CN.md)面板，替换左下角重复的“插件”入口；130 项测试和远端原生额度读取验证通过，密码保持不变。
- CC [斜杠命令菜单和参数补全](./claude-code-commands.zh-CN.md)已上线：148 项隔离回归、类型检查、构建通过，桌面/390px 浏览器模拟连续三轮通过，覆盖 `/effort` 参数筛选、嵌套选项、键盘/点击/手机触摸、光标编辑及不自动发送。Build ID `kdrlpM32fT98MdosaHh89`，状态为 `active`（2026-11-06）。本次部署检查仅验证网页认证、原生可执行文件发现和私有地址监听，没有启动 Agent 或发送模型提示；真实账号命令行为仍由用户验收。
- 独立[技能面板](./native-skills.zh-CN.md)已修复并部署：157 项回归、类型检查、隔离构建通过；浏览器复现了旧入口打开设置的问题，修复后桌面/390px 手机、四引擎切换、搜索、失败提示和无项目提示均通过，并复查了命令参数补全。该轮 Build ID 为 `ae4k6_mlEXRlINVFfAu8C`，远端 `status.json` 记录 `active`（2026-11-06）。该轮没有真实模型请求或 Agent 升级。
- [CC 上下文容量修复](./claude-code-context.zh-CN.md)已部署：166 项回归、类型检查、构建与桌面/手机浏览器检查通过，移除硬编码 128K。两台机器各一次服务用户 HOME 下的只读原生摘要均返回 1M；不代表所有项目统一配置，也未发送模型提示或调用额外 Token 计数 API。该轮 Build ID `ejxoSY5wdXZGc2SoXQs-f`，远端状态 `active`（2026-11-07）。
- [CC 运行中引导与后续消息](./claude-code-steering.zh-CN.md)已部署：176 项回归、类型检查、构建和桌面/手机浏览器通过，另用真实 CC 2.1.318 对接隔离的本地假模型服务验证 `next`、`later` 和停止清队列。无真实模型调用、无订阅消耗。该轮 Build ID 为 `ejTdkhVL7q0-HLCSj1agU`，远端状态 `active`。
- [长对话分页/缓存](./history-cache.zh-CN.md)、[队列取回编辑](./queued-message-editing.zh-CN.md)与[非阻塞确认](./nonblocking-ui.zh-CN.md)已统一发布：199 项测试、类型检查和隔离构建通过；合成 3000 条消息的首屏由约 9.8 MB 降至 234 KB，150 ms 延迟/128 KiB/s 限速浏览器中回切缓存约 75 ms。没有读取真实聊天正文或调用真实模型。该轮 Build ID `l7alXce6gBI9LH9GvqWip`，远端状态 `active`。
- [文件浏览器](./file-browser.zh-CN.md)已发布：当前目录上传、持续 spinner、右键/手机菜单、复制/剪切/粘贴、移动/重命名、新建及确认删除。225 项测试、类型检查和隔离构建通过；浏览器在临时目录实际执行文件操作，并验证过期确认、取消/防重复、手机触摸，以及确认期间聊天持续流式输出。当前 Build ID `6h8QCoi0ebFkSby4NpXqV`，远端状态 `active`。新接口鉴权、跨源与无副作用的参数边界检查通过；没有操作用户文件或读取真实聊天正文，也没有启动真实 Agent 测试。
- 实际远端状态：当前远端发布目录中的 `status.json`。本机同步见下节，不再把远端发布当作本机已更新。

## 本机同步：pc:2225

本机上一轮分页/缓存、取回编辑与非阻塞确认构建 `l7alXce6gBI9LH9GvqWip` 已由状态文件确认 `active`。本次再次获授权同步文件浏览器构建 `6h8QCoi0ebFkSby4NpXqV`，保留此前所有原生工具接入与聊天改进。

当前对话本身运行在本机 `omp-web.service` 下，因此使用独立 systemd 延迟任务切换 `.next`；不会在对话尚未回复时重启自己的宿主。任务停止服务后保留旧 `.next`，切换产物、重启并检查首页、静态资源、技能/文件操作接口边界、四工具发现及 Host/Origin 保护。失败自动恢复旧产物。

- 本机状态：`/opt/omp-web-files-stage-rOtJCdMH/local-status.json`，只有 `phase: active` 表示本机切换和检查成功。
- 本机回滚产物：同目录 `backup.next`；不替换 Node 依赖，不修改原生 Agent 配置、登录或历史。
- 本机既有访问方式和服务环境保持不变；它仍是原先的可信内网部署，不因为远端有密码就自动获得同样的访问保护。

### 本机子 agent 状态发布

后续新增四引擎[子 agent / 后台任务状态](./subagent-status.zh-CN.md)，并合入[顶栏、子对话、草稿与消息操作](./ui-refinements.zh-CN.md)。最初候选 `/opt/omp-web-tasks-stage-Knhh0eP5` 已暂停，替换为整批候选 `/opt/omp-web-ui-stage-WcNACZgQ`，Build ID `Db0AnIx9G3pSXJmX-CBZ4`。

105 项相关回归、类型检查、构建、桌面／390px 浏览器，以及隔离网络中的真实 Claude CLI 子任务与子对话读取测试通过。全量 451 项中 435 项通过，剩余 16 项与未修改 HEAD 相同。本轮整批复验使用假模型，没有增加真实模型请求。

用户已授权本机、GitHub 和远端更新。本机以新候选目录 `local-status.json` 的 `phase: active` 为准；远端候选目录为 `/opt/omp-web-releases/20261107-agent-ui-WcNACZgQ`，以其 `status.json` 的 `phase: active` 为准。远端切换前发现一个新运行的 Claude 会话，已改为等待原生进程与运行队列空闲后切换（`waiting-status.json`），没有强制中断旧任务。两处均保留旧发布供失败回滚；不把已构建、等待或已排定切换等同于已上线。

### Follow-up 与 hover 操作后续发布

上一批 `Db0AnIx9G3pSXJmX-CBZ4` 已由本机和远端状态文件确认 `active`。后续增加四引擎统一的服务端 Follow-up 待发送队列，以及编辑／复制同组 hover 显示，详见 [队列与编辑](./queued-message-editing.zh-CN.md)。

本轮 Build ID：`uaWjyBpy8MMW18C0YzE9g`。发布目录：本机 `/opt/omp-web-followup-stage-eNobApPg`，远端 `/opt/omp-web-releases/20261107-followup-eNobApPg`。远端已切换并通过认证、跨源保护、监听地址和新接口检查，`status.json` 为 `active`，密码保持不变。119 项针对性回归通过；全量 465 项测试中 449 项通过，剩余 16 项与上一版相同；类型检查、生产构建、四引擎真实队列模块的浏览器测试、既有 UI／子任务浏览器测试和隔离的真实 Claude 子任务 + Follow-up 测试通过。新增浏览器用例也覆盖入队回执延迟时提前取回编辑，防止重复拼接或被晚到回执清空。

本机切换由独立任务等待本对话真正空闲后执行，避免中断新输入；最终仍以各发布目录的 `local-status.json` / `status.json` 中 `phase: active` 为准。待发送队列不承诺跨服务重启恢复，因此发布前检查运行会话与原生进程，不能在还有其他任务时强行切换。

配置/接口能被检测到，不代表每个模型账号都已登录或有使用额度。真实聊天和技能目录内容由用户验收；登录仍通过各机器上 CLI 的官方流程完成。
