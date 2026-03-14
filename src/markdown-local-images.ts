/**
 * Parses markdown for local image links and splits content into ordered segments
 * (text or image URL) so the channel can send text + image + text as separate messages.
 */

function isLocalPath(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("file://")
  );
}

/** Markdown image ![alt](url) and link [label](url) – capture URL from both */
const MARKDOWN_IMAGE_OR_LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g;

export type MarkdownSegment =
  | { type: "text"; content: string }
  | { type: "image"; content: string };

/**
 * Splits markdown into ordered segments. Local image URLs (including file://) are
 * extracted so they can be sent as native image messages; surrounding text is kept in order.
 * - If the whole input is a single line that looks like a local path, returns one image segment.
 * - Otherwise finds ![alt](url) and [label](url); when url is local, produces text + image + text segments.
 */
export function parseMarkdownForLocalImages(text: string): MarkdownSegment[] {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return [{ type: "text", content: text }];
  }

  // Single line that is a local path: treat entire content as one image
  if (!trimmed.includes("\n")) {
    if (isLocalPath(trimmed)) {
      return [{ type: "image", content: trimmed }];
    }
    // Backtick-wrapped path e.g. `/tmp/foo.png` → treat as image
    const backtickMatch = trimmed.match(/^`([^`]+)`$/);
    if (backtickMatch && isLocalPath(backtickMatch[1].trim())) {
      return [{ type: "image", content: backtickMatch[1].trim() }];
    }
    // Angle-bracket-wrapped path e.g. <file:///tmp/foo.png> → treat as image
    const angleMatch = trimmed.match(/^<([^>]+)>$/);
    if (angleMatch && isLocalPath(angleMatch[1].trim())) {
      return [{ type: "image", content: angleMatch[1].trim() }];
    }
  }

  const segments: MarkdownSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(MARKDOWN_IMAGE_OR_LINK_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const url = match[1].trim();
    if (!isLocalPath(url)) continue;
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "image", content: url });
    lastIndex = re.lastIndex;
  }

  if (segments.length === 0) {
    return [{ type: "text", content: text }];
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments;
}
