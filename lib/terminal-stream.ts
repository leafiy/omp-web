import type { TerminalSession } from "./terminal-manager";
import type { TerminalEvent } from "./terminal-contract";

export function terminalEventResponse(req: Request, session: TerminalSession, after: number): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* stream already cancelled */ }
      };
      const enqueue = (text: string) => {
        if (closed) return;
        // A stalled reader must not accumulate unbounded PTY output in memory.
        if ((controller.desiredSize ?? 0) < -512 * 1024) { cleanup(); return; }
        try { controller.enqueue(encoder.encode(text)); } catch { cleanup(); }
      };
      const send = (event: TerminalEvent) => {
        enqueue(`${"seq" in event ? `id: ${event.seq}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
      };
      const heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
      heartbeat.unref();
      unsubscribe = session.subscribe(after, send);
      if (closed) { unsubscribe(); return; }
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) cleanup();
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
