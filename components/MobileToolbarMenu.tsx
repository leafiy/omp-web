"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface ToolbarMenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** Secondary mobile actions stay accessible without creating another toolbar row. */
export function MobileToolbarMenu({ label, items, onOpen }: { label: string; items: ToolbarMenuItem[]; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true); };
  }, [open]);
  return <div ref={root} style={{ flexShrink: 0, marginLeft: "auto" }}>
    <button ref={trigger} type="button" data-mobile-toolbar-trigger aria-label={label} title={label} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined}
      onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, padding: 0, border: "none", background: open ? "var(--bg-selected)" : "none", color: "var(--text-muted)", cursor: "pointer" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
    </button>
    {open && <div id={id} role="menu" aria-label={label} data-mobile-toolbar-menu
      onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }}
      style={{ position: "absolute", top: "calc(100% + 4px)", right: 8, width: 270, maxWidth: "calc(100% - 16px)", maxHeight: "calc(var(--app-viewport-height, 100dvh) - var(--app-top-inset, 0px) - 60px)", overflowY: "auto", padding: 4, zIndex: 900, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,.2)" }}>
      {items.map(item => <button key={item.key} type="button" role="menuitem" data-toolbar-action={item.key} disabled={item.disabled}
        onClick={() => { setOpen(false); trigger.current?.focus(); item.onSelect(); }}
        style={{ display: "block", width: "100%", minHeight: 44, padding: "8px 12px", textAlign: "left", border: "none", borderRadius: 5, background: "none", color: item.disabled ? "var(--text-dim)" : "var(--text)", fontSize: 14, cursor: item.disabled ? "not-allowed" : "pointer" }}>
        {item.label}
      </button>)}
    </div>}
  </div>;
}
