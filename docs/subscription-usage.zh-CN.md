# 订阅用量

左下角的 **插件** 已改为 **用量**，与“设置”分开。无需先选项目即可打开。

## 显示什么

- **Claude Code**：原生 `/usage` 控制接口返回的周额度、重置时间、套餐。
- **Codex**：原生 app-server 返回的周额度、重置时间、套餐和账号累计 Token。
- **当前会话**：已打开且空闲的 OMP/Pi/Claude 会话，可另外读取原生会话 Token 统计，并明确标注“本会话”。

不把未提供的数据显示成 0，不从百分比反推 Token，也不把新建的空查询会话当作账号累计用量。周额度按服务商窗口重置，不一定是自然周；短周期限流仍可能影响实际可用性。

**Claude 的接口没有提供账户累计 Token，面板因此显示“未提供”。OMP/Pi 的 RPC 没有订阅周额度查询，网页不会读取其认证文件或借用 CC/Codex 的账号来补数。**

## 数据来源与边界

- CC 使用已安装的官方 CLI，通过 Agent SDK 的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` 读取。此接口是实验性的；不扫描全量历史，也不发送用户提示。
- Codex 只调用 `initialize`、`account/read`、`account/rateLimits/read`、`account/usage/read` 等原生元数据接口，不创建 thread/turn，不抽取 token 后自己请求上游。
- 只取展示所需的套餐、额度和计数，不返回邮箱、账号 ID、原始错误或凭据。
- 统计只有短暂内存缓存，通常约 60 秒；并发读取复用同一次请求，手动刷新最少间隔 5 秒。无效会话 ID 不会制造更多原生查询。
- HTTP 必须通过同一网页访问密码、Host/Origin 校验，响应 `Cache-Control: no-store`。
- 账号总 Token 与本机会话 Token 不混算；大整数用十进制字符串展示，已失去精度的数值视为未知。

实现：`components/SubscriptionUsage.tsx`、`app/api/usage/route.ts`、`lib/subscription-usage.ts`、`lib/usage-normalize.ts`。

## 验证与远端发布

130 项相关测试、类型检查、隔离构建，以及桌面/390px 手机模拟浏览器检查通过。远端原生查询实测：CC 提供 2 个周额度窗口，Codex 提供 1 个周额度窗口及账号累计 Token。未把实际账号额度数字或登录凭据写入此文档。

当前发布：`/opt/omp-web-releases/20261105-usage-jdyq8M5i`，构建 `TK1xHSEtmLwGhNeGvVF_q`；远端 `status.json` 已记录 `active`。上一版保留在 `/opt/omp-web-releases/20261105-native-host-cYZladu2`。访问密码没有变化，原生 Agent 配置和登录未迁移，没有发送模型提示。

官方协议依据：[Codex 0.166.0 类型](https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs/app-server-protocol/schema/typescript/v2)、已安装 Claude Agent SDK 0.3.318 的使用量接口声明。
