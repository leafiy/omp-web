/** Keep native CLI settings/provider environment; strip only web and parent-session data. */
export function nativeAgentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OMP_WEB_") || key.startsWith("PI_WEB_") || key.startsWith("PI_SESSION_")
      || ["PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "CLAUDECODE", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  }
  return env;
}
