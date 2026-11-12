let sequence = 0;

/** Filename uniqueness only, never an authentication token or secret.
 * randomUUID requires a secure context; getRandomValues also works over HTTP.
 * The final fallback keeps old browsers usable. Uploads still reject conflicts.
 */
export function createAttachmentId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  sequence += 1;
  return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
