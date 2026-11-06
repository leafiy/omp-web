"use strict";
const fs = require("node:fs");
const path = require("node:path");
let cached;

/** Web access secret only. Never use an agent's config or credential store. */
function loadWebPassword(env = process.env) {
  const direct = env.PI_WEB_PASSWORD;
  const file = env.PI_WEB_PASSWORD_FILE;
  if (direct && file) throw new Error("Configure PI_WEB_PASSWORD or PI_WEB_PASSWORD_FILE, not both.");
  if (!file) {
    if (!direct && env.OMP_WEB_REQUIRE_PASSWORD === "1") throw new Error("This deployment requires a web access password.");
    return direct || undefined;
  }
  if (!path.isAbsolute(file)) throw new Error("Web password file must be an absolute path.");
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("not a regular file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077)) || stat.size > 4096 || stat.size === 0) {
      throw new Error("invalid password file");
    }
    const identity = [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    if (cached?.identity === identity) return cached.password;
    const buffer = Buffer.alloc(4097);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) throw new Error("oversized password file");
    const password = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)).replace(/\r?\n$/, "");
    if (!password || /[\r\n\0]/.test(password)) throw new Error("invalid password content");
    cached = { identity, password };
    return password;
  } catch {
    // Fail closed. A missing/unreadable secret must NEVER disable authentication.
    throw new Error("Cannot load web access password: use a private regular file (0600) containing one nonempty line.");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { loadWebPassword };
