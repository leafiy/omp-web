import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const {
  createHtmlPreviewUrl,
  htmlPreviewContentType,
  htmlPreviewHeaders,
  htmlPreviewMime,
  isHtmlPreviewPath,
  resolveHtmlPreviewGrant,
  resolveHtmlPreviewTarget,
} = await jiti.import("./html-preview.ts");

const root = path.resolve("/srv/project");
const entry = path.join(root, "docs", "site", "index.html");

function fresh() {
  globalThis.__ompWebHtmlPreviewGrants = undefined;
}

function tokenOf(url) {
  return url.split("/")[2];
}

test("a preview URL keeps the entry path below the grant root and reuses a live grant", () => {
  fresh();
  const url = createHtmlPreviewUrl(entry, entry, root, 1_000);
  assert.match(url, /^\/html-preview\/[A-Za-z0-9_-]{32}\/docs\/site\/index\.html$/);
  assert.equal(createHtmlPreviewUrl(entry, entry, root, 2_000), url);

  const spaced = createHtmlPreviewUrl(path.join(root, "my page#1.html"), path.join(root, "my page#1.html"), root, 2_000);
  assert.match(spaced, /\/my%20page%231\.html$/);
  assert.throws(() => createHtmlPreviewUrl(path.resolve("/elsewhere/a.html"), "/elsewhere/a.html", root));
});

test("grants expire when idle and use extends them", () => {
  fresh();
  const token = tokenOf(createHtmlPreviewUrl(entry, entry, root, 0));
  assert.equal(resolveHtmlPreviewGrant("not-a-token"), null);
  assert.ok(resolveHtmlPreviewGrant(token, 59 * 60_000));
  assert.ok(resolveHtmlPreviewGrant(token, 118 * 60_000));
  assert.equal(resolveHtmlPreviewGrant(token, 180 * 60_000), null);
  assert.equal(resolveHtmlPreviewGrant(token, 0), null);
});

test("asset paths stay inside the root and skip hidden names outside the entry's own directory", () => {
  fresh();
  const grant = resolveHtmlPreviewGrant(tokenOf(createHtmlPreviewUrl(entry, entry, root, 0)), 0);
  const resolve = (...segments) => resolveHtmlPreviewTarget(grant, segments);

  assert.equal(resolve("docs", "site", "index.html"), entry);
  assert.equal(resolve("docs", "site", "style.css"), path.join(root, "docs", "site", "style.css"));
  assert.equal(resolve("assets", "logo.png"), path.join(root, "assets", "logo.png"));
  assert.equal(resolve("..", "secret.js"), null);
  assert.equal(resolve("docs", "..", "..", "etc", "passwd"), null);
  assert.equal(resolve(".git", "config"), null);
  assert.equal(resolve(".env"), null);
  assert.equal(resolve("docs", "site", ".cache", "x.js"), null);
  assert.equal(resolve("docs", "a/b.js"), null);
  assert.equal(resolve("docs", "a\0.js"), null);
  assert.equal(resolve(), null);

  const hiddenEntry = path.join(root, ".local", "report", "index.html");
  const hidden = resolveHtmlPreviewGrant(tokenOf(createHtmlPreviewUrl(hiddenEntry, hiddenEntry, root, 0)), 0);
  assert.equal(resolveHtmlPreviewTarget(hidden, [".local", "report", "img", "a.png"]), path.join(root, ".local", "report", "img", "a.png"));
  assert.equal(resolveHtmlPreviewTarget(hidden, [".local", "notes.js"]), null);
  assert.equal(resolveHtmlPreviewTarget(hidden, ["assets", "app.js"]), path.join(root, "assets", "app.js"));
});

test("only web asset types are served, with UTF-8 unless the page declares an encoding", () => {
  assert.equal(isHtmlPreviewPath("/a/Index.HTML"), true);
  assert.equal(isHtmlPreviewPath("/a/page.htm"), true);
  assert.equal(isHtmlPreviewPath("/a/readme.md"), false);
  for (const name of ["a.env", ".env", "a.json", "a.ts", "id_rsa", "a.pem", "a.txt"]) assert.equal(htmlPreviewMime(`/p/${name}`), null, name);
  assert.equal(htmlPreviewMime("/p/app.js"), "text/javascript");
  assert.equal(htmlPreviewMime("/p/font.woff2"), "font/woff2");

  const bytes = (text) => new TextEncoder().encode(text);
  assert.equal(htmlPreviewContentType("text/html", bytes("<!doctype html><title>x</title>")), "text/html; charset=utf-8");
  assert.equal(htmlPreviewContentType("text/html", bytes('<html><head><meta charset="gbk">')), "text/html");
  assert.equal(htmlPreviewContentType("text/html", bytes('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">')), "text/html");
  assert.equal(htmlPreviewContentType("text/html", new Uint8Array([0xef, 0xbb, 0xbf, 0x3c])), "text/html");
  assert.equal(htmlPreviewContentType("text/css", bytes("body{}")), "text/css; charset=utf-8");
  assert.equal(htmlPreviewContentType("image/png", bytes("\x89PNG")), "image/png");

  assert.match(htmlPreviewHeaders("text/html")["Content-Security-Policy"], /^sandbox allow-scripts /);
  assert.doesNotMatch(htmlPreviewHeaders("text/html")["Content-Security-Policy"], /allow-same-origin/);
  assert.equal(htmlPreviewHeaders("image/svg+xml")["Content-Security-Policy"], undefined);
  assert.equal(htmlPreviewHeaders("text/css")["Referrer-Policy"], "no-referrer");
});
