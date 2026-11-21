function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

function compactPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Display-only summary shared by live and historical tool calls. */
export function getToolPreview(
  block: { toolName: string; input: Record<string, unknown> },
  resultText?: string | null,
): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";

  // Claude Code's TodoWrite: progress, not the raw todo array.
  if (block.toolName === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos.filter((todo): todo is Record<string, unknown> => Boolean(todo) && typeof todo === "object");
    const done = todos.filter((todo) => todo.status === "completed").length;
    const active = todos.find((todo) => todo.status === "in_progress");
    const label = active && (typeof active.activeForm === "string" ? active.activeForm : typeof active.content === "string" ? active.content : "");
    if (todos.length) return compactPreview(`${done}/${todos.length} done${label ? ` · ${label}` : ""}`);
  }
  // OMP's todo tool: the operation and its target, not just the op keyword.
  if (block.toolName === "todo" && typeof input.op === "string") {
    const target = typeof input.task === "string" ? input.task : typeof input.phase === "string" ? input.phase : "";
    return compactPreview(`${input.op}${target ? ` · ${target}` : ""}`);
  }

  if (block.toolName === "AskUserQuestion") {
    if (resultText?.trim() && resultText.trim() !== "(no output)") {
      return compactPreview(resultText);
    }
    if (input.answers && typeof input.answers === "object" && !Array.isArray(input.answers)) {
      const answers = Object.entries(input.answers)
        .map(([question, answer]) => `${question} → ${previewValue(answer)}`);
      if (answers.length) return compactPreview(answers.join(" · "));
    }
    if (Array.isArray(input.questions)) {
      const questions = input.questions.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const question = "question" in item ? item.question : undefined;
        return typeof question === "string" && question.trim() ? [question] : [];
      });
      if (questions.length) return compactPreview(questions.join(" · "));
    }
  }

  // Preserve common tool summaries; never coerce structured input to [object Object].
  for (const key of ["command", "path", "file_path", "pattern", "query"]) {
    if (key in input) return previewValue(input[key]).slice(0, 120);
  }
  const keys = Object.keys(input);
  return keys.length ? previewValue(input[keys[0]]).slice(0, 120) : "";
}
