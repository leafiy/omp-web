# omp-web

[English](./README.md) · [简体中文](./README.zh-CN.md)

**Use your local OMP, Pi, Claude Code, and Codex CLI from one browser workspace, with a terminal and file manager right beside them. No workflow to rebuild.**

These are the agents already on your machine. They keep their own logins, model configuration, skills, and project instructions. omp-web puts them in one web page that you can open from a laptop or a phone.

<img width="3460" height="2148" alt="image" src="https://github.com/user-attachments/assets/bd2c98e2-be32-44fe-b4f9-91cdb922e1d2" />

## My setup

```text
A low-spec, always-on Linux box at a remote home
├── Claude Code / Codex / OMP / Pi   ← each logged in; models run in the cloud
├── project checkouts
└── omp-web (systemd service, listening on 127.0.0.1 only)
        │
        │  Tailscale Serve (HTTPS) or an EasyTier virtual network
        ▼
Whatever laptop, phone, or tablet I have with me: just a browser
```

SSH got me connected, but copying long replies, scrolling back, reading diffs, and moving screenshots or files around were clumsy, especially from a phone. Now I open the page to read, copy, review changes, and upload files. When I need a shell, the terminal is right there.

Because the models run in the cloud, the host doesn't need to run a large model. The CLIs, the web service, and your builds still need resources. This is my personal setup, not a minimum hardware spec.

## Making it convenient

### One-time setup

