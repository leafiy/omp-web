# 侧栏会话删除

Claude Code 侧栏删除入口原先受 `supportsExtendedChat` 限制，与尚未支持的 Fork/树导航一起隐藏，DELETE API 也返回 409。现将 `supportsSessionDeletion` 单独建模：OMP、Pi、Claude Code 可删除；Codex 仍未实现原生历史删除，不开放入口。

- 鼠标悬停或选中会话行显示操作按钮。普通点击仍需确认，只有 Shift+点击跳过确认。
- Claude Code 删除先检查网页会话未运行/启动，再关闭空闲 adapter。删除期间拒绝并发恢复和重复删除，不强制停止正在生成或执行子任务的会话。
- 校验网页记录的 UUID、固定投影路径、引擎标识和 cwd 后，调用现有 Claude SDK `deleteSession(nativeId, { dir: cwd })`，删除本机原生 transcript 及该会话的子代理历史。成功后删除网页投影，清除会话路径/列表缓存。不删除其他会话或项目文件。
- 未产生原生历史的空草稿、原生历史已被删除的残留网页记录可以清理。其他原生删除错误不吞掉，保留网页记录供重试；两步删除不是跨文件事务。
- API 拒绝忙碌会话或删除失败时，侧栏显示错误，不再静默失败。
- 只影响本机历史，不声称删除 Anthropic 云端数据，也不管理终端中另行启动的同 UUID 会话；请先退出这类终端会话。

验证：`components/session-delete-render.test.mjs` 直接渲染真实会话行；`lib/claude-code-delete.test.mjs` 使用临时原生/网页目录运行真实 SDK 删除和 DELETE 路由，覆盖子代理/相邻记录、空草稿、失败保留、身份校验、忙碌/并发保护、认证和缓存失效。测试不启动 Agent、不发送模型请求、不删除用户真实历史。
