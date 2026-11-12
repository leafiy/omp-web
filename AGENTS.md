# omp-web — Development Notes

## Canonical workspace

Develop, test, commit, build, deploy and run this fork only from `~/code/omp-web` (on 192.168.52.3: `/root/code/omp-web`). Keep `.git`, `node_modules` and `.next` in that directory. Use its existing checkout; do not create another checkout, worktree or external release/build directory. Local logs and inactive rollback archives belong under its git-ignored `.local/`; credentials and native agent data remain in their existing protected locations.

For migration, builds, deployment, rollback or service-path changes, read [the single-workspace procedure](./docs/workspace.zh-CN.md). Historical `/opt/omp-web*` deployment records are not current instructions. Stop the production service before building into its `.next`; a conversation hosted by that service must finish before a separately supervised maintenance task stops it.

## Execution and verification

Chat uses a **local OMP or Pi executable over JSONL RPC**, selected when a session is created. Before changing engine selection, agent commands, model/auth discovery, session persistence, tool selection, or deployment, read [docs/native-omp.zh-CN.md](./docs/native-omp.zh-CN.md). It records protocol differences, data isolation, and rollout status.

Runtime checks require explicit task-specific user authorization. Source edits do not authorize tests, typechecks, starting OMP, model requests, dependency installation, builds, deployment synchronization, or service restarts. Request each necessary operation/target separately. Existing production `.next` files may serve the active web client; do not overwrite them merely to verify code.

## Architecture

```text
Browser                    Next.js                       Selected local engine
POST /api/agent/new   →     startRpcSession(engine)  →     omp --mode rpc-ui / Pi --mode rpc
POST /api/agent/[id]  →     pinned session adapter   →     stdin JSONL
GET .../[id]/events   ←     engine event adapter     ←     stdout JSONL
GET /api/sessions    →      read-only files from separate agent directories
GET /api/models     →      cache keyed by engine + cwd → ephemeral native RPC query
```

- `lib/agent-rpc-client.ts` owns executable selection, argv/env, stdio, correlation, OMP protocol-v2 chunks, timeouts and shutdown. OMP uses `OMP_WEB_EXECUTABLE`; Pi uses `OMP_WEB_PI_EXECUTABLE` or `pi` from the service PATH, matching the terminal installation. Do not substitute the older SDK dependency: provider/OAuth support can differ despite a shared data directory. Failure is explicit; neither engine falls back to another installation.
- `lib/rpc-manager.ts` owns the shared session registry and selects the native engine adapter. Global registries use `__ompWeb*`; concurrent starts with the same key share a promise.
- `lib/session-reader.ts` provides a read-only structural view of both stores. Pure Pi history helpers remain for display compatibility, not in-process model/tool execution.
- `hooks/useAgentSession.ts` owns browser streaming/reconciliation, optimistic messages, queues and dialogs.
- `components/ChatWindow.tsx` renders chat; `components/ChatInput.tsx` owns input, attachments and the native command palette.
- `lib/agent-client.ts` is the typed fetch helper for agent commands.

## Protocol invariants

- Split stdio records only at LF, not arbitrary Unicode line separators. Preserve UTF-8 across byte chunks. For OMP v2, validate chunk identity/order/size and never dispatch a partial logical frame. Pi uses plain JSONL and has no OMP `ready` handshake.
- Correlate responses by generated IDs. `extension_ui_response` uses the original dialog ID and receives no command response.
- Completion is engine-specific: OMP `prompt_result` completes its accepted prompt; Pi's prompt response has its own lifecycle. Use each engine's settled event after queued work/retries/compaction; `agent_end` alone does not mean idle.
- A late state snapshot or old prompt completion must not settle a newer run. Preserve the browser's monotonic run-ID checks.
- OMP RPC `systemPrompt` is a list of blocks; join it for web display. Do not invent prompt/tool metadata that Pi RPC does not expose.
- Context usage is native only: OMP `get_state`, Pi `get_session_stats` (its `get_state` has none), Claude `getContextUsage({ detail: "summary" })`, Codex `thread/tokenUsage/updated` `last`. Never estimate it from transcript usage. See [Claude Code context](./docs/claude-code-context.zh-CN.md).
- Claude Code titles live in its native transcript (`ai-title`/`custom-title`, read via SDK `getSessionInfo().customTitle`); the web projection only stores web renames, which take precedence.
- Keep each engine's native tool/config/auth decisions. The old Pi `none/default/full` allow-list is not an OMP tool inventory. Stale tool-preset requests must not silently enable tools.
- OMP `rpc-ui` and Pi RPC enable supported tool dialogs. Startup dialogs arriving before a browser can attach are cancelled, never approved, and surfaced as warnings. Replay pending dialog requests on SSE reconnect; cancellations remove them.
- Ordinary shell commands use native RPC `bash`. OMP refuses `!!` because its RPC has no exclude-from-context field; Pi supports its own wire field. The embedded terminal is independent.
- Unsupported commands fail clearly, with unavailable actions hidden/disabled for the selected engine; never return fake success or substitute an engine.

## Session identity and storage

- `lib/engine.ts` owns web session keys: OMP IDs remain unchanged; Pi keys are `pi:<nativeId>`. Strip only at the native seam. Native headers and entry IDs are never rewritten or prefixed.
- New sessions default to OMP. The browser selector starts a new conversation; existing IDs pin the engine for resume, SSE, commands, history, export and forks. A client cannot relabel an existing session.
- `lib/engine-paths.ts` selects isolated stores. Pi uses `OMP_WEB_PI_AGENT_DIR` or `~/.pi/agent`, not the service's legacy `PI_CODING_AGENT_DIR` (which currently belongs to OMP). Do not copy credentials between engines or allow both stores to resolve to the same directory.

