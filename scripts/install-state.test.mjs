import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { dependencyKey, buildKey, reusable, recordSuccess } from "./install-state.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-update-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, content = "fixture") => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  };
  put("package.json", JSON.stringify({ dependencies: { next: "16.2.12" }, devDependencies: { typescript: "5" } }));
  put("package-lock.json", "{}");
  for (const [name, version] of [["next", "16.2.12"], ["typescript", "5.9.3"]]) {
    put(`node_modules/${name}/package.json`, JSON.stringify({ version }));
  }
  put("node_modules/.package-lock.json", "{}");
  put("node_modules/.bin/next");
  put("node_modules/.bin/tsc");
  for (const name of ["BUILD_ID", "build-manifest.json", "routes-manifest.json", "prerender-manifest.json", "required-server-files.json", "server/app/page.js", "static/chunks/main.js"]) put(`.next/${name}`);
  return { root, put };
}

const runtime = { node: "v22.19.0", npm: "10", platform: "linux", arch: "x64", config: "{}" };

test("dependency receipts require a successful install and matching inputs/evidence", (t) => {
  const { root, put } = fixture(t);
  const key = dependencyKey(root, runtime);
  assert.equal(reusable(root, "dependencies", key), false);
  recordSuccess(root, "dependencies", key);
  assert.equal(reusable(root, "dependencies", key), true);
  assert.notEqual(dependencyKey(root, { ...runtime, arch: "arm64" }), key);
  assert.notEqual(dependencyKey(root, { ...runtime, node: "v24.0.0" }), key);
  assert.notEqual(dependencyKey(root, { ...runtime, npm: "11" }), key);
  assert.notEqual(dependencyKey(root, { ...runtime, config: "changed" }), key);
  put("package-lock.json", '{"changed":true}');
  assert.notEqual(dependencyKey(root, runtime), key);
  rmSync(join(root, "node_modules/next/package.json"));
  assert.equal(reusable(root, "dependencies", key), false);
});

test("build keys include commit, dependencies, env files and build environment", (t) => {
  const { root, put } = fixture(t);
  const key = buildKey(root, "deps", "commit", {});
  assert.notEqual(buildKey(root, "other-deps", "commit", {}), key);
  assert.notEqual(buildKey(root, "deps", "other-commit", {}), key);
  assert.notEqual(buildKey(root, "deps", "commit", { NEXT_PUBLIC_TEST: "changed" }), key);
  assert.notEqual(buildKey(root, "deps", "commit", { NODE_OPTIONS: "--max-old-space-size=4096" }), key);
  put(".env.production.local", "PRIVATE_BUILD_VALUE=secret");
  assert.notEqual(buildKey(root, "deps", "commit", {}), key);
});

test("build receipts reject missing or replaced artifacts but ignore disposable cache", (t) => {
  const { root, put } = fixture(t);
  assert.equal(reusable(root, "build", "key"), false);
  recordSuccess(root, "build", "key");
  assert.equal(reusable(root, "build", "key"), true);
  assert.equal(reusable(root, "build", "different"), false);
  put(".next/cache/webpack/cache", "changed cache");
  assert.equal(reusable(root, "build", "key"), true);
  put(".next/static/chunks/main.js", "replacement output");
  assert.equal(reusable(root, "build", "key"), false);
  recordSuccess(root, "build", "key");
  rmSync(join(root, ".next/server/app/page.js"));
  assert.equal(reusable(root, "build", "key"), false);
});

test("missing/corrupt/invalidation receipts cannot turn failed work into a cache hit", (t) => {
  const { root, put } = fixture(t);
  for (const [kind, file] of [["build", ".next/.omp-web-build.json"], ["dependencies", "node_modules/.omp-web-install.json"]]) {
    recordSuccess(root, kind, "key");
    rmSync(join(root, file)); // updater invalidates before beginning destructive work
    assert.equal(reusable(root, kind, "key"), false);
    put(file, "{partial");
    assert.equal(reusable(root, kind, "key"), false);
  }
});
