# Dark / Starfield：真实 VS Code 主题对照

## 范围与证据状态

本记录来自对上游主题源码的直接 HTTP 获取，以及本仓库的静态源码阅读。用户随后授权直接修改，主题源码已按下述方向调整。尚未进行浏览器复现、截图对照、对比度自动测量或运行验证，因此不能宣称已经复现或验证解决用户所说的“Starfield 不能用”。Light 的基础配色和正文排版保持不变。

上游链接目前指向可变分支；下表记录的是本次实际读取到的值。不是寻找一个同名 Starfield 主题来替换网页，而是用真实编辑器主题作为工作区可读性的参照。

## 一手来源

1. Microsoft VS Code 内置 **Dark Modern**：
   https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json
   原始文件：https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-defaults/themes/dark_modern.json
2. Enkia **Tokyo Night** VS Code 扩展主题：
   https://github.com/enkia/tokyo-night-vscode-theme/blob/master/themes/tokyo-night-color-theme.json
   原始文件：https://raw.githubusercontent.com/enkia/tokyo-night-vscode-theme/master/themes/tokyo-night-color-theme.json

## 可核查的对照

| 用途 | Dark Modern [1] | Tokyo Night [2] | 修改前网页 |
| --- | --- | --- | --- |
| 编辑区背景 | `editor.background: #1F1F1F` | `editorPane.background: #1a1b26` | Dark `#1a1a1a`；Starfield `#08090d` |
| 侧栏背景 | `sideBar.background: #181818` | `sideBar.background: #16161e` | Dark token `#242424`；Starfield CSS 强制 `#0b0f18` |
| 正文参照 | `editor.foreground: #CCCCCC` | 变量语法色 `#c0caf5`；输入文字 `#a9b1d6` | Dark `#e8e8e8`；Starfield `#e8eeff` |
| 次级文字 | `descriptionForeground: #9D9D9D` | `foreground: #787c99` | Starfield muted `#8fa3c0`、dim `#3d5070` |
| 输入框 | 背景 `#313131`、边框 `#3C3C3C` | 背景 `#14141b`、文字 `#a9b1d6` | Starfield `#0a1020`，另加切角裁剪 |
| 主操作 | 背景 `#0078D4`、白字 | 背景 `#3d59a1dd`、白字 | Starfield 深蓝底金字，hover 反转 |
| 强调色参考 | 链接 `#4daafc` | 蓝 `#7aa2f7`、紫 `#bb9af7`、金 `#e0af68` | Starfield 金 `#d99b26`，用于大量控件和内容 |

重要区别：上游各颜色有明确语义，并不意味着全部可直接映射到网页的 `--accent`。文字链接、实心按钮、选中行和焦点边框应分别处理。Tokyo Night 原版也有很暗的次级文字和注释，不应因其是真实主题就照抄低对比度值。

## 修改前可直接确认的实现问题

- `hooks/useTheme.ts` 的 `isDark` 仅判断 `theme === "dark"`。`hooks/useCodeTheme.ts` 自动模式按这个值在 `vscDarkPlus` 与 `vs` 间选择，所以 **Starfield 自动代码主题实际选择浅色 `vs`**。`components/MermaidBlock.tsx` 同样通过这个布尔值选 Mermaid 的 dark/default。需要浏览器验证实际呈现和影响，修改时必须保留用户显式选择的代码主题。
- `app/globals.css` 的 Starfield 规则用 `span[style*="color: ..."]` 重涂部分语法颜色。这不是完整的语法主题适配，也会覆盖用户显式选择的高亮主题；不能靠继续增加颜色字符串匹配解决。
- 同一文件的 Starfield CSS 强制把多个控件设为 10px、全大写、增大字距，并更换字体；还有 3px 滚动条、输入框/发送按钮/用户消息切角、全屏扫描线、大量 `!important` 和按 inline style 文本匹配容器的规则。它们是可以确认的实现事实，但各自是否对应用户的具体故障，需要实测。
- 阅读样式使用 `html:not(.starfield) .markdown-reading`，Starfield 被排除在统一的正文排版之外。
- `components/TerminalViewport.tsx` 创建终端时硬编码背景 `#161b22`、前景/光标 `#e6edf3`，不能仅改全局 CSS 就使终端跟随主题。
- `components/LanguagePicker.tsx` 等处还有独立的 Starfield 金色/字体规则，不能只检查 `globals.css`。

