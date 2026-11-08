# omp-web

**One URL for your local coding agents.**

[English](./README.md) · [简体中文](./README.zh-CN.md)

Use **OMP, Pi, Claude Code, and Codex CLI** from one browser workspace, with a terminal and file manager alongside your conversations.

Your agents do the work. The browser makes them easier to use.

Instead of juggling terminal windows, repeatedly reconnecting over SSH, or rebuilding your agent setup for another chat frontend, open a link, choose a project and an agent, and get to work—from your desktop or your phone.

<img width="3494" height="2168" alt="image" src="https://github.com/user-attachments/assets/24ab39dc-6b54-45d2-80f6-e723466eaa4b" />


**Connect through Tailscale, EasyTier, or another trusted private network. Once connected, a browser is enough to get to work.**

## The real use case: a small computer for the agent, a browser for you

**This is already how I use omp-web—not a hypothetical deployment.**

I keep Claude Code on a low-spec computer at a remote home, with omp-web deployed alongside it. That machine is the dedicated agent host; I access it from whichever computer or phone I have with me. The agent, its configuration, and the projects stay in one place.

SSH got me connected, but it did not make the everyday work comfortable. Copying and pasting, scrolling through long output, reviewing diffs, and moving files around were cumbersome—especially from a phone. The hard part was no longer reaching Claude Code; it was working with the results.

With omp-web, I open the page, read and copy responses, review changes, upload files, and manage the project without doing all of that inside a remote terminal. When I need a shell, it is already beside the conversation.

**For this workflow, the browser is not an extra dashboard. It is what makes a dedicated remote agent machine practical to use every day.**

A modest host can be useful here because cloud-hosted models do not require it to run a large model locally. It still needs enough resources for the CLI, web service, and your actual builds and tools; this is a personal setup, not a minimum-hardware or performance guarantee.

## Your agents, not another agent platform

omp-web is a convenient way to operate the agents already installed on your machine. It is **not a replacement agent, a model gateway, or a separate AI tool system**.

- **The selected local agent provides the AI conversation and coding tools.** Model access, tool execution, skills, project instructions, and permission decisions belong to that agent.
- **Keep the agent's own setup.** Each CLI loads its own configuration and login. You do not need to recreate provider settings or copy API keys into a second web configuration.
- **The web UI handles the surrounding workflow.** Choose an agent, manage conversations, view streaming output, respond to supported approval requests, inspect files, and open a shell.
- **Agents stay separate.** Choosing a different agent starts a conversation with that agent; it does not translate an existing conversation or share credentials between tools.

```text
Your browser — desktop or phone
              │
              ▼
    omp-web on your workstation or server
              │
              ├── OMP
              ├── Pi
              ├── Claude Code
              ├── Codex CLI
              │
              ├── Built-in terminal
              └── File manager & previews
```

“Local” means the agents run on the machine hosting omp-web—not necessarily on the device running your browser. Their models may still use cloud providers, according to each agent's own configuration.

## What the browser adds

| Feature | What it is for |
| --- | --- |
| **One entry point** | Switch between locally installed OMP, Pi, Claude Code, and Codex CLI without maintaining a separate web frontend for each. |
| **Project-based conversations** | Organize conversations by project, return to previous work, and see streamed responses and tool activity in a readable interface. |
| **Native controls** | Use the model, command, skill, approval, context, and usage information exposed by the selected agent. Availability varies by agent. |
| **Built-in terminal** | Run commands in an interactive shell while the agent works. Terminal input is independent of the AI conversation, and it uses the same web connection—no separate terminal service or port to set up. |
| **File management** | Browse and preview project files, upload to the active directory, and use copy, cut, paste, move, rename, create, download, and confirmed delete actions. |
| **Comfortable browsing** | Desktop and mobile layouts, English and Chinese UI, paged conversation history, and bounded in-memory caching for faster navigation. |

The terminal is there when you want a shell—not because every conversation needs its own terminal window. Likewise, the file manager is a convenience for working with your project, not a replacement for the agent's native tools.

## Work from anywhere with Tailscale or EasyTier

