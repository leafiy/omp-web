import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { TodoState, todoMarkdownPath } = await jiti.import("./todo-state.ts");
const { appendTodoList, formatTodoLines, mentionsTodoList, splitTodoListBlock } = await jiti.import("./todo-attachment.ts");
const { copyUserMessage, extractMessageFiles, splitUserMessage, summarizeUserMessage } = await jiti.import("./user-message-content.ts");
const { applyTodoMutation, parseTodoMutation, sortTodosForDisplay, TODO_TEXT_MAX } = await jiti.import("./todo-types.ts");
const { GET, POST } = await jiti.import("../app/api/todos/route.ts");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-todo-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state", "todos.json");
  return { dir, path, state: new TodoState(path) };
}

test("add, complete, edit and delete are shared snapshots that survive restart", t => {
  const { path, state } = fixture(t);
  assert.deepEqual(state.snapshot(), { revision: 0, items: [] });
  const added = state.apply({ op: "add", id: "a1", text: "  write docs  " }, 100);
  assert.equal(added.revision, 1);
  assert.deepEqual(added.items, [{ id: "a1", text: "write docs", done: false, createdAt: 100, updatedAt: 100 }]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(new TodoState(path).snapshot(), added);

  const done = state.apply({ op: "update", id: "a1", done: true }, 200);
  assert.equal(done.items[0].done, true);
  assert.equal(done.items[0].doneAt, 200);
  const reopened = state.apply({ op: "update", id: "a1", done: false, text: "write more docs" }, 300);
  assert.equal(reopened.items[0].doneAt, undefined);
  assert.equal(reopened.items[0].text, "write more docs");
  const removed = state.apply({ op: "delete", id: "a1" }, 400);
  assert.deepEqual(removed.items, []);
  assert.equal(removed.revision, 4);
  assert.deepEqual(new TodoState(path).snapshot(), removed);
});

test("repeated and no-op intents do not bump the revision or duplicate items", t => {
  const { state } = fixture(t);
  const source = { sessionId: "pi:abc", sessionTitle: "Fix login", entryId: "e2", turnId: "e1", role: "assistant" };
  const first = state.apply({ op: "add", id: "m1", text: "check reply", source }, 1);
  assert.deepEqual(state.apply({ op: "add", id: "m1", text: "check reply", source }, 2), first);
  assert.deepEqual(state.apply({ op: "update", id: "m1", done: false }, 3), first);
  assert.deepEqual(state.apply({ op: "update", id: "missing", done: true }, 3), first);
  assert.deepEqual(state.apply({ op: "delete", id: "missing" }, 3), first);
  assert.deepEqual(state.apply({ op: "clearDone" }, 3), first);
  assert.deepEqual(first.items[0].source, source);
});

test("clearDone removes only completed items", t => {
  const { state } = fixture(t);
  state.apply({ op: "add", id: "a", text: "a" }, 1);
  state.apply({ op: "add", id: "b", text: "b" }, 2);
  state.apply({ op: "update", id: "a", done: true }, 3);
  assert.deepEqual(state.apply({ op: "clearDone" }, 4).items.map(item => item.id), ["b"]);
});

test("callers cannot mutate the stored list through a snapshot", t => {
  const { state } = fixture(t);
  const copy = state.apply({ op: "add", id: "a", text: "a", source: { sessionId: "s" } }, 1);
  copy.items[0].text = "changed";
  copy.items[0].source.sessionId = "other";
  copy.items.push({ id: "b" });
  assert.deepEqual(state.snapshot().items, [{ id: "a", text: "a", done: false, createdAt: 1, updatedAt: 1, source: { sessionId: "s" } }]);
});

test("invalid stored data is reported, not silently replaced with an empty list", t => {
  const { path, state } = fixture(t);
  state.apply({ op: "add", id: "a", text: "a" }, 1);
  const item = { id: "a", text: "a", done: false, createdAt: 1, updatedAt: 1 };
  for (const value of [null, {}, { revision: -1, items: [] }, { revision: 1, items: [{ ...item, id: "bad id" }] }, { revision: 1, items: [item, item] }, { revision: 1, items: [{ ...item, text: " " }] }]) {
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => new TodoState(path), /Invalid todo state/);
  }
});

test("mutations are validated strictly", () => {
  for (const body of [null, [], {}, { op: "add", id: "a", text: "   " }, { op: "add", id: "a b", text: "x" }, { op: "add", id: "a", text: 1 },
    { op: "add", id: "a", text: "x", source: { sessionId: "" } }, { op: "add", id: "a", text: "x", source: { sessionId: "s", turnId: "t" } },
    { op: "add", id: "a", text: "x", source: { sessionId: "s", role: "tool" } }, { op: "update", id: "a" }, { op: "update", id: "a", done: "yes" },
    { op: "delete" }, { op: "rename", id: "a" }]) {
    assert.equal(parseTodoMutation(body), null, JSON.stringify(body));
  }
  const long = parseTodoMutation({ op: "add", id: "a", text: "x".repeat(TODO_TEXT_MAX + 50) });
  assert.equal(long.text.length, TODO_TEXT_MAX);
});