## 实施方向

### Dark：以 Dark Modern 为参考

- 中性灰工作区，侧栏/工具栏比内容区略暗，边框轻但可辨。
- 区分 hover、selected、focus；蓝色集中用于操作/链接，不把背景层级全部做成灰度堆叠。
- 提高必要的次级文字可读性；不能拿“禁用文字”的颜色显示仍然需要阅读的时间、路径和说明。

### Starfield：以 Tokyo Night 为深蓝配色参考，保留少量金色身份

- 保留 Starfield 名称和深空蓝/金色识别，不把页面改成另一个陌生主题，也不声称存在某个官方 Starfield 主题。
- 采用稳定的蓝灰表面层级，金色仅用于品牌/少量强调；错误、成功、运行中状态维持独立语义。
- 去掉影响阅读的扫描线、切角裁剪、强制 10px 和全局字体替换；使用现有中英文字体与正文排版。
- 使用真实高亮主题对象或现有深色预设，不通过 CSS 猜测内联 RGB 颜色；自动选择与显式选择分开。
- 保留正常滚动条和清晰的键盘焦点，不给所有块都加亮色左边框、发光和装饰。

## 本轮源码修改

- `app/globals.css`：Dark 使用 Dark Modern 的灰色工作区基础；Starfield 使用 Tokyo Night 的蓝灰表面，保留金色品牌/发送按钮。文字、选中、输入、实心按钮和焦点分别定义，不直接把亮色链接 token 当按钮底色。
- 删除旧 Starfield 大段装饰覆盖，包括全屏扫描线、网格、切角、准星、代码颜色字符串匹配、强制字体/字号和滚动条缩窄。正文恢复共用阅读样式；保留既有状态语义和布局。
- `hooks/useTheme.ts`：`isDark` 表示深色系，包含 Starfield；自动代码主题因此使用现有 VS Code Dark Plus，Mermaid 使用 dark。没有新增或假称完整 Tokyo Night 语法主题，用户显式选择仍然优先。
- `components/ThemePicker.tsx`、`components/LanguagePicker.tsx`、`components/SessionSidebar.tsx`、`components/AppShell.tsx`：清理零散的 Starfield 字体/装饰覆盖，更新预览色块，保留徽章与少量金色。移除空白欢迎页的虚构“agent active”装饰文案。
- `components/ComposerActions.tsx`：深色下提高 steer/follow-up 文字亮度，Light 沿用原色。
- `components/TerminalViewport.tsx` 和 `components/TerminalPanel.module.css`：深色终端背景/前景跟随工作区，Starfield ANSI 色参考 [2]，其中普通白、亮黑和亮白为网页可读性进行了提亮。观察根元素 class，只修改 xterm 配色，不重建终端或重连 shell；Light 沿用原终端颜色。
- 所有这些是源码修改状态，不代表视觉验收通过。未运行测试、类型检查、构建、浏览器、服务重启或模型请求。

## 后续验证闭环

仍需用户授权本任务的浏览器复现/截图检查（运行检查按仓库要求单独授权），或提供具体页面截图。至少覆盖：

1. 三主题同一段中英文长对话，展开工具、代码、表格、引用、Mermaid。
2. 侧栏选中/hover、输入框 focus、禁用发送按钮、错误提示。
3. 右侧源码/预览/diff、自动与手动代码主题。
4. 桌面/窄屏，长路径和长文本，键盘导航及滚动条。
5. 检查正文/必要辅助文本的对比度，以及输入/焦点边界可辨性。

此授权不包含构建、覆盖生产 `.next`、安装依赖、重启服务、启动 agent 或请求模型；如需这些操作应另行询问。用户选择先改源码；后续应在相同场景下对照修改前后结果，不以单纯编译通过代替视觉验收。
