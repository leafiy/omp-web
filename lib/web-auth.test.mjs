import assert from "node:assert/strict";
import { chmod, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { useNoWebLogin, useTestWebLogin } from "./web-auth-test-helper.mjs";

const jiti = createJiti(import.meta.url);
const auth = await jiti.import("./web-auth.ts");
const credentials = await jiti.import("../bin/web-credentials.js");
const request = (headers = {}, url = "http://localhost/api/engines") => new Request(url, { headers: { host: "localhost", ...headers } });

test("without configured credentials nothing is authenticated", async (t) => {
  await useNoWebLogin(t);
  assert.equal(auth.isRequestAuthenticated(request()), false);
  assert.equal(auth.readWebCredentials(), undefined);
});

test("only a valid session cookie authenticates", async (t) => {
  const { cookie } = await useTestWebLogin(t);
  assert.equal(auth.isRequestAuthenticated(request()), false);
  assert.equal(auth.isRequestAuthenticated(request({ cookie })), true);
  assert.equal(auth.isRequestAuthenticated(request({ cookie: `other=1; ${cookie}; theme=dark` })), true);
  assert.equal(auth.isRequestAuthenticated(request({ cookie: `${cookie}x` })), false);
  assert.equal(auth.isRequestAuthenticated(request({ authorization: `Basic ${Buffer.from("tester:test-only-password").toString("base64")}` })), false);
  assert.equal(auth.authenticatedUsername(request({ cookie })), "tester");
});

test("credentials are stored hashed in a private file and rotation signs out old sessions", async (t) => {
  const { cookie, file } = await useTestWebLogin(t, { username: "alice", password: "first-password" });
  const text = await readFile(file, "utf8");
  assert.equal(text.includes("first-password"), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const current = credentials.loadWebCredentials();
  assert.equal(await credentials.verifyWebLogin(current, "alice", "first-password"), true);
  assert.equal(await credentials.verifyWebLogin(current, "alice", "wrong-password"), false);
  assert.equal(await credentials.verifyWebLogin(current, "bob", "first-password"), false);
  await credentials.setWebCredentials("bob", "second-password");
  assert.equal(auth.isRequestAuthenticated(request({ cookie })), false);
  const updated = credentials.loadWebCredentials();
  assert.equal(updated.username, "bob");
  assert.equal(await credentials.verifyWebLogin(updated, "bob", "second-password"), true);
});

test("a public or damaged credentials file fails closed", async (t) => {
  const { cookie, file } = await useTestWebLogin(t);
  await chmod(file, 0o644);
  assert.throws(() => credentials.loadWebCredentials(), /private/);
  assert.equal(auth.isRequestAuthenticated(request({ cookie })), false);
});

test("logout revokes the token; expired or forged tokens are rejected", async (t) => {
  const { cookie } = await useTestWebLogin(t);
  const current = credentials.loadWebCredentials();
  const expired = credentials.createSessionToken(current, Date.now() - 31 * 24 * 60 * 60 * 1000);
  assert.equal(credentials.verifySessionToken(expired, current), null);
  const [payload, signature] = cookie.split("=")[1].split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), u: "root" })).toString("base64url");
  assert.equal(credentials.verifySessionToken(`${forged}.${signature}`, current), null);
  auth.revokeRequestSession(request({ cookie }));
  assert.equal(auth.isRequestAuthenticated(request({ cookie })), false);
});

test("401 responses never trigger a browser Basic Auth prompt", () => {
  const response = auth.webAuthRequired({ "Cache-Control": "no-store" }, true);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal(response.headers.get(auth.WEB_AUTH_HEADER), "required");
});

test("session cookies are HttpOnly and Secure behind HTTPS", async (t) => {
  await useTestWebLogin(t);
  const current = credentials.loadWebCredentials();
  const plain = auth.createSessionCookie(request(), current);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(auth.createSessionCookie(request({ "x-forwarded-proto": "https" }), current), /; Secure/);
});

test("username and password rules", () => {
  assert.equal(credentials.validateUsername("admin"), null);
  assert.notEqual(credentials.validateUsername("a:b"), null);
  assert.notEqual(credentials.validateUsername(""), null);
  assert.notEqual(credentials.validatePassword("short"), null);
  assert.notEqual(credentials.validatePassword("long enough\npassword"), null);
  assert.equal(credentials.validatePassword("long enough password"), null);
});
