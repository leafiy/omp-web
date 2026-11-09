# omp-web

[English](./README.md) · [简体中文](./README.zh-CN.md) · [项目主页](https://leafiy.github.io/omp-web/?lang=zh)

**在同一个浏览器工作区使用你本地的 OMP、Pi、Claude Code 和 Codex CLI，旁边就是终端和文件管理器。不用重新配置工作流。**

Agent 还是你机器上原来的那几个，继续用它们自己的登录、模型配置、技能和项目指令。omp-web 只是把它们放进一个网页，电脑和手机都能打开。

<img width="3458" height="2158" alt="image" src="https://github.com/user-attachments/assets/1795000f-0d74-4fb4-95e5-a7ea8c681b2d" />

## 我的使用环境

```text
异地家里一台常开的低配小电脑（Linux）
├── Claude Code / Codex / OMP / Pi   ← 各自登录好，模型走云端
├── 项目代码
└── omp-web（systemd 服务，只监听 127.0.0.1）
        │
        │  Tailscale Serve（HTTPS）或 EasyTier 虚拟网络
        ▼
手边的笔记本、手机、平板 —— 只需要浏览器
```

以前用 SSH 也能连上，但复制长回复、翻滚屏、看 diff、传截图和文件都很别扭，手机上更难受。现在打开网页就能阅读、复制、检查改动、上传文件；需要命令行时，旁边就有终端。

模型在云端，所以主机不用跑大模型；但 CLI、网页服务和项目构建仍然要占资源。这是我个人的配置，不是最低硬件要求。

## 怎样用得顺手

### 搭一次

1. **在 Agent 主机上安装。** 用已经登录好这些 Agent 的那个系统用户运行[安装脚本](#安装)，并选择安装 systemd 服务（开机自启）。
2. **通过私有网络访问。**
   - **Tailscale：** 保持只监听 `127.0.0.1`，用 Serve 套一层 HTTPS：`tailscale serve --bg 30141`。之后访问 `https://<机器名>.<tailnet>.ts.net`，并把这个域名加入 `PI_WEB_ALLOWED_HOSTS`（例如 `sudo systemctl edit omp-web.service`，添加 `Environment=PI_WEB_ALLOWED_HOSTS=<机器名>.<tailnet>.ts.net`）。
   - **EasyTier：** 让服务监听本机的虚拟 IP（安装时加 `--host <虚拟IP>`），其他设备直接用 IP 访问，不需要配置主机名。
3. **手机上「添加到主屏幕」。** 之后像独立 App 一样全屏打开。

### 日常使用

- **项目 → 会话**：侧边栏按项目列出会话，行首的 OMP / Pi / CC / CX 标签表示引擎。新建会话时选择目录和 Agent；已有会话会固定在原来的引擎上继续。
- **不用等它跑完**：Agent 运行时也能粘贴截图、拖入或附加文件；追加的消息进入队列，发出前可以取回修改。
- **看结果**：回复按 Markdown 渲染，带复制按钮；工具调用和子 Agent 对话可以展开；长历史按用户轮次折叠，点开即加载整轮。
- **查改动、管文件**：在文件树里预览文件、查看 Git diff；右键（手机上点「更多」）复制、移动、重命名、下载、删除，或上传到当前目录。
- **终端**：页面里的多标签终端，与对话互不干扰，不用另开 SSH。只有原生 TUI 才有的功能，直接在终端里运行 `claude`、`codex` 等即可。
- **分支与 worktree**：从任意一条用户消息处 Fork 出新会话；Git 项目可在新建会话时选择或新建 worktree。
- **原生控制**：模型、思考强度、斜杠命令、技能、权限确认、上下文和订阅用量（日/周/月 Token）都直接来自所选 Agent，支持范围因 Agent 而异。
- **完成提示音**：开启后任务完成时播放提示音，切到别的页面也能知道。

## 与 Herdr、Orca、Paseo 的区别

> 我试过不少 Agent 整合工具。它们功能更多，但对我已有的工作流来说，额外的配置、终端管理和工作区约定经常反而是干扰。我只想在浏览器里继续用原来的 Agent。

| 项目 | 定位 |
| --- | --- |
| [Herdr](https://github.com/herdrdev/herdr) | Agent 终端 runtime：后台会话、pane、Agent 状态、本地与 SSH 机器；另有[桌面应用](https://github.com/herdrdev/herdr-app)。 |
| [Orca](https://github.com/stablyai/orca) | Agent 编排工作区：并行 worktree、Chat/Terminal、代码审查、远程运行环境和手机伴侣应用。 |
| [Paseo](https://github.com/getpaseo/paseo) | 本机守护进程加桌面、手机、网页和 CLI 客户端；并行 Agent 各自使用 worktree，可跨 Agent 编排；设备可通过端到端加密中继或 Tailscale 等 VPN 连接。 |
| **omp-web** | 主机上的一个网页：本机的 OMP、Pi、Claude Code、Codex CLI，加上终端和文件管理。 |

这几个工具同样运行原生 CLI，也都有各自的远程、终端或文件功能，这些都不是 omp-web 独有的。omp-web 的范围更窄：一个页面里只有对话、终端和文件，不做多 Agent 编排，不需要另装客户端或配对设备，普通对话也不用先接受新的工作区约定。

对比依据为官方文档（Herdr、Orca 查阅于 2026-11-07，Paseo 查阅于 2026-11-08）：[来源与范围](./docs/agent-workspace-comparison-research.zh-CN.md)。

## 安装

**主机需要：** Linux 或 macOS、Node.js 22.19.0+、npm、Git，以及至少一个已经登录好的 Agent CLI：`omp`（Oh My Pi）、`pi`、`claude`、`codex`。访问设备上什么都不用装。

```bash
curl -fsSL https://raw.githubusercontent.com/leafiy/omp-web/main/scripts/install.sh | bash

# 同时安装自启动的后台服务（Linux：systemd，开机启动；macOS：launchd，登录后启动）
curl -fsSL https://raw.githubusercontent.com/leafiy/omp-web/main/scripts/install.sh | bash -s -- --service --host 127.0.0.1 --port 30141
```

脚本只检查运行时，不会替你安装。它会克隆或更新 `~/code/omp-web`、完成构建，并让你设置网页登录用户名和密码。无人值守安装时，设置 `OMP_WEB_USERNAME` 和 `OMP_WEB_PASSWORD`。

一键更新并重启：

```bash
bash ~/code/omp-web/scripts/install.sh update
```

`update` 不提问：拉取当前分支、停止服务、重新构建、再启动服务，登录信息和服务的地址端口保持不变。有未提交的改动时会拒绝。重启会中断正在进行的对话和终端，所以要在 omp-web 之外的终端（例如 SSH）里运行，从它自己的内嵌终端或 Agent 里运行会被拒绝。不带 `update` 再次运行安装脚本也能更新，只是停止服务前会先询问。

macOS 上的服务是当前用户的 LaunchAgent（`~/Library/LaunchAgents/io.github.leafiy.omp-web.plist`），不需要 sudo，日志在 `~/code/omp-web/.local/logs/omp-web.log`。

不装服务时手动启动，然后打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)：

```bash
cd ~/code/omp-web && node bin/omp-web.js --hostname 127.0.0.1 --port 30141
```

<details>
<summary>手动安装</summary>

```bash
mkdir -p ~/code
git clone https://github.com/leafiy/omp-web.git ~/code/omp-web
cd ~/code/omp-web
npm ci --include=dev
npm run build
npm run passwd   # 设置网页用户名和密码
npm start
```

</details>

本分支从源码运行，npm 上名为 `omp-web` 的包可能是其他上游版本。开发、构建和运行都只使用 `~/code/omp-web` 这一个目录，构建前先停止服务，详见[唯一工作区流程](./docs/workspace.zh-CN.md)。

## 登录与安全

- **必须登录**，没有免密模式。用 `npm run passwd`（或 `node bin/omp-web.js passwd`）设置或重置。凭据以加盐 scrypt 哈希保存在 `~/.config/omp-web/credentials.json`（权限 0600，可用 `OMP_WEB_AUTH_FILE` 改路径），与各 Agent 的登录无关。在**设置 → 网页账户**中可以修改密码或退出登录，修改后其他浏览器会全部下线。
- **默认只监听本机回环地址。** 远程访问请使用 HTTPS 反向代理或 Tailscale、EasyTier 等私有网络，不要以明文 HTTP 暴露到公网。
- **网页权限就是服务账户的权限。** Agent 和终端都以这个用户身份运行，终端不是沙箱，建议使用低权限账户。

## 边界

- 以各 Agent 的原生能力为准，网页支持范围因 Agent 而异；TUI 独有的功能请在终端里使用。
- 不迁移凭据，也不在 Agent 之间共享配置；网页历史和缓存只用于显示，不等于模型上下文。
- 重启网页服务会中断正在运行的 Agent 和终端。
- 远程访问不改变模型提供方的账号资格、服务地区和使用条款。

## 文档

- [自托管与终端](./docs/self-hosting.zh-CN.md) · [原生 Agent、认证与部署](./docs/native-host-deployment.zh-CN.md)
- [文件浏览器与上传](./docs/file-browser.zh-CN.md) · [Worktree](./docs/worktrees.zh-CN.md) · [长历史折叠与缓存](./docs/history-cache.zh-CN.md)
- [原生技能](./docs/native-skills.zh-CN.md) · [订阅用量](./docs/subscription-usage.zh-CN.md)
- [Claude Code 命令](./docs/claude-code-commands.zh-CN.md) · [引导与后续消息](./docs/claude-code-steering.zh-CN.md) · [Follow-up 队列与取回编辑](./docs/queued-message-editing.zh-CN.md) · [Codex CLI](./docs/codex-cli.zh-CN.md)

## 来源与致谢

本项目源自 [17380936778/omp-web](https://github.com/17380936778/omp-web)，上游基础是 [agegr/pi-web](https://github.com/agegr/pi-web)。感谢上游作者，也感谢 OMP、Pi、Claude Code、Codex 的维护者，网页里的 Agent 能力都来自这些工具。

## 许可证

[MIT](./LICENSE)，保留上游版权声明。
