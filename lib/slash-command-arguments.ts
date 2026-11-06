export interface SlashArgumentCompletion {
  value: string;
  text: string;
}

/** Parse a bounded, finite subset of CLI hints, never arbitrary grammar or code. */
function literalSequences(hint: string): string[][] {
  if (!hint.includes("|") || hint.length > 1024 || /[^A-Za-z0-9_:.\-<>[\]| \t]/u.test(hint)) return [];
  const tokens = hint.match(/[<>[\]|]|[A-Za-z0-9_:.\-]+/g) ?? [];
  if (tokens.length > 128) return [];
  let position = 0;
  const combine = (left: string[][], right: string[][]): string[][] => {
    if (left.length * right.length > 128) throw new Error("Too many argument alternatives");
    const result = left.flatMap((a) => right.map((b) => [...a, ...b]));
    if (result.some((sequence) => sequence.length > 16)) throw new Error("Argument sequence too long");
    return result;
  };
  const choices = (depth: number): string[][] => {
    if (depth > 6) throw new Error("Argument nesting too deep");
    const result: string[][] = [];
    let sequence: string[][] = [[]];
    let hasTerm = false;
    while (position < tokens.length && tokens[position] !== "]" && tokens[position] !== ">") {
      const token = tokens[position++];
      if (token === "|") {
        if (!hasTerm) throw new Error("Empty alternative");
        result.push(...sequence);
        sequence = [[]];
        hasTerm = false;
      } else {
        let next: string[][];
        if (token === "[" || token === "<") {
          const start = position;
          next = choices(depth + 1);
          // <path> and [level] are placeholders, not literal completions.
          if (!tokens.slice(start, position).includes("|")) throw new Error("Opaque placeholder");
          if (tokens[position++] !== (token === "[" ? "]" : ">")) throw new Error("Unbalanced hint");
          if (token === "[") next.push([]);
        } else {
          if (["level", "path", "file", "args", "arguments", "..."].includes(token)) throw new Error("Opaque placeholder");
          next = [[token]];
        }
        sequence = combine(sequence, next);
        hasTerm = true;
      }
      if (result.length + sequence.length > 128) throw new Error("Too many argument alternatives");
    }
    if (!hasTerm) throw new Error("Empty alternative");
    return [...result, ...sequence];
  };
  try {
    const result = choices(0);
    return position === tokens.length ? result : [];
  } catch { return []; }
}

/** Completion changes only the last token; it never sends or executes anything. */
export function slashArgumentCompletions(
  input: string,
  commands: readonly { name: string; argumentHint?: string }[],
): SlashArgumentCompletion[] {
  if (input.length > 4096 || /[\r\n]/.test(input)) return [];
  const match = input.match(/^\/([^\s]+)[ \t]+(.*)$/);
  if (!match) return [];
  const command = commands.find((item) => item.name === match[1]);
  if (!command?.argumentHint) return [];
  const args = match[2].split(/[ \t]+/);
  const prefix = args.pop()!.toLowerCase();
  const start = Math.max(input.lastIndexOf(" "), input.lastIndexOf("\t")) + 1;
  const values = new Set<string>();
  for (const sequence of literalSequences(command.argumentHint)) {
    if (!args.every((value, index) => sequence[index] === value)) continue;
    const next = sequence[args.length];
    if (next?.toLowerCase().startsWith(prefix)) values.add(next);
  }
  return [...values].map((value) => ({ value, text: `${input.slice(0, start)}${value} ` }));
}
