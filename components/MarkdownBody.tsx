"use client";

import { useMemo, type CSSProperties, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { markdownUrlTransform } from "@/lib/markdown-urls";
import { ChatImage } from "./ChatImage";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  sessionId?: string;
  onOpenFile?: (filePath: string) => void;
}

export function MarkdownBody({ children, className, isStreaming, cwd, sessionId, onOpenFile }: MarkdownBodyProps) {
  const { t } = useI18n();
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath);
      };

      const downloadParams = new URLSearchParams({ type: "download" });
      if (sessionId) downloadParams.set("sessionId", sessionId);
      return (
        <>
          <a href={href} {...props} onClick={handleClick}>
            {children}
          </a>
          {" "}
          <a
            href={`/api/files/${encodeFilePathForApi(filePath)}?${downloadParams}`}
            download={getFileName(filePath)}
            title={t("i18n.downloadFile")}
            style={{ fontSize: "0.85em", whiteSpace: "nowrap" }}
          >
            ↓ {t("files.download")}
          </a>
        </>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      return typeof src === "string" ? <ChatImage src={src} alt={alt ?? ""} cwd={cwd} onOpenFile={onOpenFile} /> : null;
    },
    ol({ node, children, ...props }) {
      // The CSS gutter fits two-digit markers; widen it for the list's last number.
      const start = typeof props.start === "number" ? props.start : 1;
      const items = node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
      const extraDigits = String(Math.max(start, start + items - 1)).length - 2;
      const style = extraDigits > 0 ? { ...props.style, "--md-ol-extra-digits": extraDigits } as CSSProperties : props.style;
      return <ol {...props} style={style}>{children}</ol>;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile, sessionId, t]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        urlTransform={markdownUrlTransform}
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

