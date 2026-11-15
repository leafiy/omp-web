"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useI18n } from "@/hooks/useI18n";
import { TERMINAL_MAX_INPUT, type TerminalEvent, type TerminalInfo, type TerminalLaunch } from "@/lib/terminal-contract";
import type { TerminalStatus } from "./TerminalPanel";
import styles from "./TerminalPanel.module.css";

type Props = { id: string; cwd: string; launch: TerminalLaunch; onStatus: (status: TerminalStatus) => void };

function shellLabel(terminal: TerminalInfo): string {
  return `${terminal.shell.split(/[\\/]/).pop()}${terminal.login ? " -l" : ""}`;
}

export default function TerminalViewport({ id, cwd, launch, onStatus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const translate = useRef(t);
  translate.current = t;
  // Read at creation only: changing the preference must not restart this shell.
  const launchRef = useRef(launch);
  launchRef.current = launch;

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const abort = new AbortController();
    let disposed = false;
    let connected = false;
    let exited = false;
    let source: EventSource | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let queue = Promise.resolve();
    let queuedInput = 0;
    let pendingOutput = 0;
    let inputEpoch = 0;
    let replayTruncated = false;
    function readTerminalTheme() {
      const root = document.documentElement;
      // Preserve the existing light-mode terminal. Dark palettes follow the
      // workbench without reconnecting or recreating the running shell.
      if (!root.classList.contains("dark") && !root.classList.contains("starfield")) {
        return { background: "#161b22", foreground: "#e6edf3", cursor: "#e6edf3" };
      }
      const css = getComputedStyle(host!);
      const color = (name: string) => css.getPropertyValue(name).trim();
      return {
        background: color("--bg-panel"), foreground: color("--text"),
        cursor: color("--accent"), cursorAccent: color("--bg-panel"),
        selectionBackground: color("--selection-bg"),
        ...(root.classList.contains("starfield") ? {
          // Tokyo Night ANSI palette; brighter normal text for web readability.
          black: "#363b54", red: "#f7768e", green: "#73daca", yellow: "#e0af68",
          blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
          brightBlack: "#929bbd", brightRed: "#f7768e", brightGreen: "#73daca",
          brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
          brightCyan: "#7dcfff", brightWhite: "#c0caf5",
        } : {}),
      };
    }
    const terminal = new Terminal({
      cursorBlink: true, fontSize: 13,
      fontFamily: getComputedStyle(host).getPropertyValue("--font-mono").trim() || "monospace",
      scrollback: 3000, disableStdin: true,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    function fitTerminal() {
      if (disposed || host!.clientWidth < 40 || host!.clientHeight < 40) return;
      fit.fit();
      // Match the server's size bounds even on very large monitors.
      if (terminal.cols > 500 || terminal.rows > 300) terminal.resize(Math.min(500, terminal.cols), Math.min(300, terminal.rows));
    }
    fitTerminal();

    function fail(error: unknown) {
      if (disposed) return;
      connected = false;
      inputEpoch++;
      terminal.options.disableStdin = true;
      source?.close();
      onStatus({ state: "error", detail: error instanceof Error ? error.message : String(error) });
    }

    async function post(url: string, body: unknown) {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: abort.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Terminal HTTP ${response.status}`);
      }
    }

    function enqueue(body: unknown, inputLength = 0) {
      queuedInput += inputLength;
      const epoch = inputEpoch;
      // Never retry input automatically: a lost HTTP response does not mean
      // the command was not executed. Preserve key/paste ordering instead.
      queue = queue.then(async () => {
        if (!disposed && connected && epoch === inputEpoch) await post(`/api/terminal/${id}`, body);
      }).catch(fail).finally(() => { queuedInput -= inputLength; });
    }

    const input = terminal.onData((data) => {
      if (!connected || exited) return;
      if (queuedInput + data.length > 256 * 1024) {
        fail(new Error(translate.current("terminal.inputOverflow")));
        return;
      }
      for (let i = 0; i < data.length; i += TERMINAL_MAX_INPUT) {
        const chunk = data.slice(i, i + TERMINAL_MAX_INPUT);
        enqueue({ type: "input", data: chunk }, chunk.length);
      }
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (connected && !exited) enqueue({ type: "resize", cols, rows });
      }, 100);
    });
    const observer = new ResizeObserver(() => {
      fitTerminal();
    });
    observer.observe(host);

    void post("/api/terminal", { ...launchRef.current, id, cwd, cols: terminal.cols, rows: terminal.rows }).then(() => {
      if (disposed) return;
      source = new EventSource(`/api/terminal/${id}/events`);
      source.onmessage = (message) => {
        if (disposed) return;
        try {
          const event = JSON.parse(message.data) as TerminalEvent;
          if (event.type === "output") {
            pendingOutput += event.data.length;
            if (pendingOutput > 1024 * 1024) {
              fail(new Error(translate.current("terminal.outputOverflow")));
              return;
            }
            terminal.write(event.data, () => { pendingOutput -= event.data.length; });
          } else if (event.type === "reset") {
            // Queue reset behind earlier writes, rather than corrupting an
            // in-flight parser batch after an SSE replay gap.
            terminal.write("\x1bc");
            replayTruncated = true;
            onStatus({ state: "connecting", detail: translate.current("terminal.replayTruncated") });
          } else if (event.type === "exit") {
            exited = true;
            connected = false;
            terminal.options.disableStdin = true;
            source?.close();
            onStatus({ state: "exited", detail: `${translate.current("terminal.exitCode")}: ${event.exitCode}` });
          } else if (event.type === "ready") {
            // Ignore terminal-generated replies while replay is being parsed.
            const epoch = inputEpoch;
            terminal.write("", () => {
              if (disposed || exited || epoch !== inputEpoch) return;
              connected = event.terminal.alive;
              terminal.options.disableStdin = !connected;
              onStatus({
                state: connected ? "connected" : "exited",
                detail: replayTruncated ? translate.current("terminal.replayTruncated") : undefined,
                shell: shellLabel(event.terminal),
              });
              if (connected) {
                fitTerminal();
                enqueue({ type: "resize", cols: terminal.cols, rows: terminal.rows });
                terminal.focus();
              } else source?.close();
            });
          }
        } catch (error) { fail(error); }
      };
      source.onerror = () => {
        if (disposed || exited) return;
        connected = false;
        inputEpoch++;
        terminal.options.disableStdin = true;
        onStatus({ state: "disconnected", detail: queuedInput > 0 ? translate.current("terminal.inputInterrupted") : undefined });
        // EventSource reconnects with Last-Event-ID; the server only replays
        // missing frames, not commands or already-rendered output.
      };
    }).catch(fail);

    return () => {
      disposed = true;
      connected = false;
      abort.abort();
      source?.close();
      clearTimeout(resizeTimer);
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
      // Detach only. Hiding/switching/refreshing must not kill the shell.
    };
  }, [id, cwd, onStatus]);

  return <div ref={container} className={styles.viewport} data-terminal="true"
    onKeyDown={(event) => event.stopPropagation()} aria-label={t("terminal.input")} />;
}
