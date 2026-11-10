import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_NEW_SESSION_CWD,
  getRecentProjects,
  groupSessionsByProject,
  newProjectParent,
  projectDisplayName,
  projectParentPath,
} = await jiti.import("./session-projects.ts");

const session = (id, cwd, modified, projectRoot) => ({
  id, cwd, modified, projectRoot, path: "", created: modified, messageCount: 1, firstMessage: "",
});

test("new sessions default to /tmp", () => {
  assert.equal(DEFAULT_NEW_SESSION_CWD, "/tmp");
});

test("groups worktree sessions under their main project, most recent project first", () => {
  const groups = groupSessionsByProject([
    session("a", "/repo", "2026-01-01T00:00:00Z", "/repo"),
    session("b", "/other", "2026-01-03T00:00:00Z", "/other"),
    session("c", "/repo-wt/feature", "2026-01-05T00:00:00Z", "/repo"),
  ]);
  assert.deepEqual(groups.map((group) => group.root), ["/repo", "/other"]);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["a", "c"]);
  assert.equal(groups[0].latest, "2026-01-05T00:00:00Z");
});

test("falls back to cwd when projectRoot is missing or empty and skips sessions without a directory", () => {
  const groups = groupSessionsByProject([
    session("a", "/tmp", "2026-01-01T00:00:00Z", undefined),
    session("b", "/tmp", "2026-01-02T00:00:00Z", ""),
    session("c", "", "2026-01-03T00:00:00Z", ""),
  ]);
  assert.deepEqual(groups.map((group) => [group.root, group.sessions.length]), [["/tmp", 2]]);
  assert.deepEqual(getRecentProjects([session("x", "/x", "2026-01-01T00:00:00Z")]), ["/x"]);
});

test("formats project names and parents for display", () => {
  assert.equal(projectDisplayName("/home/me/omp-web"), "omp-web");
  assert.equal(projectDisplayName("/home/me/omp-web/"), "omp-web");
  assert.equal(projectDisplayName("/"), "/");
  assert.equal(projectDisplayName("C:\\work\\app"), "app");
  assert.equal(projectParentPath("/home/me/omp-web"), "/home/me");
  assert.equal(projectParentPath("/tmp"), "/");
  assert.equal(projectParentPath("app"), "");
});

test("new projects go next to the most common recent project parent", () => {
  assert.equal(newProjectParent(["/home/me/code/a", "/home/me/work/b", "/home/me/code/c"], "/home/me"), "/home/me/code");
  // Ties go to the more recent project's parent.
  assert.equal(newProjectParent(["/home/me/work/b", "/home/me/code/a"], "/home/me"), "/home/me/work");
  // Roots and temporary directories are never suggested.
  assert.equal(newProjectParent(["/srv", "/tmp/scratch", "/tmp/x/y", "C:\\app"], "/home/me"), "/home/me");
  assert.equal(newProjectParent([], "/home/me"), "/home/me");
  assert.equal(newProjectParent([], ""), "");
});