1. **Install on the agent host.** Run the [installer](#install) as the OS user that already has the agents logged in, and let it install the systemd service so omp-web starts on boot.
2. **Reach it over a private network.**
   - **Tailscale:** keep omp-web on `127.0.0.1` and put Serve in front of it for HTTPS: `tailscale serve --bg 30141`. Open `https://<machine>.<tailnet>.ts.net`, and add that hostname to `PI_WEB_ALLOWED_HOSTS` (for example, run `sudo systemctl edit omp-web.service` and add `Environment=PI_WEB_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net`).
   - **EasyTier:** have the service listen on the host's virtual IP (`--host <virtual-ip>` when installing). Other devices connect by IP, so no hostname setting is needed.
3. **On your phone, use "Add to Home Screen".** The page then opens full-screen like a standalone app.

### Everyday use

- **Projects and sessions:** the sidebar lists sessions by project, and a tag at the start of each row shows its engine (OMP / Pi / CC / CX). Choose a directory and an agent when you start a session. An existing session always continues on its original engine.
- **Don't wait for it to finish:** paste screenshots, or drop and attach files, while the agent is running. Follow-up messages are queued, and you can pull one back to edit it before it's sent.
- **Read results:** replies are rendered as Markdown with copy buttons. Tool calls and subagent conversations expand inline. Long history folds by user turn, and expanding a turn loads all of it.
- **Changes and files:** preview files and view Git diffs from the file tree. Right-click (or tap "More" on touch devices) to copy, move, rename, download, or delete, or to upload into the current directory.
- **Terminal:** tabbed in-page terminals that are separate from the conversation, so you don't need a separate SSH session. For features only the native TUI has, run `claude`, `codex`, and so on right there.
- **Forks and worktrees:** fork a new session from any user message. For Git projects, pick or create a worktree when you start a session.
- **Native controls:** models, reasoning effort, slash commands, skills, approval prompts, context, and subscription usage (day/week/month tokens) all come from the selected agent. What's available varies by agent.
- **Completion sound:** turn it on to get a sound when a run finishes, even while you're on another tab.

## How it differs from Herdr, Orca, and Paseo

> I've tried a number of agent integration tools. They do more, but for the workflow I already had, the extra configuration, terminal management, and workspace conventions often got in the way. I just wanted to keep using my existing agents from a browser.

| Project | Focus |
| --- | --- |
| [Herdr](https://github.com/herdrdev/herdr) | A terminal runtime for agents: background sessions, panes, agent status, and local or SSH machines. There's also a [desktop app](https://github.com/herdrdev/herdr-app). |
| [Orca](https://github.com/stablyai/orca) | An agent orchestration workspace: parallel worktrees, Chat/Terminal modes, code review, remote runtimes, and a mobile companion app. |
| [Paseo](https://github.com/getpaseo/paseo) | A local daemon with desktop, mobile, web, and CLI clients. It runs parallel agents, each in its own worktree, and can orchestrate across providers. Devices connect through an end-to-end encrypted relay or a VPN such as Tailscale. |
| **omp-web** | A single web page on the host: your local OMP, Pi, Claude Code, and Codex CLI, plus a terminal and a file manager. |

All of these run the native CLIs, and each has its own remote, terminal, or file features, so none of those are unique to omp-web. omp-web keeps a narrower scope: one page with conversations, a terminal, and files. It doesn't orchestrate agents, it has no separate client to install or device to pair, and a plain conversation doesn't require you to adopt new workspace conventions first.

The comparison is based on official documentation (Herdr and Orca checked 2026-11-07, Paseo checked 2026-11-08): [sources and scope](./docs/agent-workspace-comparison-research.zh-CN.md).

## Install

**The host needs:** Linux, Node.js 22.19.0+, npm, Git, and at least one agent CLI that's already logged in: `omp` (Oh My Pi), `pi`, `claude`, or `codex`. Nothing needs to be installed on the devices you browse from.

```bash
curl -fsSL https://raw.githubusercontent.com/leafiy/omp-web/main/scripts/install.sh | bash

# Also install a systemd service that starts on boot
curl -fsSL https://raw.githubusercontent.com/leafiy/omp-web/main/scripts/install.sh | bash -s -- --service --host 127.0.0.1 --port 30141
```

The installer checks for runtimes but never installs them. It clones or updates `~/code/omp-web`, builds it, and asks you to choose a web username and password. Run it again to update. It refuses if there are uncommitted changes, and asks before stopping a running service. For unattended installs, set `OMP_WEB_USERNAME` and `OMP_WEB_PASSWORD`.

Without the service, start omp-web manually and open [http://127.0.0.1:30141](http://127.0.0.1:30141):

```bash
cd ~/code/omp-web && node bin/omp-web.js --hostname 127.0.0.1 --port 30141
```

<details>
<summary>Manual installation</summary>

```bash
mkdir -p ~/code
git clone https://github.com/leafiy/omp-web.git ~/code/omp-web
cd ~/code/omp-web
npm ci --include=dev
npm run build
npm run passwd   # choose the web username and password
npm start
```

</details>

This fork runs from source. An npm package named `omp-web` may be a different upstream release. Development, builds, and runtime all use the single `~/code/omp-web` directory. Stop the service before building. See the [single-workspace procedure](./docs/workspace.zh-CN.md).

## Sign-in and security

- **Login is always required.** There is no anonymous mode. Set or reset it with `npm run passwd` (or `node bin/omp-web.js passwd`). Credentials are stored as a salted scrypt hash in `~/.config/omp-web/credentials.json` (mode 0600; override the path with `OMP_WEB_AUTH_FILE`) and are separate from every agent's own login. You can change the password or sign out under **Settings → Web account**. Changing it signs out every other browser.
- **omp-web listens on loopback by default.** For remote access, use an HTTPS reverse proxy or a private network such as Tailscale or EasyTier. Never expose it to the public internet over plain HTTP.
- **Access to the page means access to the service account.** Agents and the terminal run as that user, and the terminal is not a sandbox. Prefer a least-privileged account.

## Limits

- Native behavior comes first. Browser support varies by agent; use the terminal for TUI-only features.
- Credentials are never migrated, and configuration is never shared between agents. Web history and caches are for display only; they are not the model's context.
- Restarting the web service interrupts running agents and terminals.
- Remote access doesn't change a provider's account eligibility, regional availability, or terms of use.

## Documentation

Most detailed notes are in Chinese:

- [Self-hosting and terminal](./docs/self-hosting.zh-CN.md) · [Native agents, auth, and deployment](./docs/native-host-deployment.zh-CN.md)
- [File browser and uploads](./docs/file-browser.zh-CN.md) · [Worktrees](./docs/worktrees.md) · [History folding and caching](./docs/history-cache.zh-CN.md)
- [Native skills](./docs/native-skills.zh-CN.md) · [Subscription usage](./docs/subscription-usage.zh-CN.md)
- [Claude Code commands](./docs/claude-code-commands.zh-CN.md) · [Steering and follow-ups](./docs/claude-code-steering.zh-CN.md) · [Follow-up queues and editing](./docs/queued-message-editing.zh-CN.md) · [Codex CLI](./docs/codex-cli.zh-CN.md)

## Origin and credits

This project grew out of [17380936778/omp-web](https://github.com/17380936778/omp-web), which builds on [agegr/pi-web](https://github.com/agegr/pi-web). Thanks to the upstream authors, and to the maintainers of OMP, Pi, Claude Code, and Codex, whose tools provide all of the agent capabilities you see in the browser.

## License

[MIT](./LICENSE). Upstream copyright notices are retained.
