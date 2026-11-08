# Worktrees in omp-web

omp-web groups all Git worktrees of one project under a single project in the sidebar. Use this when you want to keep separate checkouts for different branches, while keeping the project's sessions grouped together.

## Where the Worktree Controls Are

You choose a worktree when you start a session. Click **New session** in the sidebar, or the pencil button on a project row, then open the directory chip above the chat input. When that directory is a Git checkout's top level, the menu lists the project's worktrees under **Worktrees**.

The Worktrees section is hidden when:

- The directory is not a Git repository (for example the default `/tmp`).
- The directory is inside a repository, but not at a checkout's top level.
- Git cannot read the repository's worktree list.

If you are inside a repo subdirectory, first pick the repository root from **Recent projects**, **Browse folders…** or **Custom path…**.

## Choosing a Worktree

Picking a worktree restarts the empty chat in that checkout. The new session, the file Explorer and file mentions inserted from the Explorer all use it. After the first message, the session keeps that directory.

Existing sessions stay grouped under their project in the sidebar. Opening a session switches the Explorer to that session's checkout.

## Creating a Worktree

Choose `New worktree…` in the Worktrees section of the directory menu and enter a branch name. The empty chat moves to the new checkout.

omp-web creates the checkout at:

```text
<repo>-worktrees/<branch>
```

For example, if the main checkout is:

```text
/Users/alex/Documents/Workspace/omp-web
```

and you create branch `codex/worktree-help`, the worktree is created under:

```text
/Users/alex/Documents/Workspace/omp-web-worktrees/codex-worktree-help
```

If the branch already exists, omp-web adds a worktree for that branch. If it does not exist, omp-web creates the branch from the current `HEAD`.

## Removing a Worktree

Use the remove button next to a non-main worktree in the directory menu to remove that checkout.

Removing a worktree does not delete:

- The Git branch.
- omp-web session history.
- The main checkout.

If the worktree has uncommitted or untracked files, Git refuses the removal. Pi Web then offers a force remove action. Force removal discards the uncommitted files in that checkout, so use it only when you no longer need those changes.

## Sessions and Worktrees

omp-web groups sessions by project root, so sessions from the main checkout and linked worktrees appear together.

Each session still remembers the working directory it was created with. That means:

- A session started in a worktree continues to use that worktree path.
- A session started in the main checkout continues to use the main checkout.
- If a worktree has been removed, old sessions from it stay visible under the project so you can still find the history.

## Troubleshooting

**I do not see the Worktrees section.**
Choose a Git repository root as the new session's directory. Non-Git directories and repo subdirectories do not list worktrees.

**A branch cannot be added as a worktree.**
Git allows a branch to be checked out in only one worktree at a time. Switch to the existing worktree for that branch, or remove it first.

Git can keep prunable worktree records after a checkout disappears. omp-web filters those out of the directory menu.

The Explorer follows the open chat: the selected session's checkout, or the directory chosen for a new session.
