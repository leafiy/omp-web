// Format only the supplied draft. Never load a project's tsconfig, plugins or imports.
export async function formatFileText(name: string, source: string): Promise<string> {
  if (/\.json$/i.test(name)) {
    JSON.parse(source); // Validate, but don't re-serialize: preserve large integers and duplicate keys.
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[^\s{}\[\],:"]+|[{}\[\],:]/g) ?? [];
    let depth = 0;
    let addedBytes = 0;
    const newline = () => {
      addedBytes += 1 + 2 * depth;
      if (addedBytes > 256 * 1024) throw new Error("Formatted output too large");
      return "\n" + "  ".repeat(depth);
    };
    return tokens.map((token, i) => {
      if (token === "{" || token === "[") {
        depth++;
        return token + (["}", "]"].includes(tokens[i + 1]) ? "" : newline());
      }
      if (token === "}" || token === "]") {
        depth--;
        return (["{", "["].includes(tokens[i - 1]) ? "" : newline()) + token;
      }
      return token === "," ? "," + newline() : token === ":" ? ": " : token;
    }).join("") + (source.endsWith("\n") ? "\n" : "");
  }
  if (!/\.(?:[mc]?js|jsx|tsx?)$/i.test(name)) throw new Error("Unsupported format");
  const ts = await import("typescript");
  const file = "/draft." + name.split(".").pop()!.toLowerCase();
  const snapshot = ts.ScriptSnapshot.fromString(source);
  const service = ts.createLanguageService({
    getCompilationSettings: () => ({ allowJs: true, noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve }),
    getCurrentDirectory: () => "/", getDefaultLibFileName: () => "", getScriptFileNames: () => [file],
    getScriptVersion: () => "1", getScriptSnapshot: p => p === file ? snapshot : undefined,
    fileExists: p => p === file, readFile: p => p === file ? source : undefined,
  });
  try {
    if (service.getSyntacticDiagnostics(file).length) throw new Error("Invalid syntax");
    const edits = service.getFormattingEditsForDocument(file, {
      indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: "\n",
      insertSpaceAfterCommaDelimiter: true, insertSpaceBeforeAndAfterBinaryOperators: true,
      insertSpaceAfterKeywordsInControlFlowStatements: true, insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    });
    const parts: string[] = [];
    let offset = 0;
    for (const { span, newText } of edits) {
      parts.push(source.slice(offset, span.start), newText);
      offset = span.start + span.length;
    }
    return parts.join("") + source.slice(offset);
  } finally { service.dispose(); }
}
