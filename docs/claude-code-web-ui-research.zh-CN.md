# Claude Code Web UI 候选调研

调研日期：2026-10-31。目标：寻找类似 omp-web、可从浏览器操作 Claude Code 的界面，重点看自托管、终端、文件上传和手机访问。

## 结论

- 若要类似当前 omp-web 的完整浏览器工作台，优先考察 **CloudCLI / Claude Code UI**。
- 若重点是手机接管本机任务、权限审批和多机器，优先考察 **HAPI**；**Happy** 也是跨设备方案。
- **sugyan/claude-code-webui** 已明确停止维护并归档，不建议新部署。
- 官方 **Remote Control** 也能在浏览器操作本机 Claude Code，但不是可自行部署的开源 Web UI；有订阅、登录和 API 端点限制。

以上推荐是根据文档与源码作出的适配判断，不是运行评测。

## 1. CloudCLI（原 Claude Code UI）

仓库：https://github.com/siteboon/claudecodeui

作者 README 确认：

- 支持 Claude Code、Cursor CLI、Codex。
- 可自托管，支持桌面与移动浏览器。
- 有交互聊天、内置 Shell、文件浏览与编辑、Git 操作、历史会话和插件。
- 自托管版本自动发现已有会话，并读写 Claude Code 的原有配置。
- npm 启动入口为 `npx @cloudcli-ai/cloudcli`，要求 Node.js 22+，默认页面端口 3001。这只是文档记录，本次未执行。
- 许可证为 AGPL-3.0-or-later，并有 Section 7 附加条款；修改后对外提供网络服务前应阅读许可证。

来源：[README](https://github.com/siteboon/claudecodeui/blob/HEAD/README.md)。

### 文件上传核查

并非仅根据“附件按钮”推断支持任意文件：

- 当前聊天前端使用 `useDropzone`，未设置 MIME 白名单；附件限制为单文件 10MB、最多 10 个。
- 后端 `/files` 路由接受任意 MIME 类型，限制同样为 10MB / 10 个。源码明确说明文件供提供商通过文件读取工具处理。
- 另有旧的仅图片 `/images` 接口，不能把这个接口的图片白名单当作全部附件能力。
- 文件树还具有独立上传和拖放处理逻辑。

来源：

- [聊天输入与拖放](https://github.com/siteboon/claudecodeui/blob/HEAD/src/modules/chat/hooks/useChatComposerState.ts)
- [附件上传后端](https://github.com/siteboon/claudecodeui/blob/HEAD/server/modules/assets/assets.routes.ts)
- [文件树上传](https://github.com/siteboon/claudecodeui/blob/HEAD/src/modules/file-tree/hooks/useFileTreeUpload.ts)

注意：这是所获取仓库 HEAD 源码的能力，不保证 npm 当前发布版完全一致。接受上传不等于 Claude 原生理解所有文件格式。

## 2. HAPI

仓库：https://github.com/tiann/hapi

- 包装官方 Claude Code 等 CLI，保持本机执行，支持本地与远程接管。
- 提供 Web / PWA、远程终端、手机权限审批；另有付费原生客户端。
- 自托管架构包含 CLI、Hub，以及用于远程创建会话的可选 Runner；支持一个 Hub 连接多台机器。
- Hub 默认 `127.0.0.1:3006`，首次运行生成访问令牌；可以只使用本地服务，不必启用公共 relay。
- 支持指定 Runner 的 workspace roots，约束可浏览和启动会话的目录。

来源：[README](https://github.com/tiann/hapi/blob/HEAD/README.md)、[安装与架构](https://github.com/tiann/hapi/blob/HEAD/docs/guide/installation.md)。

本次未充分核实 HAPI 的任意文件拖拽上传能力，不据此作保证。

## 3. Happy Engineering

仓库：https://github.com/slopus/happy

- 提供移动端、Web 客户端、原始 CLI 和同步中继服务。
- 原始 CLI 直接包装 Claude Code / Codex，可从手机继续终端任务；当前项目也有单独的桌面与 Agent 产品线，选型时需区分。
- README 声明 MIT 开源、跨设备端到端加密。
- Happy Server 官方说明支持自行部署；服务端保存加密数据并负责同步。

来源：[README](https://github.com/slopus/happy/blob/HEAD/README.md)、[Server 自托管说明](https://github.com/slopus/happy/blob/HEAD/packages/happy-server/README.md)。

更适合跨设备协作方向。此次未核实其 Web 客户端的通用文件拖拽体验，也未进行部署复杂度实测。

## 4. sugyan/claude-code-webui

仓库：https://github.com/sugyan/claude-code-webui

- README 提供流式聊天、项目选择、历史恢复、工具权限管理和移动适配。
- README 开头明确声明不再积极维护、仓库已归档。
- 安全部分明确说明没有内置认证，不应直接暴露到公网。

来源：[README](https://github.com/sugyan/claude-code-webui/blob/HEAD/README.md)。

适合参考或自行接手维护，不建议作为新部署首选。

## 5. 官方 Remote Control

- 通过 `claude remote-control` 将本机 Claude Code 连接到 `claude.ai/code` 或 Claude 手机客户端；执行和本地文件系统访问仍在本机。
- 官方文档明确支持从浏览器或手机发送图片与文件；其他文件会下载到执行机器并作为 `@` 文件引用交给 Claude。
- 不是自托管 Web UI。要求合资格官方订阅登录，不支持 API key；自定义 `ANTHROPIC_BASE_URL` 指向非官方主机等配置不可使用。
- 必须与 Claude Code 云端会话区分：Remote Control 操作本机会话；云端会话默认在 Anthropic 基础设施执行，也可根据组织配置路由到自托管执行环境。

来源：[Remote Control 官方文档](https://code.claude.com/docs/en/remote-control.md)、[云端会话官方文档](https://code.claude.com/docs/en/claude-code-on-the-web.md)。

## 调研边界

只读取作者仓库 README、相关源码和 Anthropic 官方文档；未安装依赖、启动候选服务、调用模型或进行运行时验证。GitHub 仓库 API 返回 403，因此未提供未经核实的 Star 数、最近提交日期或最新版本排名。源码下载仅用于阅读，不执行下载的代码。
