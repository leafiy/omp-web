# omp-web 里的 Worktree

omp-web 会把同一个 Git 项目的 main checkout 和 linked worktree 放在同一个项目下。你可以用它在不同分支之间切换工作目录，同时保留统一的会话列表。

## Worktree 控件在哪里

worktree 在新建会话时选择。点击侧边栏顶部的 **+**（新建会话），或项目行上的铅笔按钮，然后打开聊天输入框上方的目录按钮。当这个目录是 Git checkout 的顶层目录时，菜单里的 **Worktrees** 分组会列出这个项目的 worktree。

以下情况不会显示 Worktrees 分组：

- 目录不是 Git 仓库（例如默认的 `/tmp`）。
- 目录在某个 Git 仓库里面，但不是 checkout 的顶层目录。
- Git 无法读取这个仓库的 worktree 列表。

如果你在仓库子目录里，先从 **最近项目**、**浏览文件夹…** 或 **自定义路径…** 选择仓库根目录。

## 选择 Worktree 会影响什么

选择 worktree 后，空白聊天会在那个 checkout 里重新开始。新会话、左侧 Explorer、以及从 Explorer 插入到输入框的文件路径都会使用它。发送第一条消息后，会话会固定使用这个目录。

已有会话仍然在侧边栏里按项目分组。打开一个会话时，Explorer 会切换到这个会话所在的 checkout。

## 新建 Worktree

在目录菜单的 Worktrees 分组里选择 `新建 worktree…`，输入 branch name。空白聊天会切换到新的 checkout。

omp-web 会把 checkout 放在：

```text
<repo>-worktrees/<branch>
```

例如 main checkout 是：

```text
/Users/alex/Documents/Workspace/omp-web
```

新建 `codex/worktree-help` 时，目录会是：

```text
/Users/alex/Documents/Workspace/omp-web-worktrees/codex-worktree-help
```

如果这个 branch 已存在，omp-web 会为它添加 worktree。如果 branch 不存在，omp-web 会从当前 `HEAD` 创建这个 branch。

## 删除 Worktree

目录菜单里非 main worktree 右侧有删除按钮。它删除的是这个 checkout 目录。

删除 worktree 不会删除：

- Git branch。
- omp-web 的历史会话。
- main checkout。

如果 worktree 里有未提交或未跟踪文件，Git 会拒绝删除。Pi Web 会再显示 force remove。force remove 会丢弃这个 checkout 里的未提交文件，只在确定不需要这些改动时使用。

## 会话和 Worktree 的关系

omp-web 按 project root 分组会话，所以 main checkout 和 linked worktree 里的会话会显示在一起。

但每个会话仍然记得自己创建时的 working directory：

- 在某个 worktree 创建的会话，会继续使用那个 worktree path。
- 在 main checkout 创建的会话，会继续使用 main checkout。
- 如果某个 worktree 已被删除，它的历史会话仍会显示在项目下，方便你找回上下文。

## 常见问题

**为什么我看不到 Worktrees 分组？**
请把新会话的目录选为 Git 仓库根目录。非 Git 目录和仓库子目录不会列出 worktree。

**为什么某个 branch 不能创建 worktree？**
Git 不允许同一个 branch 同时被多个 worktree checkout。你可以切到已有的 worktree，或者先删除那个 checkout。

**Git 里还有已经消失的 worktree 记录怎么办？**
Git 有时会保留 prunable worktree 记录。Pi Web 会过滤这些记录，不在目录菜单里显示。

**Explorer 和当前聊天看起来不在同一个分支？**
Explorer 跟随当前打开的聊天：已选会话所在的 checkout，或新会话选择的目录。
