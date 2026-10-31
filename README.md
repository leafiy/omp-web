# omp-web — Leafiy 自托管版

基于 [17380936778/omp-web](https://github.com/17380936778/omp-web) 的私有自托管版本，保留本机模型兼容修复，并新增页面底部的交互式终端。终端可在 AI 工作期间独立使用，无需额外开放端口。

**[自托管与终端使用说明](./docs/self-hosting.zh-CN.md)** · [English（上游说明）](./README.en.md)

[Oh My Pi](https://github.com/badlogic/pi-mono) 编程智能体的浏览器界面——基于 [pi-web](https://github.com/agegr/pi-web) Fork 并改造，专门适配 Oh My Pi（omp）工作流。

> **来源说明**：本项目 Fork 自 [agegr/pi-web](https://github.com/agegr/pi-web)。核心架构、会话浏览、实时对话、文件预览均来自 pi-web 原作者的工作。本仓库的改动专注于与 Oh My Pi 环境的兼容性和工作流优化。

![omp-web 界面展示：结构化 Markdown、工具调用与项目导航](./docs/Untitled%20blend-4096x4096.png)

## 什么是 Oh My Pi？

Oh My Pi（omp）是构建在 pi 编程智能体之上的 coding harness，在 pi 核心能力之上添加了结构化智能体会话、技能管理、worktree 协调和更丰富的工具协议。`omp-web` 将 omp 的会话格式呈现在浏览器中：pi 写入的同一批 `.jsonl` 文件，由本地运行的 Next.js 服务器读取并渲染。

## 快速开始

Pi Web 要求 Node.js 22.19.0 或更高版本。可通过 `node --version` 检查当前版本。

**从源码运行（Git Clone）：**

```bash
git clone https://github.com/leafiy/omp-web.git
cd omp-web
npm ci --include=dev
npm run dev      # 启动开发服务器（端口 30141）
# 或构建后运行生产模式：
npm run build
npm start
```

启动后打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。服务就绪后会尝试自动打开浏览器。omp-web 默认仅监听 `127.0.0.1`。

**可选参数：**

```bash
omp-web --port 8080              # 自定义端口
omp-web --hostname 0.0.0.0       # 在可信网络中开放访问
omp-web -p 8080 -H 0.0.0.0       # 组合使用
omp-web --no-open                # 不自动打开浏览器

PORT=8080 omp-web                # 也支持环境变量
OMP_WEB_HOSTNAME=0.0.0.0 omp-web  # 显式开放网络访问
OMP_WEB_NO_OPEN=1 omp-web         # 适用于后台服务或开机自启
```

设置 `PI_WEB_PASSWORD` 可启用 HTTP Basic Auth（用户名 `pi`），未设置时没有登录保护。网页终端和智能体都拥有服务账户权限；Basic Auth 不加密传输，远程访问应配合 HTTPS 或可信 VPN，切勿将无认证服务暴露到公网。终端可通过 `OMP_WEB_TERMINAL=0` 禁用。

### 本机部署（端口 2225）

- 安装目录：`/opt/omp-web`，生产模式运行。
- 服务：`omp-web.service`，已启用容器启动自启和异常退出重启。
- 监听：`0.0.0.0:2225`；主机名访问 `http://pc:2225`，本机访问 `http://127.0.0.1:2225`，局域网 IP 访问 `http://192.168.52.22:2225`。
- 服务通过 `PI_WEB_ALLOWED_HOSTS=pc` 放行主机名。监听所有网卡并不会自动信任所有域名；新增访问域名时应更新此变量（多个主机名用逗号分隔）并重新加载、重启服务。未关闭其他 Host 和跨站请求检查。
- 运行身份：Distrobox 容器内 `root`，未额外配置 systemd 沙箱；不改变容器原有隔离边界。
- 数据目录：`/root/2/devbox-distrobox/.omp/agent`，复用现有模型凭据和会话。
- 按本机部署要求未设置 `PI_WEB_PASSWORD`；`trust.json` 中的 `"/": true` 信任所有目录的项目资源。新会话的工具默认值在 `hooks/useAgentSession.ts` 中设为 `full`；上游更新时需要保留此本地改动。
- 此配置允许网络访问者以服务账户权限运行命令、读写文件，也允许项目扩展执行代码。仅限可信网络，不要直接暴露到公网。

在容器内管理服务：

```bash
systemctl status omp-web
journalctl -u omp-web -n 100 --no-pager
systemctl restart omp-web
systemctl stop omp-web
```

初次部署已检查生产构建、systemd 启用与运行状态、回环及局域网地址的 HTTP 响应、模型列表和浏览器新会话界面（默认 `full`）。修复主机名访问后，已检查 `http://pc:2225/` 及同源 API 返回 HTTP 200，未放行的主机名和跨站 API 请求仍返回 HTTP 403。

#### 本机模型与订阅兼容修复

- `lib/omp-models.ts` 将缓存模型中的 `provider` 作为运行时提供商 ID，不把 `openai-codex:0.159.0` 等带版本的缓存键当作提供商。自定义模型配置仍覆盖缓存元数据。
- 缓存中 `baseUrl` 为空的目录占位模型，不作为可调用的自定义模型导出；用户配置了提供商或模型端点后才导出，并继承该端点。不为 Azure 等服务编造默认端点，也不修改原始模型数据库。
- OMP 数据库中的 API Key 可以导入运行时；OAuth 访问令牌不再作为 API Key 注入。ChatGPT 订阅使用网页版 `auth.json` 中的 OAuth 登录，保留账户信息和 SDK 的令牌刷新机制，不覆盖已登录账号。
- 模型列表根据 SDK 运行时的认证状态识别网页版订阅，而不是只看 OMP 数据库。ChatGPT 订阅模型属于 `openai-codex`，不是 API Key 提供商 `openai`。
- 模型配置页的测试接口与会话共用凭据适配逻辑。上游更新时需保留这些本地修复。

回归检查：

```bash
node --test lib/omp-models.test.mjs lib/models-api.test.mjs lib/model-role-filter.test.mjs lib/models-cache.test.mjs
```

本次模型修复通过 13 项检查、生产构建、部署后的模型接口与浏览器模型选择检查。经用户授权，使用现有订阅向 `openai-codex/gpt-6-astra` 发送了一次最小请求，成功收到 `OK`；页面不再显示模型配置错误。

## HTTP 代理

omp-web 的服务端模型请求和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx omp-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx omp-web@latest
```

## 特色与增强功能

- **独立代码块语法主题选择器**：新增多主题代码渲染支持，内置 **One Dark Pro**、VS Code Dark+、VS Code Light 等高亮主题，用户可自由切换代码视觉风格。
- **Oh My Pi (OMP) 生态深度集成**：完全适配 `~/.omp/agent/` 目录结构（`models.json`、`models.db`、`config.yml`、`agent.db` 等），自动识别并映射 OMP 专属的模型角色 (如 `defaultModel`, `smallModel` 等) 及 SQLite 凭据。
- **全界面中文与双语本地化**：提供全面中文化的 UI 交互体验，优化 CJK 排版、字体与搜索体验。
- **按项目找回历史对话**：打开网页即可按项目检索以前的 omp 会话，不必在终端里翻文件或记住会话路径。
- **放心探索不同方向**：从任意历史消息重新开始，或将会话 Fork 成独立路线，不会影响原来的对话。
- **侧边栏切换 Git worktree**：Explorer 和新会话跟随你所选的 checkout。
- **边聊边看项目文件**：左侧浏览文件，右侧预览源码、文档、图片、音频和 PDF，智能体工作时同步检查。
- **随时掌握会话状态**：顶部栏始终显示上下文占用、费用、压缩状态和系统提示，长会话不再是黑箱。
- **在界面内完成所有配置**：模型、登录/API key、模型测试、技能开关，无需离开浏览器。

## 注意事项

- **数据目录**：默认读取 `~/.omp/agent/sessions`。可通过环境变量 `OMP_CODING_AGENT_DIR` 指定其他 omp agent 目录（兼容旧版：同样支持 `PI_CODING_AGENT_DIR`，优先级低于前者）。
- **会话文件**：路径形如 `~/.omp/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。
- **模型配置**：Models 面板读写 omp agent 目录下的 `models.json`，模型列表和默认值来自 omp 的配置。
- **文件访问**：文件浏览和预览面向当前选择的项目目录，以及会话中已出现过的工作目录。
- **Git worktree**：切换器何时出现、新 worktree 在哪里创建、删除会影响什么，见 [omp-web 里的 Worktree](./docs/worktrees.zh-CN.md)。
- **Fork 与会话内分支不同**：Fork 会创建新的 `.jsonl` 文件；"Edit from here" 是同一会话文件里的分支。
- **Skills API**：`SKILLS_API_URL` 可覆盖默认的 `https://skills.sh` 接口地址，用于技能搜索和安装。
- **GitHub token**：设置 `GITHUB_TOKEN` 或 `GH_TOKEN` 可提升技能更新检查器的 GitHub API 速率限制（可选；不设置时仍可请求，但可能触发 rate limit）。
- **环境要求**：需要 Node.js >= 18.3.0。运行环境需安装 Git 并确保系统 `PATH` 中可调起 `git` 命令（用于 Git Worktree 和仓库浏览功能）。

## 与 pi-web 的关系

omp-web 直接 Fork 自 [pi-web](https://github.com/agegr/pi-web)，下表列出了针对 Oh My Pi (omp) 生态与用户体验所做的主要增强与改动：

| 改动点 | 说明 |
|---|---|
| 包名与二进制 | 改为 `omp-web`，原为 `pi-web` |
| 代码语法主题选择器 | **新增** 独立代码块主题选择器，支持 **One Dark Pro** 等主流主题切换 |
| OMP 数据库与角色适配 | **新增** 对 `~/.omp/agent/` 下 `models.db`、`config.yml` 角色模型及 SQLite API Key 的读取与映射 |
| 中文与国际化体验 | **增强** 完整双语界面与中文本地化交互优化 |
| pi SDK 依赖 | 跟踪 omp 使用的 `@earendil-works/pi-*` 最新系列包 |
| 会话与路径兼容性 | 适配 omp 会话格式、工具协议及 `~/.omp/agent/` 数据目录 |
| 默认端口 | 30141（与 omp 开发约定一致） |

其余内容——会话读取、AgentSession 生命周期、SSE 流式传输、Fork/分支逻辑、文件访问、worktree 管理——均继承自 pi-web，详见 [AGENTS.md](./AGENTS.md)。

## 开发

```bash
npm install
npm run dev
```

本地开发端口为 [http://127.0.0.1:30141](http://127.0.0.1:30141)。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

开发时不要运行 `next build` / `npm run build`，它会写入 `.next/` 并影响正在运行的 dev server。发布流程再执行构建。

## 项目结构

```text
app/
  api/
    agent/          # 创建/驱动 AgentSession，提供 SSE 事件流
    auth/           # OAuth 和 API key 管理
    cwd/browse/     # 服务端目录浏览
    cwd/validate/   # 自定义工作目录校验
    default-cwd/    # 获取 pi 默认工作目录
    files/          # 文件列表、读取、预览、watch
    home/           # 当前用户 home 目录
    models/         # 可用模型、默认模型、thinking levels
    models-config/  # 读写 models.json、测试模型
    sessions/       # 会话读取、重命名、删除、上下文、HTML 导出
    skills/         # skills 列表、搜索、安装、启停
components/
  AppShell.tsx        # 主布局、URL 状态、顶部面板、文件标签
  SessionSidebar.tsx  # 项目选择、会话树、Explorer
  DirectoryPicker.tsx # 支持浏览和路径输入的工作目录选择器
  ChatWindow.tsx      # 消息区、SSE、拖拽图片、minimap
  ChatInput.tsx       # 输入栏、模型/工具/thinking/compact/slash controls
  MessageView.tsx     # 消息、thinking、tool call/result 渲染
  ModelsConfig.tsx    # 模型和认证配置面板
  SkillsConfig.tsx    # 技能管理面板
  FileExplorer.tsx    # 文件树
  FileViewer.tsx      # 源码、diff、图片、音频、PDF、DOCX 预览
lib/
  directory-browser.ts # 目录规范化和安全枚举工具
  http-dispatcher.ts  # 服务端 fetch 的 HTTP(S) 代理配置
  rpc-manager.ts      # AgentSessionWrapper 生命周期和全局 registry
  session-reader.ts   # 解析 .jsonl 会话文件和分支上下文
  normalize.ts        # 规范化 toolCall 字段名
  file-access.ts      # 文件读取安全边界
  file-paths.ts       # 文件路径编码/相对路径工具
  markdown.ts         # Markdown/Mermaid/KaTeX 插件配置
  pi-types.ts         # pi 相关类型
hooks/
  useAgentSession.ts  # 会话加载、发送命令、SSE 状态机
  useAudio.ts         # 完成提示音
  useDragDrop.ts      # 图片拖拽
  useTheme.ts         # 主题切换
bin/
  omp-web.js          # npm CLI 入口
instrumentation.ts    # 初始化服务端 HTTP dispatcher
```

## 致谢

本项目基于 [pi-web](https://github.com/agegr/pi-web) 及 `@earendil-works/pi-*` 生态二次开发与增强。感谢 `pi-web` 原作者及 Oh My Pi 团队提供的优秀开源基石！

## 开源协议

MIT——与上游 [pi-web](https://github.com/agegr/pi-web) 项目保持一致。
