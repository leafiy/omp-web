"use strict";
// `omp-web passwd`: set the web login username and password.
const readline = require("node:readline");
const { parseArgs } = require("node:util");
const {
  MIN_PASSWORD_LENGTH, credentialsPath, loadWebCredentials, setWebCredentials, validatePassword, validateUsername,
} = require("./web-credentials");

function ask(question, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.question(defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(`${question}: `);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const cleanup = () => { input.removeListener("data", onData); input.setRawMode(false); input.pause(); process.stderr.write("\n"); };
    function onData(chunk) {
      if (chunk.startsWith("\x1b")) return; // arrow keys and other escape sequences
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\x04") { cleanup(); resolve(value); return; }
        if (ch === "\x03") { cleanup(); reject(new Error("Cancelled.")); return; }
        if (ch === "\x7f" || ch === "\b") { value = Array.from(value).slice(0, -1).join(""); continue; }
        if (ch >= " ") value += ch;
      }
    }
    input.on("data", onData);
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; if (data.length > 4096) reject(new Error("Input too large.")); });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function currentUsername() {
  try { return loadWebCredentials()?.username; } catch { return undefined; }
}

/**
 * Interactive on a TTY. Otherwise reads the password from the first stdin
 * line and the username from --username / OMP_WEB_USERNAME.
 */
async function runPasswd(args = []) {
  const { values } = parseArgs({ args, options: { username: { type: "string", short: "u" } }, strict: true, allowPositionals: false });
  let username = values.username ?? process.env.OMP_WEB_USERNAME?.trim();
  let password;
  if (process.stdin.isTTY) {
    console.error(`Set the omp-web login (stored as a salted hash in ${credentialsPath()}).`);
    for (;;) {
      username = username || await ask("Username", currentUsername() || "admin");
      const problem = validateUsername(username);
      if (!problem) break;
      console.error(problem);
      username = undefined;
    }
    for (;;) {
      password = await askHidden(`Password (min. ${MIN_PASSWORD_LENGTH} characters)`);
      const problem = validatePassword(password);
      if (problem) { console.error(problem); continue; }
      if (await askHidden("Confirm password") === password) break;
      console.error("Passwords do not match.");
    }
  } else {
    username = username || currentUsername();
    if (!username) throw new Error("Pass --username (or OMP_WEB_USERNAME) when the password is piped on stdin.");
    password = (await readStdin()).split(/\r?\n/, 1)[0];
    const problem = validateUsername(username) || validatePassword(password);
    if (problem) throw new Error(problem);
  }
  const file = await setWebCredentials(username, password);
  console.error(`Saved web credentials for "${username}" to ${file}. Existing browser sessions are signed out.`);
}

/** True when credentials exist (or a valid legacy password is configured). */
function hasWebCredentials() {
  return Boolean(loadWebCredentials());
}

module.exports = { runPasswd, hasWebCredentials };
