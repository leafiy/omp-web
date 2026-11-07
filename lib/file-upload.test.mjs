import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("pins the upload directory across multipart waiting and rejects a symlink replacement", async (t) => {
  const { pinUploadDirectory } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-upload-pinned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target"), moved = path.join(root, "moved"), outside = path.join(root, "outside");
  fs.mkdirSync(target); fs.mkdirSync(outside);
  const pinned = pinUploadDirectory(target);
  try {
    fs.renameSync(target, moved); fs.symlinkSync(outside, target);
    assert.throws(() => pinned.assertCurrent(), /directory changed/);
    assert.deepEqual(fs.readdirSync(outside), []);
    if (process.platform === "linux") assert.equal(fs.realpathSync(pinned.directory), moved);
  } finally { pinned.close(); }
});

test("publishes uploads exclusively and preserves the old file if replacement writing fails", async (t) => {
  const { writeUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-upload-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(writeUploadFile(root, "file", Buffer.from("original"), "error"), "uploaded");
  assert.throws(() => writeUploadFile(root, "file", Buffer.from("new"), "error"), /already exists/);
  assert.equal(writeUploadFile(root, "file", Buffer.from("new"), "skip"), "skipped");
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = () => { throw new Error("synthetic disk failure"); };
    assert.throws(() => writeUploadFile(root, "file", Buffer.from("new"), "overwrite"), /synthetic disk failure/);
  } finally { fs.writeFileSync = originalWrite; }
  assert.equal(fs.readFileSync(path.join(root, "file"), "utf8"), "original");
  assert.deepEqual(fs.readdirSync(root), ["file"]);
  assert.equal(writeUploadFile(root, "file", Buffer.from("new"), "overwrite"), "uploaded");
  assert.equal(fs.readFileSync(path.join(root, "file"), "utf8"), "new");
  fs.symlinkSync("file", path.join(root, "link"));
  assert.throws(() => writeUploadFile(root, "link", Buffer.from("bad"), "overwrite"), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(root, "file"), "utf8"), "new");
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});
