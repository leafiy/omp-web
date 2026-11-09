"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

/** This fork has one checkout per service account, shared by dev/build/runtime. */
function assertWorkspaceLocation(root, home = os.homedir()) {
  const expected = path.join(home, "code", "omp-web");
  if (fs.realpathSync(root) !== expected) {
    throw new Error(`omp-web must be developed, built and run from ${expected}`);
  }
  for (const name of ["node_modules", ".next"]) {
    const entry = path.join(expected, name);
    let stat;
    try { stat = fs.lstatSync(entry); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(entry) !== entry) {
      throw new Error(`${entry} must be stored in the canonical workspace, not linked to another release`);
    }
  }
  return expected;
}

/** Label of the macOS LaunchAgent written by scripts/install.sh. */
const LAUNCHD_LABEL = "io.github.leafiy.omp-web";
const SERVICE_RUNNING = "Stop omp-web.service before building or running a development/second server in its workspace";

function assertServiceStopped() {
  // No service manager means no managed production instance to guard. This is
  // an operational safety check, not a security boundary against the OS owner.
  if (process.platform === "darwin") {
    let state;
    try {
      state = execFileSync("launchctl", ["print", `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    } catch { return; } // Not loaded.
    if (/^\s*pid = \d+/m.test(state)) throw new Error(SERVICE_RUNNING.replace("omp-web.service", `the launchd agent ${LAUNCHD_LABEL}`));
    return;
  }
  if (!fs.existsSync("/run/systemd/system")) return;
  const pid = execFileSync("systemctl", ["show", "omp-web.service", "--property=MainPID", "--value"], { encoding: "utf8", timeout: 5000 }).trim();
  if (pid !== "0" && pid !== "") throw new Error(SERVICE_RUNNING);
}

if (require.main === module) {
  try {
    assertWorkspaceLocation(path.join(__dirname, ".."));
    if (process.argv.includes("--offline")) assertServiceStopped();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { assertWorkspaceLocation, assertServiceStopped };
