import type { DocumentStyle } from "./blocks";

// Locale-aware formatting for the values a document prints. Bun ships full ICU, so Intl is the right
// tool here — the old quote renderer avoided it and printed "1299.90 BRL", which is not how a price
// is written anywhere.
//
// NOTE: pt-BR currency output contains U+00A0 (a non-breaking space) between the symbol and the
// number, not a plain space. That is correct typography and is kept; a test that compares against a
// normal space fails, and a test that strips whitespace to make it pass stops testing anything.

export function formatMoney(
  value: number,
  locale: DocumentStyle["locale"],
  currency: string,
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // An unknown currency code throws rather than degrading. The document still has to render, and
    // "1299.90 XYZ" is legible; refusing to produce the PDF is not.
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(
  value: number,
  locale: DocumentStyle["locale"],
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(
    value,
  );
}

// Takes the ISO date the value schema enforces and prints it in the document's locale. Parsed as
// UTC noon rather than midnight: a date-only string parsed as UTC midnight and formatted in a
// western timezone lands on the previous day, which is how a validity date silently loses 24 hours.
export function formatDate(
  iso: string,
  locale: DocumentStyle["locale"],
): string {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(parsed);
}

// The document's own number, as printed: the template's prefix plus the counter, zero-padded so a
// list of them sorts and lines up.
export function formatDocumentNumber(
  n: number | null | undefined,
  prefix: string | null | undefined,
): string {
  if (n === null || n === undefined) return "";
  return `${prefix ?? ""}${String(n).padStart(4, "0")}`;
}
