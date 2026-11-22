# 唯一开发、发布与运行目录

本仓库只使用现有的唯一检出。宿主机路径为 **`~/code/omp-web`**（`192.168.52.3` 上是 **`/root/code/omp-web`**）；devbox/distrobox 环境中同一工作区暴露为 **`/root/2/devbox-distrobox/code/omp-web`**。按当前环境使用可访问的路径，不要求宿主路径在容器内存在，也不因此创建第二份检出。下文命令中的 `~/code/omp-web` 应替换为当前环境的对应路径；生产服务路径仍以宿主机为准。

## 目录约定

- 源码、Git 历史、依赖、构建和服务运行共用该检出；`node_modules/`、`.next/` 是目录内的真实目录。
- 不创建第二份 clone、worktree 或外置 staging/release/build 目录；不通过 `/opt` 别名继续开发或启动。
- `.local/` 已忽略提交，仅存放维护日志、状态文件、旧构建及不可直接运行的历史归档。它不是另一份活动源码。
- systemd 的 `WorkingDirectory`、`ExecStart` 直接指向本目录。`bin/omp-web.js` 和 npm 的 dev/build/start 入口检查物理目录；npm 入口还拒绝在生产服务运行时启动第二个实例或覆盖构建。检查是操作防错，不是对 root 用户的安全沙箱。
- `/etc/omp-web` 的访问密码/环境、`~/.claude`、`~/.pi`、`~/.omp`、`~/.codex` 及网页会话存储不搬入 Git 仓库；原生 Agent CLI 仍使用自己的安装位置。

## 日常更新

先审查、验证、提交本目录改动。部署前确认网页会话、后台任务及内嵌终端空闲；重启会中断它们。只在授权的维护窗口执行：

```sh
cd ~/code/omp-web
git status --short
# 有未提交改动时先处理，保持一个明确的部署提交。
git pull --ff-only

sudo systemctl stop omp-web.service
mkdir -p .local/rollback
backup=".local/rollback/$(date +%Y%m%d-%H%M%S).next"
if [ -d .next ]; then mv .next "$backup"; fi

# 只有 package-lock.json 变化且获准安装依赖时才运行 npm ci。
if npm run build; then
  sudo systemctl start omp-web.service
else
  # 留下失败产物便于诊断，不覆盖旧构建。
  if [ -d .next ]; then mv .next "${backup}.failed"; fi
  if [ -d "$backup" ]; then mv "$backup" .next; fi
  sudo systemctl start omp-web.service
  exit 1
fi
```

不需要保留旧构建时，`bash scripts/install.sh update` 一步完成拉取、按需安装依赖与构建、启动（Linux 用 systemd，macOS 用 launchd）；它不备份 `.next`，只删除 Turbopack 不再使用的 `.next/cache/webpack`，保留其余 `.next/cache`。更新采用本机成功记录来避免重复工作：

