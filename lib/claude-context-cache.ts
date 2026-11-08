import { claudeContextUsage } from "./context-usage";
import type { ContextUsage } from "./pi-types";

type CacheOptions = { now?: () => number; timeoutMs?: number; onUpdate?: (usage: ContextUsage) => void };

/**
 * Per-query read-only summary cache. A late read never survives a turn/model
 * change. The last native summary stays visible while a turn runs or a read is
 * slow; only a model/window change (reset) makes it unknown again.
 */
export class ClaudeContextCache {
  private revision = 0;
  private value: ContextUsage | null = null;
  private lastKnown: ContextUsage | null = null;
  private expiresAt = 0;
  private pending?: Promise<void>;

  constructor(private readonly read: () => Promise<unknown>, private readonly options: CacheOptions = {}) {}
  /** The conversation changed: re-read on the next request, keep the last summary meanwhile. */
  invalidate(): void { this.revision++; this.value = null; this.expiresAt = 0; }
  /** The model/window changed or the query closed: the previous summary no longer applies. */
  reset(): void { this.invalidate(); this.lastKnown = null; }

  async get(blocked = false): Promise<ContextUsage | null> {
    if (blocked) return this.lastKnown;
    const now = this.options.now ?? Date.now;
    if (this.expiresAt > now()) return this.value ?? this.lastKnown;
    const revision = this.revision;
    if (!this.pending) {
      const pending = Promise.resolve().then(this.read).then((raw) => {
        if (revision !== this.revision) return;
        this.value = claudeContextUsage(raw);
        this.expiresAt = now() + (this.value ? 10_000 : 5000);
        if (this.value) {
          this.lastKnown = this.value;
          try { this.options.onUpdate?.(this.value); } catch { /* A disconnected listener must not fail the read. */ }
        }
      }).catch(() => {
        if (revision !== this.revision) return;
        this.value = null;
        this.expiresAt = now() + 5000;
      }).finally(() => { if (this.pending === pending) this.pending = undefined; });
      this.pending = pending;
    }
    // Keep the underlying request in flight after a UI timeout: don't pile up
    // unbounded SDK calls or kill a live chat just because metadata is slow.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        this.pending.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.timeoutMs ?? 1500); }),
      ]);
      return completed && revision === this.revision ? this.value ?? this.lastKnown : this.lastKnown;
    } finally { clearTimeout(timer); }
  }
}
