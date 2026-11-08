import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const { assertWorkspaceLocation } = createRequire(import.meta.url)("./workspace-location.js");

function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), "omp-workspace-test-"));
  const root = join(home, "code", "omp-web");
  mkdirSync(root, { recursive: true });
  try { run({ home, root }); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("accepts the one physical workspace with local dependencies and output", () => fixture(({ home, root }) => {
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, ".next"));
  assert.equal(assertWorkspaceLocation(root, home), root);
}));
test("rejects an alternate checkout and a canonical alias to an external directory", () => fixture(({ home, root }) => {
  const outside = join(home, "elsewhere"); mkdirSync(outside);
  assert.throws(() => assertWorkspaceLocation(outside, home), /must be developed/);
  rmSync(root, { recursive: true }); symlinkSync(outside, root);
  assert.throws(() => assertWorkspaceLocation(root, home), /must be developed/);
}));
for (const name of ["node_modules", ".next"]) {
  test(`rejects ${name} linked to an old release`, () => fixture(({ home, root }) => {
    const outside = join(home, "release"); mkdirSync(outside);
    symlinkSync(outside, join(root, name));
    assert.throws(() => assertWorkspaceLocation(root, home), /not linked to another release/);
    rmSync(outside, { recursive: true });
    assert.throws(() => assertWorkspaceLocation(root, home), /not linked to another release/);
  }));
}
