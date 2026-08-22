// The tiny markdown a `text` block understands, and nothing more: **bold**, *italic* / _italic_,
// line breaks, and `- ` bullets. Deliberately not a markdown library.
//
// The output of this parser is laid out by @react-pdf/renderer, which has no HTML and no CSS
// cascade: everything a real markdown dialect adds (tables, images, links, raw HTML, block quotes,
// nested lists) would need a layout decision per construct, and a construct with no layout silently
// renders as its own source text in a document the customer keeps. A closed set that maps 1:1 onto
// primitives the renderer already draws is the whole design.
//
// Pure and total: every input produces spans, none throws, and an unmatched marker stays literal
// rather than swallowing the rest of the line.

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface MarkdownLine {
  kind: "paragraph" | "bullet";
  spans: InlineSpan[];
}

const MARKERS: { token: string; key: "bold" | "italic" }[] = [
  { token: "**", key: "bold" },
  { token: "*", key: "italic" },
  { token: "_", key: "italic" },
];

// A marker only opens when its closer exists later on the same line. Without that lookahead, the
// asterisk in "3 * 4 = 12" turns the rest of the line italic, and an underscore in a file name eats
// everything after it.
function closerAt(text: string, from: number, token: string): number {
  return text.indexOf(token, from);
}

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buffer = "";
  let bold = false;
  let italic = false;

  const flush = () => {
    if (!buffer) return;
    spans.push({
      text: buffer,
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
    });
    buffer = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    // A backslash escapes the next character, which is the only way to write a literal marker.
    if (ch === "\\" && i + 1 < text.length) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    const marker = MARKERS.find((m) => text.startsWith(m.token, i));
    if (marker) {
      const open = marker.key === "bold" ? bold : italic;
      const hasCloser =
        closerAt(text, i + marker.token.length, marker.token) !== -1;
      if (open || hasCloser) {
        flush();
        if (marker.key === "bold") bold = !bold;
        else italic = !italic;
        i += marker.token.length;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return spans;
}

const BULLET_RE = /^\s*[-*•]\s+/;

export function parseSimpleMarkdown(text: string): MarkdownLine[] {
  return text.split("\n").map((raw) => {
    const bullet = BULLET_RE.test(raw);
    const body = bullet ? raw.replace(BULLET_RE, "") : raw;
    return {
      kind: bullet ? ("bullet" as const) : ("paragraph" as const),
      spans: parseInline(body),
    };
  });
}
