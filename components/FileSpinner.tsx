export function FileSpinner({ size = 14 }: { size?: number }) {
  return <svg data-file-spinner width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-5.7-8.4" />
  </svg>;
}
