export const runtime = "nodejs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Agent directories belong to each native CLI. Do not make the web process
  // impersonate OMP by rewriting Pi's global directory for every subprocess.
  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();
}
