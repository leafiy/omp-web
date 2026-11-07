# omp-web

**一个网页入口，使用本机的多个编程 Agent。**

[English](./README.md) · [简体中文](./README.zh-CN.md)

在同一个浏览器工作区使用 **OMP、Pi、Claude Code 和 Codex CLI**，旁边就是终端和文件管理器。

真正干活的是你的 Agent，网页只是让它们更方便使用。

不必为了日常使用来回切换多个终端、反复 SSH 重连，或为了另一套聊天前端重新折腾配置。打开一个链接，选择项目和 Agent，就可以开始工作——电脑、手机都能用。

## 使用现有 Agent，而不是再造一套 Agent

omp-web 是操作本机已有 Agent 的便捷入口，**不是新的 Agent、模型网关或独立 AI 工具系统**。

- **AI 对话和编程工具由选中的本地 Agent 提供。** 模型调用、工具执行、技能、项目指令和权限决定都属于对应 Agent。
- **沿用 Agent 自己的配置。** 每个 CLI 自行加载自己的设置和登录，不需要为了网页再配一套提供方设置，或把 API Key 复制到另一份网页配置中。
- **网页负责辅助操作。** 选择 Agent、管理会话、查看流式输出、回答已支持的权限请求、浏览文件，以及随时打开 Shell。
- **不同 Agent 保持独立。** 切换 Agent 会使用该 Agent 开始新对话，不会把原会话转换成另一个引擎，也不会在工具之间共享凭据。

```text
你的浏览器——电脑或手机
              │
              ▼
    工作站或服务器上的 omp-web
              │
              ├── OMP
              ├── Pi
              ├── Claude Code
              ├── Codex CLI
              │
              ├── 内置终端
              └── 文件管理与预览
```

“本地”指 Agent 安装并运行在 **omp-web 所在的机器**，不一定是打开浏览器的设备。模型仍可按各 Agent 的配置使用云端提供方，并不意味着必须本地运行模型。

## 网页带来的便利

| 功能 | 用来做什么 |
| --- | --- |
| **统一入口** | 在本机已安装的 OMP、Pi、Claude Code、Codex CLI 之间选择，不必分别维护一套网页前端。 |
| **按项目组织会话** | 找回之前的工作，在易读的界面里查看流式回复和工具执行过程。 |
| **原生能力入口** | 展示所选 Agent 提供的模型、命令、技能、审批、上下文和用量信息；具体支持情况因 Agent 而异。 |
| **内置终端** | Agent 工作时也能独立运行命令。终端输入不写入 AI 对话，复用同一个网页连接，不用再部署终端服务或额外开放端口。 |
| **文件管理** | 浏览、预览项目文件，上传到当前激活目录，并支持复制、剪切、粘贴、移动、重命名、新建、下载和确认删除。 |
| **舒适的浏览体验** | 电脑与手机布局、中英文界面、历史分页和有界内存缓存，让长对话切换更轻量。 |

内置终端是为了在需要 Shell 时随手使用，而不是要求每段对话都开一个终端窗口。文件管理器同样只是操作项目的便利工具，不替代 Agent 自己的原生工具。

## 开始使用

### 1. 准备本地 Agent

按各工具自己的安装和登录流程，准备好至少一个 Agent：

| Agent | 本机命令 |
| --- | --- |
| Oh My Pi | `omp` |
| Pi | `pi` |
| Claude Code | `claude` |
| Codex CLI | `codex` |

使用已经配置好这些 Agent 的系统账户运行 omp-web。网页服务会发现已安装的可执行文件；打开网页的手机或另一台电脑不需要安装这些 CLI。

同时需要 **Node.js 22.19.0+**、npm 和 Git。当前验证的部署平台为 Linux；文件复制、移动、删除等修改操作目前要求 Linux。

### 2. 启动网页

在新的源码目录中执行：

```bash
git clone https://github.com/leafiy/omp-web.git
cd omp-web
npm ci --include=dev
npm run build
npm start
```

打开 **[http://127.0.0.1:30141](http://127.0.0.1:30141)**，选择项目和已安装的 Agent，即可开始对话。

本分支从源码运行。npm 上名为 `omp-web` 的包可能对应其他上游版本，不等于本仓库。

开发时使用 `npm run dev`，无需先构建生产版本。发布构建应在独立源码或发布目录中进行，不要覆盖运行中实例的 `.next`。

### 3. 从其他设备安全访问

默认只监听本机回环地址。在开放远程访问之前：

1. 创建由服务账户独占的密码文件，权限设为 **0600**，文件中存放单行网页访问密码。
2. 启动时强制启用认证：

   ```bash
   OMP_WEB_REQUIRE_PASSWORD=1 \
   PI_WEB_PASSWORD_FILE=/absolute/path/to/web-password \
   node bin/omp-web.js --hostname 127.0.0.1 --port 30141 --no-open
   ```

3. 使用 **HTTPS 反向代理**或**可信 VPN**。直接通过 VPN 访问时，绑定机器的私有 VPN 地址，不要使用公网通配监听；使用自定义域名时配置 `PI_WEB_ALLOWED_HOSTS`。

网页登录用户名固定为 **`pi`**。这个密码只保护网页，与各 Agent 自己的登录互不混用。

**请把网页访问权限当作开发机器的访问权限。** Agent 和终端具有服务账户的权限；终端不是沙箱，Basic Auth 也不会加密 HTTP 流量。建议使用低权限账户，绝不要把未认证的服务直接暴露到公网。

## 几个重要边界

- **以原生行为为准。** 不同 Agent 的网页支持范围不同，不保证所有 CLI/TUI 功能或已在其他终端运行的会话都可直接接入。仅 CLI 支持的操作仍可在终端中完成。
- **不迁移凭据。** 在另一台机器部署 omp-web，不会复制原机器的 Agent 登录、模型配置或原生历史。
- **显示不等于模型上下文。** 网页历史视图与缓存用于方便浏览，不替代原生 Agent 管理的上下文。
- **网页不等于进程保活服务。** 重启网页服务可能中断活动 Agent 和内嵌终端，不承诺任务跨服务重启持续运行。

## 进一步了解

- [自托管与终端使用](./docs/self-hosting.zh-CN.md)
- [原生 Agent、访问认证与部署](./docs/native-host-deployment.zh-CN.md)
- [文件浏览器与上传](./docs/file-browser.zh-CN.md)
- [历史分页与显示缓存](./docs/history-cache.zh-CN.md)
- [原生技能](./docs/native-skills.zh-CN.md) · [订阅用量](./docs/subscription-usage.zh-CN.md)
- [Claude Code 命令](./docs/claude-code-commands.zh-CN.md) · [引导与后续消息](./docs/claude-code-steering.zh-CN.md) · [待处理消息取回编辑](./docs/queued-message-editing.zh-CN.md)
- [Codex CLI](./docs/codex-cli.zh-CN.md)

## 项目来源与致谢

本项目源自 **[17380936778/omp-web](https://github.com/17380936778/omp-web)**，其上游基础来自 **[agegr/pi-web](https://github.com/agegr/pi-web)**。

感谢上游作者提供的浏览器工作区、会话浏览与文件预览基础。本分支在此基础上扩展为多个本地 Agent 的统一入口，并加入内置终端和文件管理工作流。

也感谢 OMP、Pi、Claude Code、Codex 的维护者：网页中的 Agent 能力来自这些工具，而不是网页重新实现的另一套系统。

## 许可证

[MIT](./LICENSE)，保留上游版权声明。