- Resume the selected engine by exact path, never by `--continue`. Each engine owns persistence; keep OMP's native session leases and never steal a terminal session.
- Message Fork means before that user entry: OMP `branch`, Pi `fork`. Whole-session Fork uses the engine's own supported operation. Identity changes must release the OLD registry key before returning the new, engine-qualified web ID.
- OMP `navigate_tree` is an in-file branch change, not a new file. Its wire field is `entryId`, while the web command uses `targetId`. OMP may move the leaf before durable append; expose the cached native leaf. Do not imply Pi RPC supports navigation when its protocol does not.
- Native title-slot records can precede the header. Preserve byte order and padding. GET/history/export must not rewrite the source file or construct a writable Pi SessionManager.
- Native `model_change` has a combined `provider/modelId` and optional role. Adapt only the default role for display; preserve node IDs/parents. `activeLeafId` can keep late usage entries off the active branch.
- Native titles and parent references can differ from Pi metadata; preserve original JSONL. File-path caches are bidirectional and must be invalidated after deletion/renaming.
- A session can have a file path before its first transcript flush. Keep the process identity authoritative during startup.

## Auth, models and project resources

Model discovery asks the selected engine using its own agent directory and the chat cwd. Never import OMP credentials into Pi ModelRuntime or share model caches/explicit choices across engines. Project resources may execute during native initialization, including catalog queries.

Legacy auth/model-config/plugin/skill editors remain blocked in `proxy.ts`: their process-global stores are not engine-scoped. Settings instructions name the selected CLI and directory. Pi project trust uses its real `ProjectTrustStore` in the Pi directory; OMP's trust semantics remain native and separate.

The frontend shows the active engine, not a Pi dependency version under an OMP label. OMP update/restart controls affect only the OMP installation.

## Browser lifecycle

- Connect SSE before sending a prompt. The initial `connected` frame confirms the listener is attached.
- A prompt can span retries, compaction and background work. Keep SSE until actual quiescence, with an idle grace period for reconnects.
- Poll agent state while active and reconcile on visibility/online events. Ignore late SSE or polling data from previous runs.
- Normalize tool-call field names in `lib/normalize.ts`: stored `{ id, name, arguments }` versus UI `{ toolCallId, toolName, input }`.
- `entryIds` and displayed history messages must stay parallel for Fork/navigation targets.
- Long history is folded per user turn (`lib/history-turns.ts`): recent turns load whole, older turns are outlined rows that fetch the whole turn on expand. Never split a turn, and never reintroduce per-message placeholders or "load more" paging. See [history cache](./docs/history-cache.zh-CN.md).
- OMP `manual_compaction_start/end` maps to web `compaction_start/end`; Pi's supported events are adapted separately. Auto-compaction must remain busy until the engine settles.
- Browser prompts may arrive concurrently from tools/subagents. Keep dialog IDs and queue pending dialogs rather than losing earlier ones.
- Completion audio requires a user gesture; preserve `useAudio` unlock behavior.

## Files, worktrees, terminal and uploads

- `/api/files` is allow-list based, not unrestricted file browsing. Roots derive from session cwd, resolved main repo roots, and explicitly registered directories. New-session/cwd/worktree operations update `allowFileRoot()`.
- `lib/worktree.ts` groups linked worktrees by main `projectRoot`. Dirty removal returns 409 so the user can decide whether to force it.
- Session trees are projected to shallow UI structures in the session route; avoid recursive operations over arbitrarily deep histories.
- The embedded terminal uses its own registry/stream endpoints and can run independently of chat. Its security switches must not disable agent RPC accidentally. A browser shell preference is only a request: `lib/terminal-shells.ts` spawns an `/etc/shells` entry or its automatic default, resolved once at creation; reattaching keeps the running shell.
- Preserve local upload work in `ChatInput`, `useDragDrop`, `file-upload-limits` and the files route. Image attachments and persisted ordinary files have different limits/handling.
- A long text paste (`lib/pasted-text.ts`) is a `[paste #n …]` marker in the composer, never inline text. Sending expands it inside `<pasted-text>` so the transcript folds it into an attachment; `!`/`/` command drafts expand verbatim. Every view of user text (bubble, outline, minimap, queue, input history) goes through that module — do not print the raw wrapper or the pasted body.
- The Next proxy bypasses `/events`; SSE routes must enforce their own authentication/origin checks before exposing data or starting processes.
- Web login is mandatory (no anonymous mode, no Basic Auth prompt). `bin/web-credentials.js` owns the credentials file and signed session tokens; `lib/web-auth.ts` checks the `omp_web_session` cookie. Guards return `webAuthRequired()` (401 + `X-OMP-Web-Auth`) so the browser redirects to `/login`; never send `WWW-Authenticate`.

## Source map and checks

Main routes are under `app/api/agent`, `app/api/sessions`, `app/api/models`, `app/api/files`, and `app/api/worktrees`. HTML export delegates to the session's pinned engine and cleans up a private temporary output directory.

`lib/omp-rpc.test.mjs` uses fake processes and temporary files; it must not call a real engine or model. Runtime verification is task-specific: source changes do not reuse a previous feature's test/build/deploy permission. When authorized, use existing dependencies; missing prerequisites do not authorize installation.

## Styling

Use existing CSS variables: `--bg`, `--bg-panel`, `--bg-hover`, `--bg-selected`, `--text`, `--text-muted`, `--text-dim`, `--accent`, `--border`, `--font-mono`. Preserve the existing mobile/desktop panel behavior and i18n conventions.
