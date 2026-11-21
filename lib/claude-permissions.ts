import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

/**
 * Modes the web offers. `bypassPermissions` stays terminal-only, and `dontAsk`
 * (silently deny everything not pre-approved) is not offered either.
 */
export const CLAUDE_WEB_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;
export type ClaudeWebPermissionMode = typeof CLAUDE_WEB_PERMISSION_MODES[number];

export function isClaudePermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(value);
}
export function isClaudeWebPermissionMode(value: unknown): value is ClaudeWebPermissionMode {
  return typeof value === "string" && (CLAUDE_WEB_PERMISSION_MODES as readonly string[]).includes(value);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const DESTINATIONS: Record<string, string> = {
  localSettings: "project local settings",
  projectSettings: "project settings",
  userSettings: "user settings",
  session: "this session",
  cliArg: "this session",
};

/** Human-readable summary of native permission suggestions, e.g. `Bash(npm test:*)`. */
export function describePermissionUpdates(updates: readonly PermissionUpdate[]): string {
  const parts = updates.flatMap((update): string[] => {
    switch (update.type) {
      case "addRules":
      case "replaceRules":
        return update.rules.map((rule) => rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName);
      case "addDirectories":
        return update.directories.map((directory) => `access to ${directory}`);
      case "setMode":
        return [`${update.mode} mode`];
      default:
        return [];
    }
  });
  return clip([...new Set(parts)].join(", ") || "this tool", 160);
}

/** Only additive suggestions are offered as "always allow"; removals are never applied from a prompt. */
export function allowSuggestions(updates: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (updates ?? []).filter((update) => update.type === "addRules" && update.behavior === "allow"
    || update.type === "addDirectories"
    || update.type === "setMode" && update.mode !== "bypassPermissions");
}

/** The destination name of the first suggestion that persists beyond this session. */
export function persistentDestination(updates: readonly PermissionUpdate[]): string | undefined {
  const update = updates.find((item) => item.destination !== "session" && item.destination !== "cliArg");
  return update ? DESTINATIONS[update.destination] ?? update.destination : undefined;
}

export function sessionScoped(updates: readonly PermissionUpdate[]): PermissionUpdate[] {
  return updates.map((update) => ({ ...update, destination: "session" }));
}