Leave your agents and projects on the workstation or server where they already work. Use [Tailscale](https://tailscale.com/docs/features/tailscale-serve), [EasyTier](https://github.com/EasyTier/EasyTier), or a comparable private network to reach that machine from elsewhere.

1. Run omp-web on the host under the account that already has your agents configured, with web authentication enabled.
2. Set up the private network on the host and connect your other devices—or a trusted gateway—to it. Bind omp-web to the private address, or keep it on loopback behind an HTTPS proxy such as Tailscale Serve.
3. Open the protected web URL from a laptop, phone, or tablet. **No agent CLI, desktop agent app, or SSH client is needed on that device.**

The host must stay online and the private connection must be reachable. A browser does not establish the VPN for you, and these networking tools are optional—not bundled into omp-web. Keep the web password, network access rules, and hostname checks in place.

### Remote Claude Code, without doing everything inside a terminal

Remote coding is not just about sending a prompt. It is also about getting information and files into and out of the session:

| Everyday friction in a remote terminal | The browser workflow |
| --- | --- |
| Selecting and copying long replies or code; pasting text back into a TUI | Read rendered messages, use copy controls, and compose text in a normal browser input. |
| Searching through terminal scrollback | Browse conversation history with pagination and display caching, rather than relying only on a terminal's scroll buffer. |
| Reviewing changes in a narrow terminal viewport | Open changed files and inspect their Git diffs alongside the conversation. |
| Sending screenshots or project files to the remote machine | Upload through the browser instead of opening a separate transfer tool for each attachment. |
| Repeatedly typing paths to inspect, copy, move, rename, or download files | Use the file browser, previews, and context menus; touch devices get a “More” menu. |
| Needing an occasional command while the agent is working | Open the independent embedded terminal without leaving the page. |

This makes remote Claude Code—and the other supported agents—more comfortable to use without replacing the agent underneath. Browser clipboard permissions and agent attachment support still apply; ordinary uploaded files are stored on the host and passed as file references.

## Why this fork: a different priority from Herdr and Orca

**Maintainer's motivation:**

> I tried Herdr, Orca, and other agent integrations. For my workflow, the extra configuration, terminal management, and workspace conventions too often got in the way. I wanted browser access to the agents I already use—not another platform I had to reorganize my work around.

The distinction is the workflow, not whether these projects can run native agents:

| Project | Main focus | What that means for this use case |
| --- | --- | --- |
| [Herdr](https://github.com/herdrdev/herdr) | A runtime for agents' terminals: background sessions, panes, agent status, and local/SSH machines; also an official [desktop app](https://github.com/herdrdev/herdr-app). | A fit when you want a persistent terminal-centric environment. This fork instead makes the browser the main entry point, with a shell as an optional companion—not a new pane-management workflow to adopt. |
| [Orca](https://github.com/stablyai/orca) | An agent orchestration workspace with parallel worktrees, Chat/Terminal modes, review tools, remote runtimes, and a mobile companion. | A fit when you want a broader agent workspace. This fork concentrates on opening an existing project and using its local agents, without making orchestration or a new worktree workflow a prerequisite. |
| **omp-web — this fork** | A self-hosted browser entry point for OMP, Pi, Claude Code, and Codex CLI, plus an independent terminal and file manager. | Keep the existing agents, logins, configurations, and projects. Add web access; do not migrate to a replacement agent or configuration system. |

Herdr and Orca also support native agents, and Orca already has file browsing, previews, and mobile access. Those are not exclusive claims for omp-web. The preference here is a narrower, browser-first workflow—not a claim to replace their entire feature sets or a measured ranking of setup difficulty.

**Keep your CLI setup. Change the interface, not your workflow.** Continue using your CLIs normally when you prefer; the web UI is an additional way to operate them. There is still one-time web-server, authentication, and network setup, and browser support varies by agent.

Comparison based on official documentation, checked 2026-11-07: [sources and scope](./docs/agent-workspace-comparison-research.zh-CN.md). The quoted experience is the maintainer's motivation, not a claim that every user will have the same experience.

## Get started

### 1. Have a local agent ready

Install and configure at least one of the following using its own setup and login flow:

| Agent | Local executable |
| --- | --- |
| Oh My Pi | `omp` |
| Pi | `pi` |
| Claude Code | `claude` |
| Codex CLI | `codex` |

Run omp-web under the OS account that has those agents configured. The web server discovers installed executables; the browser itself does not need the CLIs installed.

You also need **Node.js 22.19.0+**, npm, and Git. Linux is the tested deployment platform; file-management mutations currently require Linux.

### 2. Run the web app

In a fresh checkout:

```bash
mkdir -p ~/code
git clone https://github.com/leafiy/omp-web.git ~/code/omp-web
cd ~/code/omp-web
npm ci --include=dev
npm run build
npm start
```

Open **[http://127.0.0.1:30141](http://127.0.0.1:30141)**, choose a project, select an installed agent, and start a conversation.

This fork is run from source. An npm package named `omp-web` may refer to a different upstream release.

Use **`~/code/omp-web` as the single checkout for development, builds, deployment and runtime**. Keep dependencies and `.next` there; stop the production service before `npm run build` or `npm run dev`. The normal launch/build commands reject other locations. See the [single-workspace maintenance procedure](./docs/workspace.zh-CN.md).

### 3. Access it securely from another device

The default listener is loopback-only. Before exposing the app beyond your machine:

1. Create a password file owned by the service user, with mode **0600**, containing a single-line web access password.
2. Require authentication when starting the app:

   ```bash
   OMP_WEB_REQUIRE_PASSWORD=1 \
   PI_WEB_PASSWORD_FILE=/absolute/path/to/web-password \
   node bin/omp-web.js --hostname 127.0.0.1 --port 30141 --no-open
   ```

3. Use an **HTTPS reverse proxy** or a **trusted private network**, such as Tailscale or EasyTier. For direct VPN access, bind to the machine's private VPN address rather than a public wildcard address. If using a custom hostname, configure `PI_WEB_ALLOWED_HOSTS`.

The web login username is **`pi`**. This password protects the website; it is separate from every agent's own login.

**Treat access to this page like access to your development machine.** Agents and the terminal run with the service account's permissions. The terminal is not a sandbox, and Basic Auth does not encrypt HTTP traffic. Prefer a least-privileged account and never expose an unauthenticated instance to the public internet.

## A few important boundaries

- **Native behavior comes first.** Browser support differs between agents; not every CLI/TUI feature or existing terminal session is available through the UI. CLI-only workflows remain available through the terminal.
- **No credential migration.** Installing omp-web on another host does not copy agent logins, model configuration, or native histories from the first host.
- **Display is not model context.** Web history views and caches help navigation; they do not replace the context managed by the native agent.
- **A browser is not process supervision.** Restarting the web service can interrupt active agents and embedded terminals. It is not a promise of uninterrupted execution across server restarts.
- **Remote access does not change provider rules.** Account eligibility, regional availability, and usage terms still apply. This project improves how you operate your machine; it makes no guarantees about provider account decisions.

## More documentation

Detailed operational notes are currently mostly in Chinese:

- [Self-hosting and terminal](./docs/self-hosting.zh-CN.md)
- [Native agents, authentication, and deployment](./docs/native-host-deployment.zh-CN.md)
- [File browser and upload behavior](./docs/file-browser.zh-CN.md)
- [Conversation history and display caching](./docs/history-cache.zh-CN.md)
- [Native skills](./docs/native-skills.zh-CN.md) · [Subscription usage](./docs/subscription-usage.zh-CN.md)
- [Claude Code commands](./docs/claude-code-commands.zh-CN.md) · [Steering and follow-ups](./docs/claude-code-steering.zh-CN.md) · [Four-engine follow-up queues and editing](./docs/queued-message-editing.zh-CN.md)
- [Codex CLI](./docs/codex-cli.zh-CN.md)

## Origin and credits

This project grew out of **[17380936778/omp-web](https://github.com/17380936778/omp-web)**, which in turn builds on **[agegr/pi-web](https://github.com/agegr/pi-web)**.

Their work provided the foundation for the browser workspace, conversation browsing, and file previews. This fork extends that foundation into a shared entry point for multiple local agents, with an integrated terminal and file-management workflow.

Thanks to the upstream authors and the maintainers of OMP, Pi, Claude Code, and Codex for the tools that power the experience.

## License

[MIT](./LICENSE). Upstream copyright notices are retained.
