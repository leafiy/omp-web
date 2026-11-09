import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { listTerminalShells, defaultTerminalShell, resolveTerminalLaunch, terminalShellCatalog } = await jiti.import("./terminal-shells.ts");

// Debian-like host: merged /usr, /bin/sh -> dash, rbash -> bash, nologin listed.
const REAL = {
  "/bin/sh": "/usr/bin/dash", "/usr/bin/sh": "/usr/bin/dash", "/usr/bin/dash": "/usr/bin/dash",
  "/bin/bash": "/usr/bin/bash", "/usr/bin/bash": "/usr/bin/bash", "/bin/rbash": "/usr/bin/bash",
  "/usr/bin/tmux": "/usr/bin/tmux", "/bin/zsh": "/usr/bin/zsh", "/usr/bin/zsh": "/usr/bin/zsh",
  "/usr/sbin/nologin": "/usr/sbin/nologin",
};
const SHELLS = "# /etc/shells: valid login shells\n/bin/sh\n/usr/bin/sh\n/bin/bash\n/bin/rbash\n/usr/bin/dash\n\n/usr/bin/tmux\n/bin/zsh\n/usr/bin/zsh\n/usr/sbin/nologin\n/opt/missing/fish\n";

function host({ env, account, shells = SHELLS, platform = "linux" } = {}) {
  return {
    platform,
    envShell: () => env,
    accountShell: () => account,
    shellsFile: () => shells,
    executable: (file) => REAL[file],
  };
}

test("lists /etc/shells once per real executable, skipping comments, missing files and nologin", () => {
  assert.deepEqual(listTerminalShells(host()), [
    { path: "/bin/sh", name: "sh", login: true },
    { path: "/bin/bash", name: "bash", login: true },
    { path: "/usr/bin/tmux", name: "tmux", login: false },
    { path: "/bin/zsh", name: "zsh", login: true },
  ]);
  assert.deepEqual(listTerminalShells(host({ platform: "win32" })), []);
  assert.deepEqual(listTerminalShells(host({ shells: "" })), []);
});

test("automatic shell follows $SHELL, then the account shell, never nologin", () => {
  assert.equal(defaultTerminalShell(host({ env: "/usr/bin/zsh", account: "/bin/bash" })).path, "/usr/bin/zsh");
  // systemd sets $SHELL from passwd, which is nologin for service accounts.
  assert.equal(defaultTerminalShell(host({ env: "/usr/sbin/nologin", account: "/usr/bin/zsh" })).path, "/usr/bin/zsh");
  assert.equal(defaultTerminalShell(host({ env: "/opt/missing/fish", account: undefined })).path, "/bin/bash");
  assert.equal(defaultTerminalShell(host({ env: "relative/zsh", account: "/usr/sbin/nologin" })).path, "/bin/bash");
  assert.equal(defaultTerminalShell(host({ platform: "win32" })).path, "powershell.exe");
  const catalog = terminalShellCatalog(host({ env: "/usr/bin/zsh" }));
  assert.deepEqual(catalog.defaultShell, { path: "/usr/bin/zsh", name: "zsh", login: true });
  assert.equal(catalog.shells.length, 4);
});

test("browser choices must be listed; -l applies only to shells that accept it", () => {
  const h = host({ env: "/usr/bin/zsh" });
  assert.deepEqual(resolveTerminalLaunch({}, h), { shell: "/usr/bin/zsh", args: [], login: false });
  assert.deepEqual(resolveTerminalLaunch({ login: true }, h), { shell: "/usr/bin/zsh", args: ["-l"], login: true });
  assert.deepEqual(resolveTerminalLaunch({ shell: "/bin/bash", login: true }, h), { shell: "/bin/bash", args: ["-l"], login: true });
  assert.deepEqual(resolveTerminalLaunch({ shell: "/usr/bin/tmux", login: true }, h), { shell: "/usr/bin/tmux", args: [], login: false });
  // Deduplicated aliases, unlisted programs and nologin are refused.
  for (const shell of ["/usr/bin/dash", "/bin/rbash", "/usr/bin/python3", "/usr/sbin/nologin", "/opt/missing/fish", "", "zsh"]) {
    assert.equal(resolveTerminalLaunch({ shell }, h), null, shell);
  }
});
