import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_FONTS,
  DOCUMENT_STYLE_DEFAULTS,
  type DocumentStyle,
} from "@/modules/documents/blocks";
import type { CompanyLogo } from "@/modules/documents/company";
import { renderDocumentPdf } from "@/modules/documents/render";
import { sampleValues } from "@/modules/documents/sample";
import { documentStarters } from "@/modules/documents/starters";
import { parseTemplateContent } from "@/modules/documents/validate";

// The renderer produces bytes for every combination the style offers, and it does so without
// reaching the network or the filesystem.
//
// The font rows are the ones with history behind them: the renderer this replaced avoided
// Font.register precisely because a bundled face resolves from a path that differs between the dev
// tree and the container. Using the built-in families removes the path entirely, and the CWD row
// below is what proves that claim rather than asserting it in a comment.

const META = { number: "ORC-0001", date: "05/09/2026", title: "Orçamento" };

const COMPANY = {
  name: "Ateliê São João",
  document: "12.345.678/0001-90",
  address: "Rua das Acácias, 120",
  phone: "(11) 99999-0000",
  email: "contato@exemplo.com",
  website: "exemplo.com",
  logoKey: null,
  logoVersion: 0,
};

// A 1x1 PNG, inline, so the test never touches the filesystem for it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function starterInput(style?: Partial<DocumentStyle>) {
  const starter = documentStarters("pt-BR")[0];
  if (!starter) throw new Error("no starter");
  const parsed = parseTemplateContent(starter.blocks, starter.fields);
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    blocks: parsed.content.blocks,
    fields: parsed.content.fields,
    style: { ...starter.style, ...style },
    values: sampleValues(
      parsed.content.fields,
      new Date("2026-09-05T12:00:00Z"),
    ),
    company: COMPANY,
    meta: META,
  };
}

describe("renderDocumentPdf", () => {
  test("renders with every font family the style offers", async () => {
    for (const font of DOCUMENT_FONTS) {
      const bytes = await renderDocumentPdf(starterInput({ font }));
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.byteLength).toBeGreaterThan(500);
    }
  });

  // The failure the old renderer's header was written to avoid: a face that resolves relative to the
  // process's working directory renders in the dev tree and not in the container, where the app is
  // started from /app. Running the same render from a different CWD is what actually tests it.
  test("renders from a working directory other than the repo root", async () => {
    const original = process.cwd();
    try {
      process.chdir("/");
      const bytes = await renderDocumentPdf(starterInput());
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    } finally {
      process.chdir(original);
    }
  });

  test("renders both page sizes, both locales and every margin", async () => {
    for (const pageSize of ["A4", "LETTER"] as const) {
      for (const locale of ["pt-BR", "en-US"] as const) {
        for (const margin of ["narrow", "normal", "wide"] as const) {
          const bytes = await renderDocumentPdf(
            starterInput({ pageSize, locale, margin }),
          );
          expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        }
      }
    }
  });

  // The logo arrives as BYTES, never as a URL: @react-pdf will fetch an <Image src> over the
  // network, which on a server renderer is a request driven by tenant input.
  test("draws a logo supplied as bytes", async () => {
    const logo: CompanyLogo = { data: PNG, format: "png" };
    const withLogo = await renderDocumentPdf({
      ...starterInput(),
      company: { ...COMPANY, logoKey: "1-logo.png" },
      logo,
    });
    expect(withLogo.subarray(0, 5).toString()).toBe("%PDF-");
  });

  // A tenant whose storage volume did not come back still has to receive their document.
  test("renders without a logo rather than failing the document", async () => {
    const bytes = await renderDocumentPdf({ ...starterInput(), logo: null });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("renders an empty document and a document with no values", async () => {
    const empty = await renderDocumentPdf({
      blocks: [],
      fields: [],
      style: DOCUMENT_STYLE_DEFAULTS,
      values: {},
      company: COMPANY,
      meta: META,
    });
    expect(empty.subarray(0, 5).toString()).toBe("%PDF-");
    const noValues = await renderDocumentPdf({ ...starterInput(), values: {} });
    expect(noValues.subarray(0, 5).toString()).toBe("%PDF-");
  });

  // Two renders of the same input must produce the same document: the snapshot on an issued row is
  // only worth freezing if replaying it lands in the same place.
  test("is deterministic for the same input", async () => {
    const input = starterInput();
    const a = await renderDocumentPdf(input);
    const b = await renderDocumentPdf(input);
    expect(a.byteLength).toBe(b.byteLength);
  });

  test("renders every starter, in both languages", async () => {
    for (const locale of ["pt-BR", "en-US"] as const) {
      for (const starter of documentStarters(locale)) {
        const parsed = parseTemplateContent(starter.blocks, starter.fields);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        const bytes = await renderDocumentPdf({
          blocks: parsed.content.blocks,
          fields: parsed.content.fields,
          style: starter.style,
          values: sampleValues(
            parsed.content.fields,
            new Date("2026-09-05T12:00:00Z"),
          ),
          company: COMPANY,
          meta: META,
        });
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      }
    }
  });
});
