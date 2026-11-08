# Herdr、Orca、Paseo 与远程浏览器工作流：README 对比依据

查阅日期：Herdr、Orca 为 2026-11-07，Paseo 为 2026-11-08。范围按维护者要求限定为 **Herdr、Orca 和 Paseo**，不再罗列其他 Agent 整合工具。

本次只查阅官方仓库 README 和官方文档，没有安装、运行或实测竞品，也没有配置 Tailscale/EasyTier。以下是产品定位与公开功能的比较，不是配置耗时、稳定性、安全性或性能排名。

## 维护者的动机与事实边界

维护者表示自己尝试过这些整合方案，但额外配置、终端/工作区约定容易打断已有工作流。README 将其写成个人使用感受与本项目的取舍，而不是未经证实地断言竞品会破坏文件、凭据或配置。

“保留使用方式”指继续使用原来的 Agent、登录、模型配置、项目与原生工具；不是免除网页服务安装、访问密码、网络配置，也不是承诺所有 CLI/TUI 操作或其他终端中的活动会话都可直接映射到网页。

## Herdr

对比对象：[`herdrdev/herdr`](https://github.com/herdrdev/herdr)，同时参考官方桌面应用 [`herdrdev/herdr-app`](https://github.com/herdrdev/herdr-app)。

### 官方说明支持的事实

- Herdr 将自己定位为 coding agents 的 runtime，由后台服务器保持终端运行。关闭客户端或 SSH 断连不必停止后台工作；服务器/机器重启后的恢复不等于原进程跨重启存活。
- 通过终端 pane、布局、Agent 状态、CLI/socket API 和插件组织工作；可以组合本地与保存的 SSH 机器，并分别重连。
- 官方明确说明运行用户已有的 CLI，不包装或替换它们，而是拥有其终端。因此不能把 Herdr 描述成强制更换 Agent 或模型登录的系统。
- 官方桌面应用使用 space/tab/pane 组织工作，由 herdr-core 运行终端；窗口和运行核心分开，远程机器通过 SSH 加入。

来源：[runtime README](https://github.com/herdrdev/herdr/blob/master/README.md)、[desktop app README](https://github.com/herdrdev/herdr-app/blob/master/README.md)。

### 本项目的区别

本项目不要求为了远程聊天而先把 Agent 纳入另一套终端 runtime 和 pane 管理习惯：网页通过各 Agent 已支持的原生接口启动/恢复对话，浏览器是主要交互入口，终端作为独立辅助工具。

这是交互方式与运行管理重心的区别，不是声称 Herdr 无法远程工作、不能沿用原生 CLI，或其插件生态不存在其他客户端。也不能说 omp-web 提供了与 Herdr 相同的持久终端、多机汇总或重启恢复保证。

## Orca

对比对象：[`stablyai/orca`](https://github.com/stablyai/orca)，不与其他同名项目混淆。

### 官方说明支持的事实

- 官方 README 将其定位为 Agent 编排工作区，包含协调者/工作 Agent、并行 worktree、diff 审查、Git/任务整合、插件与自动化。
- 提供 Chat/Terminal 两种交互，并明确说明原生 CLI 支持。不能声称它不支持原生工具或必须迁移全部 Agent 凭据。
- 远程方案包括 Remote Orca Server、SSH 主机及云端运行环境；提供手机伴侣应用。
- 已有文件浏览、拖放文件/图片、富预览和内嵌浏览器等功能。因此“能传文件”“有手机入口”不是 omp-web 独有优势。

来源：[官方 README](https://github.com/stablyai/orca/blob/main/README.md)，`Features`、`Also in the box`、`Supported Agents`。

### 本项目的区别

本项目选择较窄的目标：在原有主机和项目上，提供一个浏览器入口访问 OMP/Pi/Claude Code/Codex，加上独立终端、文件管理和预览。无需为了普通对话采用协调者/worker 或新的 worktree 编排流程，但这不意味着 Orca 的所有使用方式都强制要求这些流程。

不能把这种取舍夸大为完整功能替代、性能优势，或对 Orca 配置复杂度的客观测量。

## Paseo

对比对象：[`getpaseo/paseo`](https://github.com/getpaseo/paseo)，同时参考官方站点 [paseo.sh](https://paseo.sh/)。

### 官方说明支持的事实

- 官方 README 自述为 Claude Code、Codex、Copilot、OpenCode、Pi 等 Agent 的统一界面；仓库简介为在桌面和手机上编排多个 coding agent。站点 FAQ 另列出 OMP，并称可经 ACP 支持更多 Agent；README 与站点的 Agent 列表不完全一致。
- 架构为本机守护进程（daemon）管理 Agent，桌面应用（Electron，内置 daemon）、手机应用（iOS/Android）、网页应用和 CLI 作为客户端连接；daemon 也可无界面运行在服务器、VM 或 Docker 中。
- 远程设备可通过可选的端到端加密中继配对，也可不启用中继、直接经 TCP、Tailscale 或其他 VPN 连接。
- 官方说明运行用户已安装并配置好凭据的 CLI，不修改其行为，不提取 token 或直接调用推理 API。因此不能把 Paseo 描述成要求迁移 Agent 登录或配置的系统。
- 支持并行 Agent 各自使用 worktree、跨提供方编排（Agent 可创建 worktree、启动并与其他 Agent 通信），以及 MCP、CLI、TypeScript SDK 和插件；FAQ 说明 worktree 仅在使用 Git 时相关。
- 桌面应用在一个窗口内提供 Agent、编辑器、终端、diff、PR 和内嵌浏览器。因此终端、文件编辑和多设备访问不是 omp-web 独有优势。

来源：[官方 README](https://github.com/getpaseo/paseo/blob/main/README.md)、[官方站点与 FAQ](https://paseo.sh/)。

### 本项目的区别

本项目不提供多 Agent 编排、独立客户端应用、中继或设备配对：主机上的一个网页即为全部入口，范围限于对话、独立终端和文件管理。

这是范围与形态的取舍，不是声称 Paseo 不能沿用原生 CLI、没有网页客户端或远程访问能力，也不是对其配置复杂度的客观测量。

## Tailscale 与 EasyTier

### Tailscale

官方 Serve 文档说明可以把本机端口代理为 tailnet 内可访问的服务，并使用 HTTPS；网络访问控制仍适用。Serve 与公开暴露的 Funnel 不是同一访问范围。

来源：[Tailscale Serve 官方文档](https://tailscale.com/docs/features/tailscale-serve)。旧地址 `https://tailscale.com/kb/1312/serve` 在查阅时重定向到该页面。

### EasyTier

官方仓库和站点描述去中心化虚拟网络、加密、NAT 穿透、子网代理和多平台支持。加入对应网络的节点可使用虚拟地址通信；其他设备也可经按文档配置的网关/路由接入。不能保证所有 NAT/防火墙环境都能直接建立连接。

来源：[官方 README](https://github.com/EasyTier/EasyTier/blob/main/README.md)、[官方文档](https://easytier.cn/en/)。

### 应用于 omp-web 的准确表述

- 主机运行原有 CLI 与 omp-web，保持在线；浏览器设备已接入可达的私有网络，或通过可信网关接入。
- 完成这层网络准备后，工作设备只需浏览器，不需要再安装 Agent CLI、桌面整合应用或 SSH 客户端。
- 继续启用网页密码、Host/Origin 校验与访问限制。私有接口直连与 loopback 后的 HTTPS 代理是两种配置方式。
- 浏览器不会自动建立 VPN。Tailscale/EasyTier 是可选外部网络工具，不是 omp-web 内置功能；本次没有安装或验证组网部署。
- Tailscale Serve 的身份头不等于 omp-web 已实现 Tailscale SSO，本项目仍使用自己的网页登录认证。

## 远程 Claude Code 的具体便利

本仓库提供消息复制、附件处理、文件浏览器和独立终端，可将常见远程工作从 SSH/TUI 移到浏览器：

- 选择、复制回复和代码，而不是只依靠终端的滚屏与文本选择。
- 上传截图或普通文件，不必为日常传文件再单独开 SCP/SFTP 工具。
- 浏览、预览、复制/移动/重命名项目文件，手机通过“更多”菜单操作。
- Agent 工作时仍可运行独立 Shell 命令；终端输入不会自动写入 AI 对话。

依据：[文件浏览器](./file-browser.zh-CN.md)、[终端说明](./self-hosting.zh-CN.md)、`components/MessageView.tsx` 的复制入口、`components/ChatInput.tsx` 的附件/粘贴处理。

普通文件上传到主机后作为路径引用交给 Agent，不意味着任意格式都是模型原生附件。浏览器剪贴板/文件选择权限和 Agent 附件能力仍适用；也不承诺自动接管已经在其他终端运行的同一个会话。
