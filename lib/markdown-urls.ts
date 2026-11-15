import { defaultUrlTransform } from "react-markdown";
import { resolveLocalFileHref } from "./file-links";

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
