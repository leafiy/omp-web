# Claude Code 原生模型目录与 Effort

## 问题与修复

旧 `/api/models` 把 Claude SDK 的模型行压成别名/显示名称，丢弃 `resolvedModel` 和 effort 能力，并始终返回空的默认模型与推理等级。前端又用 `supportsExtendedChat` 隐藏 Claude 的等级控件，后端拒绝 `set_thinking_level`。因此 CLI 已具备这些能力，网页仍不能正确展示或设置。

- 通过当前本机 CLI 的 `list_models` 控制请求获取实时目录，不硬编码 Claude 型号，也不把初始化目录当作永远不变。旧 CLI 明确不支持该请求时才回退 SDK `supportedModels()`；真实查询错误会显示，不伪造可用模型。
- 保留别名及 `resolvedModel`，下拉行显示实际模型 ID，搜索可匹配真实 ID。选择仍把原生别名/ID 交给 Claude；设置成功后显示 CLI 实际采用的模型，而非乐观假定请求值就是结果。
- 使用原生 `get_settings` 的 `applied.model`、`applied.effort` 显示当前配置，包括尚未发首条消息的新会话。只提取这两个字段，不向 HTTP 客户端返回原始 settings、环境凭据或路径来源。
- 若当前已配置自定义模型但未出现在 CLI 菜单，显示当前实际模型，不猜测它的 effort 能力。不扫描其他引擎凭据，也不向任意第三方 endpoint 自动探测模型。

## Effort 控件

- Claude 专用 Effort 控件复用输入工具栏位置，选项来自该模型原生 `supportedEffortLevels`。只展示支持的 `low / medium / high / xhigh / max`，不把 OMP/Pi 的 `off / minimal` 混入；只有一个支持档位时也不扩展为通用列表。
- 新会话的显式选择通过 SDK `Options.effort` 传递。未选择时不覆盖 CLI 原生默认。已有会话通过 SDK `applyFlagSettings({ effortLevel })` 修改**会话级**设置；不写用户/项目设置文件。
- 已有会话选 `auto` 会真正发送 `effortLevel: null`，恢复原生模型默认（SDK 定义），不是仅改下拉框。新会话未显式选择等级时沿用 CLI 启动默认。
- 设置后重新读取 `applied.effort`；模型限制、组织策略或环境覆盖导致降档时，显示实际档位并提示。失败显示错误，不把未成功的选择伪装成已应用。跨会话的迟到响应不会覆盖当前页面。
- 生成中或原生后台任务仍运行时拒绝切换。网页模型/effort 选择写入网页投影，重新创建该网页 adapter 时恢复；不复制模型凭据或改写 Claude 原生历史。原生 `/effort`、`/model` 仍由 CLI 处理，空闲状态查询会同步其实际选择。
- Effort 不是 Claude 的 thinking-token 预算。SDK 的 effort 设置遵循其原生语义（包括组织上限，以及未显式保留 ultracode 时原生对它的处理）。未实现能力仍明确禁用。

## 兼容层与验证

`lib/claude-models.ts` 将 pinned SDK 0.3.318 未提供公开类型便利方法的 `list_models` / `get_settings` 两个只读请求收敛到一个受限兼容层；客户端不能提交任意 raw 控制请求。请求有超时，effort 修改使用 SDK 正式的 `applyFlagSettings`。本机原生 CLI 2.1.319 已通过无模型提示的实际查询、临时 effort 修改/auto 恢复、模型别名解析验证；无持久化会话，用户 settings 文件摘要未改变。

回归覆盖目录实时性、真实 ID、当前模型、能力裁剪、策略降档、auto、初始/恢复偏好、错误、忙碌与迟到响应；真实组件 SSR 覆盖模型显示和 Effort 控件。测试不发送真实模型提示，不将目录发现等同于所有型号都已完成真实账号对话验收。
