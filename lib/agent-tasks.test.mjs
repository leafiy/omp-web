import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { AgentTasks } = await jiti.import("./agent-tasks.ts");
const fixture = engine => { const events = []; const tasks = new AgentTasks(engine, event => events.push(event)); return { tasks, events }; };
const cc = (tasks, subtype, fields) => tasks.claude({ type: "system", subtype, ...fields });

test("Claude background membership survives main-turn end and excludes ambient watchers", () => {
  const { tasks, events } = fixture("claude");
  cc(tasks, "background_tasks_changed", { tasks: [{ task_id: "a", description: "Review" }, { task_id: "watch", ambient: true }] });
  tasks.claude({ type: "result" });
  assert.equal(tasks.active, true);
  cc(tasks, "task_notification", { task_id: "a", status: "completed" });
  cc(tasks, "background_tasks_changed", { tasks: [{ task_id: "watch", ambient: true }] });
  assert.equal(tasks.active, false);
  assert.equal(tasks.snapshot().tasks.find(t => t.id === "a").status, "completed");
  assert.equal(events.at(-1).type, "task_snapshot");
});

test("Claude missing completion is unknown, never invented success", () => {
  const { tasks } = fixture("claude");
  cc(tasks, "background_tasks_changed", { tasks: [{ task_id: "a" }] });
  cc(tasks, "background_tasks_changed", { tasks: [] });
  assert.equal(tasks.snapshot().tasks[0].status, "unknown");
  assert.equal(tasks.active, false);
});

test("Claude resumed run ignores old terminal and progress events", () => {
  const { tasks } = fixture("claude");
  cc(tasks, "task_started", { task_id: "a", run_id: "02" });
  cc(tasks, "task_notification", { task_id: "a", run_id: "01", status: "completed" });
  assert.equal(tasks.active, true);
  cc(tasks, "task_notification", { task_id: "a", run_id: "02", status: "failed" });
  cc(tasks, "task_progress", { task_id: "a", run_id: "02", description: "late" });
  assert.equal(tasks.active, false);
  assert.equal(tasks.snapshot().tasks[0].status, "failed");
});

test("OMP lifecycle and snapshot reconcile without stale query overwrites", () => {
  const { tasks } = fixture("omp");
  const revision = tasks.version;
  tasks.omp({ type: "subagent_lifecycle", payload: { id: "a", agent: "worker", status: "started" } });
  tasks.ompSnapshot([], revision);
  assert.equal(tasks.active, true);
  tasks.omp({ type: "subagent_progress", payload: { progress: { id: "a", status: "running", description: "Review" } } });
  tasks.omp({ type: "subagent_lifecycle", payload: { id: "a", status: "completed" } });
  assert.equal(tasks.active, false);
  tasks.ompSnapshot([], tasks.version);
  assert.equal(tasks.snapshot().tasks[0].status, "completed");
});

test("Codex completed spawn call is not completed child; unknown threads ignored", () => {
  const { tasks } = fixture("codex");
  tasks.codexStatus("foreign", { type: "active" });
  assert.equal(tasks.snapshot().tasks.length, 0);
  tasks.codexItem({ type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"] });
  assert.equal(tasks.active, true);
  tasks.codexStatus("child", { type: "idle" });
  assert.equal(tasks.active, false);
  assert.equal(tasks.snapshot().tasks[0].status, "completed");
});

test("Pi does not infer completion from the example's initial exitCode zero", () => {
  const { tasks } = fixture("pi");
  tasks.pi({ type: "tool_execution_start", toolName: "subagent", toolCallId: "call" });
  const result = { details: { mode: "parallel", results: [{ agent: "reviewer", exitCode: 0, messages: [{ private: true }] }, { agent: "worker", exitCode: -1 }] } };
  tasks.pi({ type: "tool_execution_update", toolCallId: "call", partialResult: result });
  assert.equal(tasks.snapshot().tasks.filter(t => t.active).length, 2);
  assert.equal(JSON.stringify(tasks.snapshot()).includes("private"), false);
  tasks.pi({ type: "tool_execution_end", toolCallId: "call", result: { details: { mode: "parallel", results: [{ agent: "reviewer", exitCode: 0 }, { agent: "worker", exitCode: 1 }] } } });
  assert.equal(tasks.active, false);
  assert.deepEqual(tasks.snapshot().tasks.filter(t => !t.hidden).map(t => t.status), ["completed", "failed"]);
});

test("Unknown Pi extension payload degrades honestly", () => {
  const { tasks } = fixture("pi");
  tasks.pi({ type: "tool_execution_start", toolName: "subagent", toolCallId: "call" });
  tasks.pi({ type: "tool_execution_end", toolCallId: "call", result: { details: { arbitrary: true } } });
  assert.equal(tasks.active, false);
  assert.equal(tasks.snapshot().tasks[0].status, "unknown");
});

test("Process loss marks unfinished work unknown and snapshots are immutable", () => {
  const { tasks } = fixture("claude");
  cc(tasks, "task_started", { task_id: "a" });
  const before = tasks.snapshot();
  tasks.disconnected();
  assert.equal(before.tasks[0].active, true);
  assert.equal(tasks.snapshot().tasks[0].status, "unknown");
  assert.equal(tasks.snapshot().coverage, "unavailable");
  assert.equal(tasks.active, false);
});
