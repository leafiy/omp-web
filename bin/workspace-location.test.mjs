import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const { assertWorkspaceLocation } = createRequire(import.meta.url)("./workspace-location.js");

function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), "omp-workspace-test-"));
  const root = join(home, "custom-checkout");
  mkdirSync(root, { recursive: true });
  try { run({ home, root }); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("accepts a workspace at an arbitrary path with local dependencies and output", () => fixture(({ root }) => {
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, ".next"));
  assert.equal(assertWorkspaceLocation(root), realpathSync(root));
}));
test("accepts an alias to the workspace", () => fixture(({ home, root }) => {
  const alias = join(home, "alias"); symlinkSync(root, alias);
  assert.equal(assertWorkspaceLocation(alias), realpathSync(root));
}));
for (const name of ["node_modules", ".next"]) {
  test(`rejects ${name} linked to an old release`, () => fixture(({ home, root }) => {
    const outside = join(home, "release"); mkdirSync(outside);
    symlinkSync(outside, join(root, name));
    assert.throws(() => assertWorkspaceLocation(root), /not linked to another release/);
    rmSync(outside, { recursive: true });
    assert.throws(() => assertWorkspaceLocation(root), /not linked to another release/);
  }));
}
