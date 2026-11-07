# 设置里的软件更新

状态（2026-11-05）：用户已授权验证、打包和重启上线。82 项测试、类型检查、隔离生产构建、构建后 API 及桌面/390px 手机浏览器检查通过。所有更新均为模拟，没有实际升级 CLI、安装依赖或发送模型请求。发布结果以 `/opt/omp-web-settings-release-dh8GTLne/status.json` 为准：`active` 表示已上线，`rolled_back` 表示已恢复旧版。

## 怎么用

1. 点网页左下角 **设置**。
2. 找到要更新的软件，点它右边的 **更新**。
3. 看清[页面内确认卡片](./nonblocking-ui.zh-CN.md)，再点击“确认更新并重启”。不会弹出阻塞浏览器的确认窗口。完成后网页会重启。

四个按钮分别是 **Pi、OMP、Claude Code（CC）、Codex**。只更新点击的那个，不会顺带升级其他软件。

**更新前请先结束聊天任务、保存终端里的工作。网页重启会中断所有正在运行的任务。** 已保存的聊天记录不会被清空。失败不会自动重试。

想换聊天模型，请使用聊天输入框旁的模型菜单，不是这些更新按钮。Codex 按钮更新本机 Codex CLI；新增的 [Codex 网页聊天接入](./codex-cli.zh-CN.md) 也使用同一个程序；该接入的验证及发布状态见链接。

## 给维护者的信息

- 打开设置检查本地安装路径、包信息和已有更新状态。OMP 独立二进制没有可读的包版本，因此额外执行只读 `omp --version`：3 秒超时、16 KiB 输出限制，不使用 shell、不启动聊天、不查询远程版本、不执行安装。成功结果缓存 5 分钟，失败缓存 10 秒；并发请求复用同一次查询，所选可执行文件的路径/文件身份改变后重新查询。OMP 正在更新或重启时跳过版本探测。
- `GET /api/tools/update` 返回四项状态；`POST` 只接受 `{ "tool": "pi|omp|claude|codex", "confirm": true }`（tool 填其中一个值）。不接受客户端命令、路径或服务名。
- 新接口保留 Host、Origin、JSON 和网页密码校验。四种更新共用一个锁；旧 `/api/omp/update` 转到同一个协调器，且仍只更新 OMP。
- OMP 使用聊天配置的同一个可执行文件，调用 `omp update`，不更换更新通道。
- Pi 当前是全局 npm 安装：从实际可执行文件反查包、全局 prefix 和 bin，再更新 `@earendil-works/pi-coding-agent@latest`。不更新网页依赖内的旧 Pi SDK，不迁移到其他 npm 包。
- Codex 同样确认实际全局 npm 安装，再更新 `@openai/codex@latest`。默认使用 PATH 中的 `codex`，可由管理员用 `OMP_WEB_CODEX_EXECUTABLE` 指定；网页不接收这个路径。
- 两个 npm 更新都固定正确 prefix、保留 optional dependencies、跳过生命周期脚本。未识别的安装方式明确禁用，不另装一份并冒充更新成功。
- Claude Code 当前支持原生安装器管理的 `~/.local/bin/claude`，调用 `claude update`。专用 `CLAUDE_CONFIG_DIR` 沿用网页目录，不读取或复制终端登录。固定到某一版本的自定义 launcher 不支持网页更新。
- 开始更新前核对 systemd 控制组和 InvocationID。更新命令成功、同一个 launcher 的版本输出有效后才请求重启；只有新的网页服务实例才能报告成功。该检查不等于新版本的完整聊天兼容性验收。
- 更新状态沿用 `~/.local/state/omp-web/omp-update.json`（或 XDG_STATE_HOME），兼容旧 OMP 记录。轮询失败只重试 GET，绝不自动重发 POST；关闭设置不会停止已接受的更新。
- 不更新 omp-web、Claude Agent SDK 或本地 Codex 代理，不改订阅和模型，不删除登录或历史。实际安装仍由对应官方更新器/npm 完成，网页不承诺二进制自动回滚。

实现：`lib/tool-update*.ts`、`app/api/tools/update/route.ts`、`components/ToolUpdateControl.tsx`、`components/OmpNativeSettings.tsx`。

测试文件：`lib/tool-update.test.mjs`、`lib/tool-update-runner.test.mjs`。使用临时假安装、假子进程和 HTTP 假服务，覆盖四种更新、共享锁、版本校验、安装失败、服务身份错误、进程中断和请求安全；没有执行真实软件更新。流程模拟使用独立虚假 InvocationID，测试替身若失效也不能通过真实服务身份检查。

发布目录保存构建日志、测试结果、`api-result.json`、`browser-result.json` 和桌面/手机截图。浏览器的全部 API 请求被拦截；测试四个按钮、取消确认、全局忙碌、失败解锁、丢失 POST 后只重试 GET、关闭重开、成功后仅刷新一次和中英文标签。预览服务另外移除 InvocationID，防止误触真实安装。

构建 ID：`gyAKC6RN2Q77FwUBtLrMh`。只替换生产 `.next`，不改依赖、四个 CLI 或已有代理配置；旧构建保留在发布目录的 `backup.next`。切换期间持有软件更新锁，防止同时启动安装。健康检查失败自动恢复旧构建，实际结果写入上述状态文件。

## OMP 版本显示修正

用户发现只有 OMP 显示“OMP 聊天工具”而没有版本号。原因是原来的 OMP 安装检测只返回了可执行文件，没有填充 `installedVersion`，界面便使用了备用说明文字。

已新增缓存的只读版本查询，实测本机为 **18.16.0**。新旧状态接口都返回版本；界面优先显示本次检测的安装版本，避免旧更新记录覆盖它。查询失败明确显示“版本读取失败”，不冒用历史版本，也不泄漏原始命令输出。

105 项测试、类型检查、隔离构建及桌面/390px 手机浏览器检查通过。预览中新旧接口与多次开关设置合计只执行了一次真实 `--version`；没有执行更新命令、安装依赖、启动模型会话或请求模型。相关实现和测试见 `lib/omp-version.ts`、`lib/omp-version.test.mjs`。

本次构建 `uneDzdJLBVayGPG0ld9Jk`，发布目录 `/opt/omp-web-version-release-XVlS7iWZ`。只切换 `.next` 并重启网页，旧构建保留为 `backup.next`；`status.json` 中的 `active` / `rolled_back` 记录实际发布结果，不能将构建成功视为已上线。

依据：

- [Pi 安装说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)
- [Claude Code 手动更新](https://code.claude.com/docs/en/setup#update-manually)
- [Codex 官方安装说明](https://github.com/openai/codex#installing-and-running-codex-cli)
- OMP 官方更新命令依据见 [本地引擎记录](./native-omp.zh-CN.md)。
