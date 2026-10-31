# Leafiy 的 omp-web 自托管版

仓库：`https://github.com/leafiy/omp-web`（私有，需要 GitHub 访问权限）。

本版本基于 `17380936778/omp-web`，保留上游 Git 历史、MIT 许可证和原作者信息。`package.json` 标记为 `private`，不发布到公共 npm。主分支包含原有本机模型/OAuth 兼容修复和内嵌终端功能。

## 页面内终端

1. 选择项目或任务。
2. 点击聊天区底部的 **终端**，在当前任务的工作目录启动 Shell。
3. 上边缘可拖动调整高度；也可聚焦分隔线后使用上下方向键，按 Enter 恢复默认高度。
4. 点击终端标题收起面板；**不会终止进程**。AI 工作期间也能正常输入命令。
5. 点击右侧 **×（终止终端）** 并确认，关闭终端。之后再点击标题可启动新的 Shell。执行 `exit` 后也使用此方式重新开始。

支持 PTY 交互、Tab 补全、Ctrl+C、ANSI 颜色、窗口尺寸变化和终端程序（例如 vim）。终端按浏览器会话和初始工作目录关联；同目录的任务共用该浏览器会话的终端。切换到其他目录不会向旧 Shell 自动发送 `cd`。标题显示的是**初始目录**，而非 Shell 内执行 `cd` 后的实时目录。

- 终端与 AgentSession 独立，输入和输出**不写入 AI 对话**。需要 AI 分析时，手动复制相关输出，不要粘贴凭据。
- 刷新页面或切换目录后，再次展开会尝试重新连接。浏览器存储被禁用时无法跨页面找回终端；复制浏览器标签页可能共享原有终端 ID。
- 无连接的终端保留 **30 分钟**，随后关闭。收起面板仍保留连接，因此不会因收起而超时。
- 每个服务进程最多 **8 个终端**。达到上限时，返回其他目录终止不用的终端，或等待无连接终端过期。
- 保留最近约 **256 Ki 个 UTF-16 代码单元 / 最多 4096 帧**的输出用于重连，旧输出会被丢弃。不是完整终端日志或精确的全屏程序快照；全屏程序重连后可能需要自行重绘。
- 服务重启后终端注册表和回放缓冲区不保留。长时间任务可自行在终端内使用 `tmux`；本功能不保证进程跨服务重启存活。
- 网络中断期间不接受输入，不自动重试命令。若发送中途断线，已执行的部分无法回滚，请检查 Shell 状态后再继续。
- “终止终端”和超时回收关闭 PTY；已脱离终端的后台进程不保证被终止。

## 安全边界

终端是完整 Shell，拥有 **omp-web 服务账户的权限**，不是沙箱。工作目录白名单只限制启动位置，并不限制 Shell 随后的文件访问或命令执行。即使 AI 工具被禁用，手动终端仍可执行命令。

建议使用专用低权限账户、容器和可信 VPN/HTTPS。不要把 root 账户下的无认证服务暴露到公网。**当前本机的免密码和 root 配置未在本次开发中改变。**

| 环境变量 | 用途 |
| --- | --- |
| `PI_WEB_PASSWORD` | 启用现有 Basic Auth，用户名固定为 `pi`；未设置时无密码保护 |
| `PI_WEB_ALLOWED_HOSTS` | 允许的额外访问主机名，逗号分隔 |
| `OMP_WEB_TERMINAL=0` | 禁用所有终端 API；默认启用 |
| `SHELL` | Linux/macOS 下使用的 Shell 绝对路径，未设置时使用 `/bin/bash` |

所有终端端点，包括 `/events`，都独立校验 Host、跨站请求和配置的 Basic Auth。终端只使用现有同源 HTTP 端口，通过 SSE 接收输出、POST 发送输入，不需要额外端口或 WebSocket 代理。

反向代理需关闭终端事件流的缓冲，允许长连接。应用发送 `X-Accel-Buffering: no` 和心跳。Basic Auth 密码不得写入仓库；在服务管理器或受保护的环境文件中配置。子 Shell 不继承 `PI_WEB_PASSWORD`，但这不是对同账户程序的安全隔离。

## 从源码自托管

要求 Node.js **22.19.0+**、npm、Git，以及可用的 Shell。当前已验证的 PTY 运行环境为 Linux x64；其他平台需自行验证。PTY 使用固定版本的 `@lydell/node-pty`（node-pty 的预编译分发），避免在支持的平台上本地编译 PTY 模块。

以下是**手动部署步骤**，不是本次开发已执行的操作：

```bash
# 首次取得私有仓库；也可以使用已配置的 HTTPS 凭据
git clone git@github.com:leafiy/omp-web.git
cd omp-web

# 包括构建需要的开发依赖；以 package-lock.json 为准
npm ci --include=dev

# 在独立发布目录中构建，不要覆盖正在运行的 dev server 的 .next
npm run build

# 默认仅监听回环地址；配置认证后再按需开放网络访问
node bin/omp-web.js --hostname 127.0.0.1 --port 2225 --no-open
```

不要在生产目录直接执行不经审查的 `git pull` / `npm install` / 构建。建议使用独立发布目录，备份会话与配置，审查依赖和差异，完成验证后再由操作者切换服务。此仓库不包含模型凭据、用户会话、`.env` 或 systemd 密码配置。

## 开发检查

GitHub Actions 仅提供手动触发的检查，不因 push 自动运行，也不自动发布或部署。

```bash
npm ci --include=dev
npx tsc --noEmit --incremental false
npm run test:terminal
npx eslint components/TerminalPanel.tsx components/TerminalViewport.tsx \
  lib/terminal-*.ts lib/terminal-*.test.mjs app/api/terminal/
```

终端测试覆盖认证/跨站限制、路径与符号链接校验、请求大小限制、幂等创建、输入/尺寸变化、重连回放、缓冲上限、断开回收、显式终止，以及真实 Bash PTY 的颜色输出、工作目录、`stty size`、Ctrl+C 和退出码。不调用模型、不启动 Next.js 服务，不做生产构建。

## 接入位置

- `components/TerminalPanel.tsx`：底部面板、拖拽高度、展开/终止、目录关联。
- `components/TerminalViewport.tsx`：按需加载的 xterm.js、键盘输入、输出渲染和连接生命周期。
- `app/api/terminal/`：创建、输入、resize、终止和 SSE 输出。
- `lib/terminal-manager.ts`：PTY 生命周期、数量限制、超时回收、有限回放缓冲；全局注册表跨开发热重载保留。
- `lib/terminal-http.ts`：所有端点共享的认证/请求校验。
- `lib/terminal-stream.ts`：有界 SSE 输出和断开清理。

更新上游时保留终端端点内的校验：现有 `proxy.ts` 会跳过 `/events` 路径，不能仅依赖代理中间件保护事件流。
