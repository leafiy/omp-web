import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  source: "claude";
}

/** Operations tied to a terminal or to an identity change the web cannot follow. */
export function claudeSlashCommandRestriction(name: string): string | undefined {
  if (["login", "logout"].includes(name)) return "Manage Claude login in the local terminal; do not send credentials to chat";
  if (["new", "clear", "resume", "fork", "branch", "rewind"].includes(name)) return "Use the web session controls, or run this command in the local Claude terminal";
  if (["exit", "quit", "terminal-setup", "statusline", "keybindings", "vim", "voice", "theme", "desktop", "ide", "remote-control", "rc"].includes(name)) return "This Claude command requires the local terminal";
  return undefined;
}

function argumentHint(command: SlashCommand): string {
  const hint = command.argumentHint?.trim() ?? "";
  // Some CLIs advertise the builtin /effort with only a placeholder. This is
  // syntax assistance, not a claim that the current model/account supports
  // every level. Explicit native choices always win; user skills are untouched.
  if (command.builtin && command.name === "effort" && ["", "[level]", "<level>", "[level|ultracode [on|off]]", "<level|ultracode [on|off]>"].includes(hint)) {
    return "<low|medium|high|xhigh|max|auto|ultracode [on|off]>";
  }
  return hint;
}

/** Preserve native name/alias precedence, without inventing a command catalog. */
export function claudeSlashCommands(commands: readonly SlashCommand[], terminalNames: readonly string[] = []): ClaudeSlashCommand[] {
  const named = new Map<string, SlashCommand>();
  const validName = (name: string) => Boolean(name) && !/[\s/]/u.test(name);
  for (const command of commands) {
    if (validName(command.name) && (!named.has(command.name) || command.builtin)) named.set(command.name, command);
  }
  const terminal = new Set(terminalNames);
  const visible = (name: string) => !claudeSlashCommandRestriction(name) && !terminal.has(name);
  const result = new Map<string, ClaudeSlashCommand>();
  const add = (name: string, command: SlashCommand) => {
    if (validName(name) && visible(name)) result.set(name, {
      name, description: command.description, argumentHint: argumentHint(command), source: "claude",
    });
  };
  for (const [name, command] of named) {
    if (!visible(name)) continue;
    add(name, command);
    for (const alias of command.aliases ?? []) {
      if (!named.has(alias) && !result.has(alias)) add(alias, command);
    }
  }
  return [...result.values()];
}
