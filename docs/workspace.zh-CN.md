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

不需要保留旧构建时，`bash scripts/install.sh update` 一步完成拉取、停服、`npm ci`、构建和启动（Linux 用 systemd，macOS 用 launchd）；它不备份 `.next`。重建期间脚本在 `/run/systemd/system/omp-web.service.d/` 放一个临时 drop-in，让 systemd 跳过所有启动请求（例如 `omp-web-tunnel.service` 的 `Wants=` 重启时顺带拉起），完成后删除；构建失败时保留它，服务保持停止，重启后 `/run` 清空也会解除。

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
