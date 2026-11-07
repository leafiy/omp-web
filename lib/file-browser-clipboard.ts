"use client";

export interface FileClipboard {
  kind: "copy" | "move";
  source: string;
  sourceVersion: string;
}
// Per-tab RAM only. No file bytes, OS clipboard reads or persistent path storage.
let value: FileClipboard | null = null;
const listeners = new Set<() => void>();
export const getFileClipboard = () => value;
export const getServerFileClipboard = () => null;
export function setFileClipboard(next: FileClipboard | null) {
  value = next;
  for (const listener of listeners) listener();
}
export function subscribeFileClipboard(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