- 首次使用新流程没有记录，仍执行完整安装和构建；不根据已有目录猜测上一次是否成功。
- 依赖指纹包括 `package.json`、`package-lock.json`、Node/npm 版本、Node 路径、系统/架构、npm 有效配置和 `NODE_OPTIONS`。指纹匹配且已安装的直接依赖、必要命令及 npm 隐藏锁文件检查通过，才跳过 `npm ci`。
- 构建指纹包括依赖指纹、完整 Git 提交、`NEXT_*` / `NODE_*` / `npm_config_*` / `CI` 环境变量及四个生产构建相关 `.env*` 文件。构建记录还检查 `.next` 的必要文件和产物文件清单（大小与修改时间；忽略缓存、开发输出和诊断追踪）。完全匹配才跳过构建，不停止正在运行的服务。服务已停止时仍尝试启动。
- 成功记录分别存放在 `node_modules/.omp-web-install.json` 和 `.next/.omp-web-build.json`，只记录哈希，不保存配置或环境变量原文。安装/构建开始前删除旧记录，成功后原子保存新记录；失败、缺失、损坏的记录均不能用于跳过。
- `bash scripts/install.sh update --force-build` 强制重建；`--force-install` 强制重装依赖并重建。直接依赖检查不是整个 `node_modules` 的完整性审计；怀疑嵌套依赖损坏时使用 `--force-install`。未来若构建读取其他自定义环境变量或外部资源，应补入指纹，在此之前使用 `--force-build`。
- `bash scripts/install.sh restart` 只重启已安装的服务（systemd `restart`；launchd 先 bootout 再 bootstrap），不拉取、不装依赖、不构建，也不接受其他选项。缺少 `.next/.omp-web-build.json` 成功记录、systemd 仍有中断更新留下的启动保持，或从服务自身的终端/agent 中运行时拒绝执行。
- 日志显示安装、构建和整体更新的秒数，便于比较不同机器的实际瓶颈。不关闭类型检查。
- 生产构建使用 Turbopack（`next build --turbopack`，与 `next dev` 相同）。webpack 构建要在 JS 里再做一遍依赖文件追踪（`collect-build-traces`），曾占整次构建的六成以上；Turbopack 在编译时原生完成追踪。Turbopack 的构建文件缓存（`experimental.turbopackFileSystemCacheForBuild`）在 Next 16.2 仍是实验选项，未开启。
- `next.config.ts` 把 `outputFileTracingRoot`（Turbopack 下同时作为 `turbopack.root`）固定为本目录。不固定时，上级目录的锁文件（例如误生成的 `~/package-lock.json`）会让 Next 把家目录推断为工作区根，构建追踪随之遍历 `~/.claude`、`~/.codex`、`~/.omp` 等全部 Agent 数据：webpack 时曾实测约 1.4 万个文件、3.5 GB，追踪耗时占整次构建的约四分之三，且随会话增多变慢。分阶段耗时见 `.next/trace-build`；`.next/required-server-files.json` 中的 `config.outputFileTracingRoot` 应为本目录。

需要重建时仍先停服。重建期间脚本在 `/run/systemd/system/omp-web.service.d/` 放一个临时 drop-in，让 systemd 跳过所有启动请求（例如 `omp-web-tunnel.service` 的 `Wants=` 重启时顺带拉起），完成后删除；构建失败时保留它，服务保持停止，重启后 `/run` 清空也会解除。只跳过构建时，也仅在成功记录和产物验证通过后释放此前遗留的 hold。

源码级回归测试为 `node --test scripts/install-state.test.mjs`，使用临时文件与模拟产物，不安装依赖、不执行真实构建或启动服务；运行测试仍需本任务的单独授权。

检查服务、认证首页、静态资源及公网 HTTPS。若新构建健康检查失败，停止服务后在**同一目录**恢复备份 `.next` 再启动；不恢复外置运行副本。源码改动也应通过 Git 在本目录审查和处理，不用另一个 checkout 替代当前工作区。

当前对话由 `omp-web.service` 承载时，先把维护任务置于独立 systemd 单元，由它等待网页任务空闲后执行停服、**本目录内构建**、启动和检查。脚本及日志保存在 `.local/`。回复结束、任务排定、源码已提交都不等于部署已完成；必须读取任务状态及实际服务路径。

## 目录迁移验收

这次迁移的状态保存在 `.local/migration/status.json`，只有 `active` 表示构建、启动、路径和公网检查全部成功，旧目录已归档并移除。

验收项：

1. `git status --short` 为空，`git rev-parse --show-toplevel` 为当前环境下上述唯一工作区的对应路径。
2. `node_modules`、`.next` 不再链接到旧发布目录。
3. `systemctl show omp-web -p WorkingDirectory -p ExecStart` 使用新目录；主进程的 `/proc/<PID>/cwd` 为新目录。
4. 未登录首页 307 跳转 `/login`、未登录 API 为 401，登录后访问及静态资源为 200；`https://omp.leafiy.com` 可用。
5. `/opt/omp-web*` 不再保留活动目录或兼容入口；旧版本只存在于 `.local/archive/` 内的归档文件。

其他文档中的旧发布路径属于历史记录，以本页为当前唯一操作流程。
