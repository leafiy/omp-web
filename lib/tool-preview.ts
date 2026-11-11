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
