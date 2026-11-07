"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { useCodeTheme, type CodeTheme } from "@/hooks/useCodeTheme";
import { useLanguage } from "@/hooks/useLanguage";
import { StarfieldEmblem } from "./StarfieldEmblem";

interface CodeThemeOption {
  id: CodeTheme;
  label: string;
  subZh: string;
  subEn: string;
  swatch: string;
}

const CODE_THEMES: CodeThemeOption[] = [
  {
    id: "auto",
    label: "Auto",
    subZh: "跟随应用主题",
    subEn: "Follow App Theme",
    swatch: "linear-gradient(135deg, #ffffff 50%, #1e1e1e 50%)",
  },
  {
    id: "vs",
    label: "VS Light",
    subZh: "浅色代码块",
    subEn: "Light syntax theme",
    swatch: "linear-gradient(135deg, #ffffff 0%, #0000ff 50%, #008000 100%)",
  },
  {
    id: "vscDarkPlus",
    label: "VSC Dark Plus",
    subZh: "深色代码块",
    subEn: "Dark syntax theme",
    swatch: "linear-gradient(135deg, #1e1e1e 0%, #569cd6 50%, #4ec9b0 100%)",
  },
  {
    id: "oneDark",
    label: "One Dark Pro",
    subZh: "One Dark Pro 配色",
    subEn: "One Dark Pro theme",
    swatch: "linear-gradient(135deg, #282c34 0%, #61afef 50%, #e06c75 100%)",
  },
];

interface ThemeOption {
  id: Theme;
  label: string;
  sub: string;
  icon: React.ReactNode;
  /** Color swatch — CSS value */
  swatch: string;
}

const SunIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

const MoonIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const StarIcon = ({ size = 15 }: { size?: number }) => <StarfieldEmblem size={size} />;

const THEMES: ThemeOption[] = [
  {
    id: "light",
    label: "Light",
    sub: "Clean white",
    icon: <SunIcon />,
    swatch: "linear-gradient(135deg, #ffffff 50%, #f0f0f0 50%)",
  },
  {
    id: "dark",
    label: "Dark",
    sub: "Neutral dark",
    icon: <MoonIcon />,
    swatch: "linear-gradient(135deg, #1a1a1a 50%, #2e2e2e 50%)",
  },
  {
    id: "starfield",
    label: "Starfield",
    sub: "NASA-punk HUD",
    icon: <StarIcon />,
    swatch: "linear-gradient(135deg, #0b0e14 0%, #1b365d 50%, #d99b26 100%)",
  },
];

const CURRENT_LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  starfield: "★ Starfield",
};

const CURRENT_COLOR: Record<Theme, string> = {
  light: "var(--text-muted)",
  dark: "var(--text-muted)",
  starfield: "#d99b26",
};

