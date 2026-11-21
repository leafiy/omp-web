/** Browser-safe view of Claude Code's native MCP status. */
export interface WebMcpServer {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "unknown";
  scope?: string;
  source?: string;
  /** Transport kind only. Commands, URLs, headers and env stay on the server: they can hold credentials. */
  transport?: string;
  serverName?: string;
  version?: string;
  error?: string;
  tools: { name: string; readOnly?: boolean; destructive?: boolean }[];
}

const STATUSES = new Set(["connected", "failed", "needs-auth", "pending", "disabled"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function projectMcpStatus(value: unknown): WebMcpServer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): WebMcpServer[] => {
    const server = record(raw);
    const name = typeof server.name === "string" ? server.name : "";
    if (!name) return [];
    const info = record(server.serverInfo);
    const config = record(server.config);
    const tools = Array.isArray(server.tools) ? server.tools.slice(0, 200).flatMap((item) => {
      const tool = record(item), annotations = record(tool.annotations);
      return typeof tool.name === "string" ? [{
        name: tool.name.slice(0, 200),
        ...(annotations.readOnly === true ? { readOnly: true } : {}),
        ...(annotations.destructive === true ? { destructive: true } : {}),
      }] : [];
    }) : [];
    const status = typeof server.status === "string" && STATUSES.has(server.status) ? server.status as WebMcpServer["status"] : "unknown";
    return [{
      name,
      status,
      ...(text(server.scope) ? { scope: text(server.scope) } : {}),
      ...(text(server.source) ? { source: text(server.source) } : {}),
      ...(Object.keys(config).length ? { transport: text(config.type, 40) ?? "stdio" } : {}),
      ...(text(info.name) ? { serverName: text(info.name) } : {}),
      ...(text(info.version, 60) ? { version: text(info.version, 60) } : {}),
      ...(text(server.error, 600) ? { error: text(server.error, 600) } : {}),
      tools,
    }];
  });
}
