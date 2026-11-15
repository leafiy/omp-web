import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";
import { useTestWebLogin } from "./web-auth-test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST, GET } = await jiti.import("../app/api/files/[...path]/route.ts");

async function fixture(t) {
  const { cookie } = await useTestWebLogin(t);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-chat-files-http-"));
  const root = path.join(base, "allowed");
  await fs.mkdir(root);
  const previous = globalThis.__ompAllowedRootsCache;
  // No discovery of real sessions/credentials or native executable is needed.
  globalThis.__ompAllowedRootsCache = { roots: new Set([root]), expiresAt: Infinity };
  t.after(async () => {
    globalThis.__ompAllowedRootsCache = previous;
    await fs.rm(base, { recursive: true, force: true });
  });
  const segments = target => target.split(path.sep).filter(Boolean);
  const request = (target, type, options = {}) => new NextRequest(
    `http://localhost/api/files/${segments(target).map(encodeURIComponent).join("/")}?type=${type}`,
    { headers: { host: "localhost", cookie }, ...options },
  );
  const post = (target, entries, type = "attachment", headers) => {
    const body = new FormData();
    for (const [name, content] of entries) body.append("files", new File([content], name));
    return POST(request(target, type, { method: "POST", body, ...(headers ? { headers: { host: "localhost", ...headers } } : {}) }), { params: Promise.resolve({ path: segments(target) }) });
  };
  const download = target => GET(request(target, "download"), { params: Promise.resolve({ path: segments(target) }) });
  return { base, root, cookie, post, download };
}

test("chat upload/remove/re-paste returns independent file cards; sidebar conflicts still require a decision", async t => {
  const { root, post, download } = await fixture(t);
  await fs.writeFile(path.join(root, "review.csv"), "project file");
  const firstReply = await post(root, [["review.csv", "first paste"]]);
  assert.equal(firstReply.status, 200);
  const first = (await firstReply.json()).attachments[0];
  assert.equal(first.name, "review.csv");
  assert.equal(first.size, 11);
  // Removing a draft card does not remove the saved file (an older message may use it).
  const secondReply = await post(root, [["review.csv", "second paste"], ["review.csv", "third paste"]]);
  assert.equal(secondReply.status, 200);
  const { attachments } = await secondReply.json();
  assert.equal(new Set([first.path, ...attachments.map(file => file.path)]).size, 3);
  assert.equal(await fs.readFile(first.path, "utf8"), "first paste");
  assert.equal(await (await download(attachments[0].path)).text(), "second paste");
  assert.equal(await fs.readFile(path.join(root, "review.csv"), "utf8"), "project file");
  assert.equal((await post(root, [["review.csv", "overwrite?"]], "upload")).status, 409);
});

test("attachment paths remain downloadable when the allowed cwd is a symlink", async t => {
  const { base, root, post, download } = await fixture(t);
  const alias = path.join(base, "alias");
  await fs.symlink(root, alias, "dir");
  globalThis.__ompAllowedRootsCache.roots = new Set([alias]);
  const reply = await post(alias, [["review.csv", "contents"]]);
  assert.equal(reply.status, 200);
  const [file] = (await reply.json()).attachments;
  assert.ok(file.path.startsWith(alias + path.sep));
  const response = await download(file.path);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "contents");
});

test("attachment uploads retain login, origin and allowed-root guards", async t => {
  const { base, root, cookie, post } = await fixture(t);
  const entries = [["review.csv", "do not write"]];
  assert.equal((await post(root, entries, "attachment", {})).status, 401);
  assert.equal((await post(root, entries, "attachment", { cookie, origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await post(base, entries)).status, 403);
  await fs.symlink(base, path.join(root, "escape"), "dir");
  assert.equal((await post(path.join(root, "escape"), entries)).status, 403);
  assert.deepEqual(await fs.readdir(root), ["escape"]);
});
