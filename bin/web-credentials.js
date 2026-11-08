"use strict";
// Web access credentials and signed browser sessions. Shared by the launcher
// CLI, the Next proxy/routes and tests. Never use an agent's credential store.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { loadWebPassword } = require("./web-password");

const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MAX_USERNAME_LENGTH = 64;
const LEGACY_USERNAME = "pi";
const SESSION_COOKIE = "omp_web_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_FILE_SIZE = 16 * 1024;

let cached;

/** Absolute path of the credentials file. Not inside the Git workspace. */
function credentialsPath(env = process.env) {
  const configured = env.OMP_WEB_AUTH_FILE && env.OMP_WEB_AUTH_FILE.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("OMP_WEB_AUTH_FILE must be an absolute path.");
    return configured;
  }
  return path.join(os.homedir(), ".config", "omp-web", "credentials.json");
}

/** Returns an error message, or null when the username is acceptable. */
function validateUsername(username) {
  if (typeof username !== "string" || !username) return "Username is required.";
  if (username.length > MAX_USERNAME_LENGTH) return `Username must be at most ${MAX_USERNAME_LENGTH} characters.`;
  if (!/^[\p{L}\p{N}._@-]+$/u.test(username)) return "Username may contain letters, digits, '.', '_', '@' and '-' only.";
  return null;
}

/** Returns an error message, or null when the password is acceptable. */
function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (/[\0\r\n]/.test(password)) return "Password must not contain line breaks or NUL characters.";
  return null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of arbitrary-length strings. */
function secretsEqual(actual, expected) {
  return crypto.timingSafeEqual(sha256(String(actual)), sha256(String(expected)));
}

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

function isBase64(value) {
  return typeof value === "string" && value.length > 0 && Buffer.from(value, "base64").toString("base64") === value;
}

function parseRecord(text) {
  const record = JSON.parse(text);
  const hash = record && record.password;
  const valid = record && typeof record === "object" && record.version === 1
    && validateUsername(record.username) === null
    && hash && hash.algorithm === "scrypt"
    && Number.isInteger(hash.N) && hash.N >= 1024 && hash.N <= 1 << 20 && (hash.N & (hash.N - 1)) === 0
    && Number.isInteger(hash.r) && hash.r >= 1 && hash.r <= 32
    && Number.isInteger(hash.p) && hash.p >= 1 && hash.p <= 16
    && isBase64(hash.salt) && isBase64(hash.hash)
    && isBase64(record.sessionSecret) && Buffer.from(record.sessionSecret, "base64").length >= 32;
  if (!valid) throw new Error("invalid credentials record");
  return record;
}

function readCredentialFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read web credentials file ${file}.`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077)) || stat.size === 0 || stat.size > MAX_FILE_SIZE) {
      throw new Error("invalid credentials file");
    }
    const identity = [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    if (cached && cached.identity === identity) return cached.credentials;
    const buffer = Buffer.alloc(MAX_FILE_SIZE + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const record = parseRecord(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
    const credentials = Object.freeze({
      source: "file",
      file,
      username: record.username,
      secret: Buffer.from(record.sessionSecret, "base64"),
      hash: Object.freeze({ N: record.password.N, r: record.password.r, p: record.password.p, salt: record.password.salt, hash: record.password.hash }),
    });
    cached = { identity, credentials };
    return credentials;
  } catch {
    // Fail closed: a damaged or public file must never disable authentication.
    throw new Error(`Invalid web credentials file ${file}: it must be a private (0600) regular file written by \`omp-web passwd\`.`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Current web credentials, or undefined when none are configured.
 * The credentials file wins; the legacy PI_WEB_PASSWORD(_FILE) secret is a
 * read-only fallback (username OMP_WEB_USERNAME or "pi"). Throws when a
 * configured source is invalid.
 */
function loadWebCredentials(env = process.env) {
  const file = credentialsPath(env);
  const stored = readCredentialFile(file);
  if (stored) return stored;
  // Login is always required now; the old "require password" flag is moot.
  const legacyPassword = loadWebPassword({ ...env, OMP_WEB_REQUIRE_PASSWORD: undefined });
  if (!legacyPassword) return undefined;
  const username = (env.OMP_WEB_USERNAME && env.OMP_WEB_USERNAME.trim()) || LEGACY_USERNAME;
  if (validateUsername(username)) throw new Error("OMP_WEB_USERNAME is not a valid username.");
  return Object.freeze({
    source: "legacy",
    file,
    username,
    secret: crypto.createHmac("sha256", "omp-web-legacy-session").update(legacyPassword, "utf8").digest(),
    legacyPassword,
  });
}

/** Verifies a username/password pair against the configured credentials. */
async function verifyWebLogin(credentials, username, password) {
  if (!credentials || typeof username !== "string" || typeof password !== "string") return false;
  if (password.length > MAX_PASSWORD_LENGTH || username.length > MAX_USERNAME_LENGTH) return false;
  const usernameMatches = secretsEqual(username, credentials.username);
  let passwordMatches;
  if (credentials.source === "legacy") {
    passwordMatches = secretsEqual(password, credentials.legacyPassword);
  } else {
    const expected = Buffer.from(credentials.hash.hash, "base64");
    const actual = await scrypt(password, Buffer.from(credentials.hash.salt, "base64"), { ...credentials.hash, keylen: expected.length });
    passwordMatches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  return usernameMatches && passwordMatches;
}

/**
 * Writes new credentials atomically (0600) and rotates the session secret,
 * which signs out every existing browser session.
 */
async function setWebCredentials(username, password, env = process.env) {
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(passwordError);
  const file = credentialsPath(env);
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_PARAMS);
  const record = {
    version: 1,
    username,
    password: { algorithm: "scrypt", N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, salt: salt.toString("base64"), hash: hash.toString("base64") },
    sessionSecret: crypto.randomBytes(32).toString("base64"),
    updatedAt: new Date().toISOString(),
  };
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* not created */ }
    throw error;
  }
  cached = undefined;
  return file;
}

function sign(secret, data) {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

/** Creates a signed, expiring session token bound to the current username. */
function createSessionToken(credentials, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1, u: credentials.username, iat: issued, exp: issued + SESSION_MAX_AGE_SECONDS,
    n: crypto.randomBytes(12).toString("base64url"),
  }), "utf8").toString("base64url");
  return `${payload}.${sign(credentials.secret, payload)}`;
}

/** Returns the token payload when valid for the current credentials, else null. */
function verifySessionToken(token, credentials, now = Date.now()) {
  if (!credentials || typeof token !== "string" || token.length > 1024) return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(credentials.secret, payload), "base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!data || data.v !== 1 || typeof data.n !== "string" || !Number.isInteger(data.exp) || !Number.isInteger(data.iat)) return null;
  if (data.exp * 1000 <= now || !secretsEqual(data.u, credentials.username)) return null;
  return data;
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  MIN_PASSWORD_LENGTH,
  credentialsPath,
  validateUsername,
  validatePassword,
  loadWebCredentials,
  verifyWebLogin,
  setWebCredentials,
  createSessionToken,
  verifySessionToken,
};
