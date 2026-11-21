// Loaded explicitly only in omp-web's persistent Pi RPC sessions.
export default function (pi) {
  pi.registerCommand("omp-web-reload", {
    description: "Reload this Pi session's resources",
    async handler(_args, ctx) {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for Pi to finish before reloading");
      await ctx.reload();
    },
  });
}