export function ThemePicker({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void } = {}) {
  const { theme, setTheme } = useTheme();
  const { codeTheme, setCodeTheme } = useCodeTheme();
  const { t, lang } = useLanguage();
  const isZh = lang === "zh";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const positionPanel = useCallback(() => {
    const button = buttonRef.current, parent = rootRef.current?.parentElement;
    if (!button || !parent) return;
    const anchor = button.getBoundingClientRect(), bounds = parent.getBoundingClientRect();
    const width = Math.min(240, bounds.width - 16);
    setPanelPos({ top: anchor.bottom + 4, left: Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - width - 8)), width });
  }, []);
  useEffect(() => {
    if (!open || !compact) return;
    window.addEventListener("resize", positionPanel);
    return () => window.removeEventListener("resize", positionPanel);
  }, [open, compact, positionPanel]);

  /* Close on outside click or Escape */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative", flexShrink: 0 }}>
      {/* Trigger button */}
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) onOpen?.();
          buttonRef.current?.focus();
          if (compact) positionPanel();
          setOpen((v) => !v);
        }}
        title="Choose theme"
        aria-label="Choose theme"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          height: compact ? 44 : 36, width: compact ? 44 : undefined, padding: compact ? 0 : "0 10px",
          background: "none", border: "none",
          borderRight: compact ? "none" : "1px solid var(--border)",
          color: CURRENT_COLOR[theme],
          cursor: "pointer", fontSize: 11, whiteSpace: "nowrap",
          transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        {/* icon for current theme */}
        {theme === "starfield" ? <StarIcon size={compact ? 18 : 15} /> : theme === "dark" ? <MoonIcon size={compact ? 18 : 13} /> : <SunIcon size={compact ? 18 : 13} />}
        <span style={{
          display: compact ? "none" : undefined,
          fontFamily: "var(--font-mono, monospace)",
          letterSpacing: "0.04em",
          fontSize: 10,
          opacity: 0.9,
        }}>
          {CURRENT_LABEL[theme]}
        </span>
        {/* chevron */}
        <svg
          width="8" height="8" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
          style={{ display: compact ? "none" : undefined, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
          aria-hidden="true"
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          role="listbox"
          aria-label="Select theme"
          style={{
            position: compact ? "fixed" : "absolute",
            top: compact ? panelPos?.top : "calc(100% + 4px)",
            left: compact ? panelPos?.left : 0,
            width: compact ? panelPos?.width : undefined,
            maxHeight: compact && panelPos ? `calc(var(--app-viewport-height, 100dvh) - ${panelPos.top + 8}px)` : undefined,
            zIndex: 9000,
            minWidth: compact ? 0 : 220,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
            borderRadius: theme === "starfield" ? 0 : 8,
            overflow: "hidden",
            overflowY: compact ? "auto" : undefined,
            /* Starfield: top gold bar */
            borderTop: theme === "starfield"
              ? "2px solid #d99b26"
              : "1px solid var(--border)",
          }}
        >
          {/* Starfield header decoration */}
          {theme === "starfield" && (
            <div style={{
              padding: "6px 12px 4px",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 9,
              letterSpacing: "0.14em",
              color: "#d99b26",
              opacity: 0.7,
              textTransform: "uppercase",
              borderBottom: "1px solid #1e2d45",
            }}>
              ◈ Theme Selection
            </div>
          )}
          {/* Section 1: App Theme */}
          <div style={{
            padding: "8px 12px 4px",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 9,
            letterSpacing: "0.08em",
            color: "var(--text-dim)",
            textTransform: "uppercase",
          }}>
            {t("App Theme", "应用主题")}
          </div>
          {THEMES.map((opt) => {
            const isActive = theme === opt.id;
            return (
              <button
                key={opt.id}
                role="option"
                aria-selected={isActive}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTheme(opt.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                  setOpen(false);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "9px 12px",
                  background: isActive ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderLeft: isActive
                    ? opt.id === "starfield" ? "3px solid #d99b26"
                    : "3px solid var(--accent)"
                    : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
              >
                {/* Color swatch */}
                <div style={{
                  width: 26, height: 18, flexShrink: 0,
                  background: opt.swatch,
                  border: "1px solid var(--border)",
                  borderRadius: opt.id === "starfield" ? 0 : 3,
                  boxShadow: isActive ? "0 0 0 1.5px var(--accent)" : "none",
                }} />

                {/* Icon + text */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0,
                  color: opt.id === "starfield" && isActive ? "#d99b26" : "var(--text)",
                }}>
                  <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.65 }}>
                    {opt.icon}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 600,
                      fontFamily: opt.id === "starfield"
                        ? "var(--font-mono, monospace)" : "inherit",
                      letterSpacing: opt.id === "starfield" ? "0.06em" : 0,
                      color: "inherit",
                    }}>
                      {opt.label}
                    </div>
                    <div style={{
                      fontSize: 10, color: "var(--text-dim)",
                      fontFamily: opt.id === "starfield"
                        ? "var(--font-mono, monospace)" : "inherit",
                      marginTop: 1,
                    }}>
                      {opt.sub}
                    </div>
                  </div>
                </div>

                {/* Active checkmark */}
                {isActive && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke={opt.id === "starfield" ? "#d99b26" : "var(--accent)"}
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ flexShrink: 0 }} aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}

          {/* Divider */}
          <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />

          {/* Section 2: Code Theme */}
          <div style={{
            padding: "6px 12px 4px",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 9,
            letterSpacing: "0.08em",
            color: "var(--text-dim)",
            textTransform: "uppercase",
          }}>
            {t("Code Syntax Theme", "代码块配色")}
          </div>

          {CODE_THEMES.map((opt) => {
            const isActive = codeTheme === opt.id;
            return (
              <button
                key={opt.id}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  setCodeTheme(opt.id);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "8px 12px",
                  background: isActive ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderLeft: isActive
                    ? theme === "starfield" ? "3px solid #d99b26"
                    : "3px solid var(--accent)"
                    : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
              >
                {/* Color swatch */}
                <div style={{
                  width: 26, height: 18, flexShrink: 0,
                  background: opt.swatch,
                  border: "1px solid var(--border)",
                  borderRadius: 3,
                  boxShadow: isActive ? "0 0 0 1.5px var(--accent)" : "none",
                }} />

                {/* Text */}
                <div style={{ flex: 1, minWidth: 0, color: "var(--text)" }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {opt.label}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 1 }}>
                    {isZh ? opt.subZh : opt.subEn}
                  </div>
                </div>

                {/* Active checkmark */}
                {isActive && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke={theme === "starfield" ? "#d99b26" : "var(--accent)"}
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ flexShrink: 0 }} aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
