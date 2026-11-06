import type { AgentEngine } from "./engine";

export interface NativeSkillItem {
  name: string;
  description: string;
  kind: "skill" | "command";
  invocation: string | null;
  path: string | null;
  enabled: boolean | null;
}

export interface NativeSkillsReport {
  engine: AgentEngine;
  cwd: string;
  status: "ok" | "partial" | "unavailable" | "error";
  items: NativeSkillItem[];
  note: string;
  checkedAt: string;
}
