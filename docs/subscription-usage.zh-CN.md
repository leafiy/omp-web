# 订阅用量

左下角的 **插件** 已改为 **用量**，与“设置”分开。无需先选项目即可打开。

## 显示什么

- **Claude Code**：原生 `/usage` 控制接口返回的周额度、重置时间、套餐。
- **Codex**：原生 app-server 返回的周额度、重置时间、套餐和账号累计 Token。
- **当前会话**：已打开且空闲的 OMP/Pi 会话，可另外读取原生会话 Token 统计，并明确标注“本会话”。Claude Code 和 Codex 会话不显示单独的“当前会话”卡片，只显示上面的订阅卡片。
- **Token 统计**：最上方的表格，按浏览器本地时间列出今日、本周（周一起）、本月的 Token，每行标注“账号”或“本机”。悬停数字可看完整值；本机行还会显示输入、输出、缓存读、缓存写。

不把未提供的数据显示成 0，不从百分比反推 Token，也不把新建的空查询会话当作账号累计用量。周额度按服务商窗口重置，不一定是自然周；短周期限流仍可能影响实际可用性。

**Claude 的接口没有提供账户累计 Token，面板因此显示“未提供”。OMP/Pi 的 RPC 没有订阅周额度查询，网页不会读取其认证文件或借用 CC/Codex 的账号来补数。**

## 数据来源与边界

- CC 使用已安装的官方 CLI，通过 Agent SDK 的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` 读取。此接口是实验性的；这次调用不扫描历史，也不发送用户提示。日/周/月 Token 另见下节。
- Codex 只调用 `initialize`、`account/read`、`account/rateLimits/read`、`account/usage/read` 等原生元数据接口，不创建 thread/turn，不抽取 token 后自己请求上游。
- 只取展示所需的套餐、额度和计数，不返回邮箱、账号 ID、原始错误或凭据。
- 统计只有短暂内存缓存，通常约 60 秒；并发读取复用同一次请求，手动刷新最少间隔 5 秒。无效会话 ID 不会制造更多原生查询。
- HTTP 必须通过同一网页访问密码、Host/Origin 校验，响应 `Cache-Control: no-store`。
- 账号总 Token 与本机会话 Token 不混算；大整数用十进制字符串展示，已失去精度的数值视为未知。

## 日/周/月 Token

`/usage`（`/stats`、`/cost` 是它的别名）只返回额度百分比、当前会话用量，以及最近 24 小时/7 天的请求数和会话数，没有按日/周/月的 Token 总数。OMP/Pi RPC 也只能查单个会话。因此：

- **Codex（账号）**：`account/usage/read` 的 `dailyUsageBuckets`（`{ startDate, tokens }`），是服务端返回的账号级每日数据，含其他设备。日期按 Codex 自己的日期直接和浏览器本地日期比较。若最早一天晚于所需的周/月起点，表格标“自 MM-DD”，不假装覆盖了整个月。任何一天的数据格式不对，整行显示“未提供”。
- **Claude Code / OMP / Pi（本机）**：把这台机器原生会话记录里每条回复自带的 usage 加起来，含终端里跑的会话和子代理记录，不含其他设备和 claude.ai 网页。来源目录：`$CLAUDE_CONFIG_DIR/projects`（默认 `~/.claude/projects`）、OMP 和 Pi 各自 agent 目录下的 `sessions`。不扫描网页自己的 Claude/Codex 投影目录，避免重复计数。
  - 总数 = 输入 + 输出 + 缓存读 + 缓存写，与 ccusage 的总 Token 口径一致。
  - 去重：CC 按 `message.id + requestId`（同一回复按内容块写多行，usage 相同）；OMP/Pi 按条目 ID + 时间戳（分支/fork 复制的条目保留二者）。
  - 增量：每个文件记住已读到的字节位置，只读新增部分；还没写完的最后一行下次整行再读。文件变短或前缀长度变化时从头重读，靠去重键避免重复。删掉的会话文件，其用量仍保留。
  - 持久化汇总：`$OMP_WEB_USAGE_STATE_DIR/local-tokens.json`（默认 `~/.local/state/omp-web/usage/`，权限 600）。只存 15 分钟粒度的合计、哈希后的去重键和文件读取位置，不存会话内容。只保留最近 40 天。
  - 刷新：服务进程里第一次打开面板时启动后台定时器，之后每 5 分钟增量汇总一次；打开或轮询面板时若距上次超过 60 秒也会刷新，手动刷新最少间隔 5 秒。请求最多等 3 秒；首次全量扫描未完成时显示“统计中…”，面板 3 秒后自动再取。
- 账号级和本机数据不相加，表格因此没有合计行。

实现：`components/SubscriptionUsage.tsx`、`app/api/usage/route.ts`、`lib/subscription-usage.ts`、`lib/usage-normalize.ts`、`lib/local-token-usage.ts`。

## 验证与远端发布

130 项相关测试、类型检查、隔离构建，以及桌面/390px 手机模拟浏览器检查通过。远端原生查询实测：CC 提供 2 个周额度窗口，Codex 提供 1 个周额度窗口及账号累计 Token。未把实际账号额度数字或登录凭据写入此文档。

当前发布：`/opt/omp-web-releases/20261105-usage-jdyq8M5i`，构建 `TK1xHSEtmLwGhNeGvVF_q`；远端 `status.json` 已记录 `active`。上一版保留在 `/opt/omp-web-releases/20261105-native-host-cYZladu2`。访问密码没有变化，原生 Agent 配置和登录未迁移，没有发送模型提示。

官方协议依据：[Codex 0.166.0 类型](https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs/app-server-protocol/schema/typescript/v2)、已安装 Claude Agent SDK 0.3.318 的使用量接口声明。
