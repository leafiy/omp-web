import { defaultUrlTransform } from "react-markdown";
import type { Root, RootContent } from "hast";
import { resolveLocalFileHref } from "./file-links";

// Normalize local anchors before rehype-sanitize removes unknown protocols.
// Keep its schema unchanged: the resulting paths still pass all normal filters.
export function rehypeLocalFileLinks() {
  return (tree: Root) => {
    const pending: (Root | RootContent)[] = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "element" && node.tagName === "a") {
        const href = node.properties.href;
        if (typeof href === "string" && /^(sandbox:|file:)/i.test(href)) {
          node.properties.href = markdownUrlTransform(href, "href");
        }
      }
      if ("children" in node) {
        for (const child of node.children) pending.push(child);
      }
    }
  };
}

// Only link destinations may use local file protocols. Keep the default
// protocol filter for images and all other URLs (especially javascript/data).
export function markdownUrlTransform(url: string, key: string): string {
  if (key === "href" && /^(sandbox:|file:)/i.test(url)) {
    const path = resolveLocalFileHref(url);
    if (path && path.startsWith("/") && !path.startsWith("//")) {
      return path.split("/").map(encodeURIComponent).join("/");
    }
    return "";
  }
  return defaultUrlTransform(url);
}
