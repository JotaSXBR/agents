// Which characters a document can actually PRINT.
//
// The renderer uses the standard 14 PDF fonts (see render.tsx for why no TTF is bundled), which are
// embedded with WinAnsiEncoding. pdfkit encodes a string one UTF-16 code unit at a time: a unit
// above 255 that its WinAnsi table does not map is written as its own hex — TWO bytes, which the PDF
// reader then draws as two unrelated Latin-1 glyphs.
//
// MEASURED, on this version of @react-pdf/renderer: "A中A" draws as `41 2d 41`, so 中 prints as a
// HYPHEN; "A😀A" draws as `41 3d00 41`, so an emoji prints as "=". Nothing throws and nothing warns.
// That is the whole reason this exists: the failure is not a missing glyph box an operator would
// notice, it is a plausible-looking character in a document the customer keeps — a name spelled
// wrong in a receipt, silently.
//
// So the answer is to REFUSE, at the keyboard and at the turn, rather than print something else.
// Stripping would be the same lie with fewer characters, and bundling a Unicode font is the trade
// render.tsx already declined with its own measurements.
//
// The rule is pdfkit's, not ours, and a copy of someone else's predicate goes stale silently — so
// tests/modules/document-printable.test.ts asserts it against the RENDERER in both directions:
// everything this accepts survives the round trip, and everything it refuses is mangled.
const WIN_ANSI_ABOVE_LATIN1 = new Set([
  338, 339, 352, 353, 376, 381, 382, 402, 710, 732, 8211, 8212, 8216, 8217,
  8218, 8220, 8221, 8222, 8224, 8225, 8226, 8230, 8240, 8249, 8250, 8364, 8482,
]);

export function isPrintableCodeUnit(code: number): boolean {
  return code <= 255 || WIN_ANSI_ABOVE_LATIN1.has(code);
}

// The offending characters, in order and without repeats, so a refusal can quote them. Empty when
// the text prints as written.
export function unprintableCharacters(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // A character outside the BMP is two code units, and BOTH are unmapped — reported once, as the
    // character the operator actually typed.
    const printable = code > 0xffff ? false : isPrintableCodeUnit(code);
    if (!printable && !found.includes(ch)) found.push(ch);
  }
  return found;
}

// The refusal, phrased for whoever hit it: an operator writing a template, or a model filling a
// field in. It names the characters, because "this text cannot be printed" about a 2,000-character
// block is not something anyone can act on.
export function unprintableProblem(text: string, what: string): string | null {
  const bad = unprintableCharacters(text);
  if (bad.length === 0) return null;
  return `${what} contains characters this document cannot print (${bad.join(" ")}) — the PDF fonts cover Latin text only, and printing them anyway would put a different character in the document.`;
}