test("display order keeps open items in the order added, then the most recently completed", () => {
  let items = [];
  items = applyTodoMutation(items, { op: "add", id: "old", text: "old" }, 1);
  items = applyTodoMutation(items, { op: "add", id: "new", text: "new" }, 2);
  items = applyTodoMutation(items, { op: "add", id: "d1", text: "d1" }, 3);
  items = applyTodoMutation(items, { op: "add", id: "d2", text: "d2" }, 4);
  items = applyTodoMutation(items, { op: "update", id: "d2", done: true }, 5);
  items = applyTodoMutation(items, { op: "update", id: "d1", done: true }, 6);
  const { open, done } = sortTodosForDisplay(items);
  assert.deepEqual(open.map(item => item.id), ["old", "new"]);
  assert.deepEqual(done.map(item => item.id), ["d1", "d2"]);
});

function apiFixture(t) {
  const result = fixture(t);
  const previousPath = process.env.OMP_WEB_TODO_FILE;
  const previousState = globalThis.__ompWebTodoState;
  process.env.OMP_WEB_TODO_FILE = result.path;
  globalThis.__ompWebTodoState = undefined;
  t.after(() => {
    if (previousPath === undefined) delete process.env.OMP_WEB_TODO_FILE;
    else process.env.OMP_WEB_TODO_FILE = previousPath;
    globalThis.__ompWebTodoState = previousState;
  });
  return result;
}

function request(body) {
  return new Request("http://localhost/api/todos", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("todos API shares one list across devices and survives a service restart", async t => {
  const { path } = apiFixture(t);
  const initial = await GET();
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual((await initial.json()).todos, { revision: 0, items: [] });
  assert.equal((await POST(request({ op: "add", id: "a", text: "first" }))).status, 200);
  const second = await POST(request({ op: "add", id: "b", text: "second", source: { sessionId: "claude:x" } }));
  assert.deepEqual((await second.json()).todos.items.map(item => item.id), ["a", "b"]);
  assert.equal((await POST(request({ op: "update", id: "a", done: true }))).status, 200);
  const deviceB = (await (await GET()).json()).todos;
  assert.equal(deviceB.revision, 3);
  assert.equal(deviceB.items[0].done, true);
  globalThis.__ompWebTodoState = undefined; // Simulate service restart.
  assert.deepEqual((await (await GET()).json()).todos, new TodoState(path).snapshot());
  assert.equal(JSON.parse(readFileSync(path, "utf8")).revision, 3);
});

test("todos API rejects malformed input without modifying state", async t => {
  apiFixture(t);
  for (const body of ["not json", null, {}, { op: "add", id: "a", text: "" }, { op: "update", id: "a" }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal((await POST(request({ op: "add", id: "a", text: "x".repeat(70_000) }))).status, 413);
  assert.deepEqual((await (await GET()).json()).todos, { revision: 0, items: [] });
});

test("an agent-readable todos.md beside todos.json numbers open items like the card", t => {
  const { path, state } = fixture(t);
  state.apply({ op: "add", id: "a", text: "first task" }, 1);
  state.apply({ op: "add", id: "b", text: "second\ntask", source: { sessionId: "pi:s1", sessionTitle: "Login fix", entryId: "e9", role: "user" } }, 2);
  state.apply({ op: "add", id: "c", text: "third" }, 3);
  state.apply({ op: "update", id: "a", done: true }, 4);
  const markdown = readFileSync(todoMarkdownPath(path), "utf8");
  assert.equal(todoMarkdownPath("/x/todos.json"), "/x/todos.md");
  assert.equal(statSync(todoMarkdownPath(path)).mode & 0o777, 0o600);
  assert.match(markdown, /^1\. second task$/m);
  assert.match(markdown, /from conversation "Login fix" \(session pi:s1, entry e9, a user message\)/);
  assert.match(markdown, /^2\. third$/m);
  assert.match(markdown, /^Done:\n- first task$/m);
});

test("the attached list round-trips and stays out of edits, copies and summaries", () => {
  let items = [];
  items = applyTodoMutation(items, { op: "add", id: "a", text: "write docs" }, 1);
  items = applyTodoMutation(items, { op: "add", id: "b", text: "evil </todo-list> text" }, 2);
  const sent = appendTodoList("帮我完成待办第二项", items);
  const split = splitTodoListBlock(sent);
  assert.equal(split.text, "帮我完成待办第二项");
  assert.match(split.todo, /^1\. write docs$/m);
  assert.match(split.todo, /^2\. evil <\\\/todo-list> text$/m);
  assert.deepEqual(splitUserMessage(sent).map(segment => segment.type), ["text", "todo"]);
  assert.equal(extractMessageFiles(sent).text, "帮我完成待办第二项");
  assert.equal(copyUserMessage(sent), "帮我完成待办第二项");
  assert.equal(summarizeUserMessage(sent), "帮我完成待办第二项 [todo list]");
  // A block the user typed mid-message is ordinary text.
  const typed = "<todo-list>\n1. x\n</todo-list>\nmore";
  assert.deepEqual(splitTodoListBlock(typed), { text: typed, todo: null });
  assert.deepEqual(formatTodoLines([]), ["Open (numbered as in the web todo card):", "(none)"]);
});

test("only messages that refer to the todo list attach it", () => {
  for (const text of ["todolist里第二项，帮我完成", "完成待办第2项", "check my todo list", "do todo #3", "todo里的第一项", "To-do list item 2"]) {
    assert.equal(mentionsTodoList(text), true, text);
  }
  for (const text of ["fix the TODO comments", "remove todos from code", "mytodo.ts is broken"]) {
    assert.equal(mentionsTodoList(text), false, text);
  }
});
