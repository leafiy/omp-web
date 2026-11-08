#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runPasswd, hasWebCredentials } = require("./web-credentials-cli");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./omp-web-options");

async function startServer() {
  const pkgDir = path.join(__dirname, "..");
  try { require("./workspace-location").assertWorkspaceLocation(pkgDir); }
  catch (error) { console.error(error.message); process.exit(1); }
  const nextDir = path.join(pkgDir, ".next");

  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  let nextBin;
  try {
    nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
  } catch {
    // Fallback: locate next package root and derive the bin path manually.
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
      nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
    }
  }

  const { port, hostname, openBrowser } = parseLaunchOptions();
  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  // A login is mandatory; there is no unauthenticated mode.
  let credentialsConfigured;
  try { credentialsConfigured = hasWebCredentials(); }
  catch (error) { console.error(error.message); process.exit(1); }

  if (!fs.existsSync(nextDir)) {
    console.error("Build artifacts not found. Stop the web service and run `npm run build` in ~/code/omp-web.");
    process.exit(1);
  }

  if (!loopbackHostnames.has(hostname)) {
    console.warn(
      `Warning: omp-web is listening on ${hostname} over plain HTTP. Use HTTPS or a trusted VPN to protect the login in transit.`,
    );
  }

  if (!credentialsConfigured) {
    if (!process.stdin.isTTY) {
      console.error("No web login is configured. Run `node bin/omp-web.js passwd` in ~/code/omp-web first.");
      process.exit(1);
    }
    console.error("No web login is configured yet.");
    await runPasswd([]);
  }

  const nextArgs = ["start", "-p", port];
  nextArgs.push("-H", hostname);

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, [nextBin, ...nextArgs], {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PI_WEB_HOSTNAME: hostname, OMP_WEB_APP_DIR: pkgDir },
  });

  let browserOpened = false;
  const url = `http://${hostname}:${port}`;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (text.includes("Ready")) {
      console.log(`\n> OMP Web is ready at ${url}\n`);
    }
    if (openBrowser && !browserOpened && text.includes("Ready")) {
      browserOpened = true;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
      const opener = spawn(openCmd, [url], {
        shell: isWindows,
        stdio: "ignore",
        detached: true,
      });

      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });

      opener.unref();
    }
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[2] === "passwd") {
  runPasswd(process.argv.slice(3)).then(
    () => process.exit(0),
    (error) => { console.error(error.message); process.exit(1); },
  );
} else {
  startServer().catch((error) => { console.error(error.message); process.exit(1); });
}
