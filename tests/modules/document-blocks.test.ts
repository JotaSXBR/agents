import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_STYLE_DEFAULTS,
  MAX_BLOCKS_PER_DOCUMENT,
  MAX_LINE_ITEMS,
  parseDocumentStyle,
} from "@/modules/documents/blocks";
import {
  parseDocumentValues,
  parseTemplateContent,
} from "@/modules/documents/validate";

// The authoring rules as a table. Every row states one rule from the header of `validate.ts`, and
// the DB-backed suite then proves the write path applies the decision rather than proving the
// decision is right.
//
// The rule this file exists for: a template must be refused at AUTHORING time when a token would not
// resolve. Downstream it becomes a blank space in a PDF the customer keeps, and nothing anywhere
// reports it.

const FIELDS = [
  { name: "cliente", label: "Cliente", type: "text", required: true },
  { name: "itens", label: "Itens", type: "lineItems" },
  { name: "desconto", label: "Desconto", type: "currency" },
  { name: "validade", label: "Validade", type: "date" },
];

function blocks(...extra: unknown[]): unknown[] {
  return [{ id: "h", type: "header", title: "Orçamento" }, ...extra];
}

describe("parseTemplateContent", () => {
  test("accepts a template whose tokens all resolve", () => {
    const r = parseTemplateContent(
      blocks(
        {
          id: "t",
          type: "text",
          text: "Olá {{cliente}}, vale até {{validade}}.",
        },
        { id: "li", type: "lineItems", field: "itens" },
        {
          id: "tot",
          type: "totals",
          field: "itens",
          discountField: "desconto",
        },
      ),
      FIELDS,
    );
    expect(r.ok).toBe(true);
  });

  test("accepts a reserved token without a field behind it", () => {
    const r = parseTemplateContent(
      blocks({
        id: "t",
        type: "text",
        text: "{{company_name}} · {{empresa_documento}} · {{doc_number}}",
      }),
      FIELDS,
    );
    expect(r.ok).toBe(true);
  });

  // The rule the file exists for.
  test("refuses a token that names neither a field nor a reserved name", () => {
    const r = parseTemplateContent(
      blocks({ id: "t", type: "text", text: "Prazo: {{prazo}}" }),
      FIELDS,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("{{prazo}}");
  });

  // A token in a header's meta value reaches the customer exactly like one in a paragraph. This is
  // the row that catches a text-carrying property nobody remembered to validate.
  test("checks tokens in a header's meta and in a fields block, not only in text", () => {
    const inMeta = parseTemplateContent(
      [
        {
          id: "h",
          type: "header",
          meta: [{ label: "Validade", value: "{{inexistente}}" }],
        },
      ],
      FIELDS,
    );
    expect(inMeta.ok).toBe(false);
    const inRows = parseTemplateContent(
      blocks({
        id: "f",
        type: "fields",
        rows: [{ label: "Total", value: "{{inexistente}}" }],
      }),
      FIELDS,
    );
    expect(inRows.ok).toBe(false);
  });

  test("refuses a field whose name would shadow the letterhead", () => {
    const r = parseTemplateContent(blocks(), [
      { name: "empresa_nome", label: "Nome", type: "text" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("reserved prefix");
  });

  test("refuses a duplicate field name and a duplicate block id", () => {
    const dupField = parseTemplateContent(blocks(), [
      { name: "x", label: "A", type: "text" },
      { name: "x", label: "B", type: "text" },
    ]);
    expect(dupField.ok).toBe(false);
    const dupBlock = parseTemplateContent(
      [
        { id: "same", type: "divider" },
        { id: "same", type: "divider" },
      ],
      [],
    );
    expect(dupBlock.ok).toBe(false);
    expect(dupBlock.ok === false && dupBlock.reason).toContain(
      "duplicate block id",
    );
  });

  test("refuses a lineItems block pointing at a missing field, or at the wrong type", () => {
    const missing = parseTemplateContent(
      blocks({ id: "li", type: "lineItems", field: "nao_existe" }),
      FIELDS,
    );
    expect(missing.ok).toBe(false);
    const wrongType = parseTemplateContent(
      blocks({ id: "li", type: "lineItems", field: "cliente" }),
      FIELDS,
    );
    expect(wrongType.ok).toBe(false);
    expect(wrongType.ok === false && wrongType.reason).toContain("lineItems");
  });

  test("refuses a totals discountField that is not an amount", () => {
    const r = parseTemplateContent(
      blocks({
        id: "tot",
        type: "totals",
        field: "itens",
        discountField: "validade",
      }),
      FIELDS,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("discountField");
  });

  test("refuses an unknown block type, naming the ones that exist", () => {
    const r = parseTemplateContent([{ id: "x", type: "image" }], []);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("lineItems");
  });

  // The preview renders on the request thread with operator-supplied input, so the bound is checked
  // BEFORE anything is laid out.
  test("refuses more blocks than the ceiling", () => {
    const many = Array.from(
      { length: MAX_BLOCKS_PER_DOCUMENT + 1 },
      (_, i) => ({
        id: `b${i}`,
        type: "divider",
      }),
    );
    const r = parseTemplateContent(many, []);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(
      String(MAX_BLOCKS_PER_DOCUMENT),
    );
  });
});

describe("parseDocumentValues", () => {
  test("accepts the declared shapes and drops nothing", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [{ description: "Serviço", quantity: 2, unitPrice: 100 }],
      desconto: 50,
      validade: "2026-09-01",
    });
    expect(r.ok).toBe(true);
    expect(r.ok === true && Object.keys(r.values).sort()).toEqual([
      "cliente",
      "desconto",
      "itens",
      "validade",
    ]);
  });

  test("refuses a missing required field, and allows a missing optional one", () => {
    const missing = parseDocumentValues(FIELDS as never, { itens: [] });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reason).toContain("cliente");
    const optional = parseDocumentValues(FIELDS as never, { cliente: "Ana" });
    expect(optional.ok).toBe(true);
  });

  // A key the template never declared is refused rather than ignored: silently dropping it is how a
  // model believes it sent a value that never reaches the page.
  test("refuses a key the template does not declare", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      observacao: "algo",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("observacao");
  });

  // A pre-formatted date cannot be re-rendered in the document's locale, so it is refused at the
  // door rather than printed as a Brazilian date in the middle of an en-US page.
  test("refuses a date that is not ISO", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      validade: "01/09/2026",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("ISO date");
  });

  test("refuses a non-finite amount and a malformed line item", () => {
    const nan = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      desconto: Number.POSITIVE_INFINITY,
    });
    expect(nan.ok).toBe(false);
    const bad = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [{ description: "x" }],
    });
    expect(bad.ok).toBe(false);
  });

  test("refuses more line items than the ceiling", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: Array.from({ length: MAX_LINE_ITEMS + 1 }, () => ({
        description: "x",
        quantity: 1,
        unitPrice: 1,
      })),
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(String(MAX_LINE_ITEMS));
  });
});

describe("parseDocumentStyle", () => {
  test("fills defaults and keeps what was supplied", () => {
    const s = parseDocumentStyle({ font: "serif", accentColor: "#AABBCC" });
    expect(s.font).toBe("serif");
    expect(s.accentColor).toBe("#AABBCC");
    expect(s.pageSize).toBe(DOCUMENT_STYLE_DEFAULTS.pageSize);
  });

  // The size is CLAMPED, not refused: the MCP schema publishes no bound (docs/mcp.md, "type and
  // choice, never size"), so a bound enforced here would accept in the console what it rejects over
  // MCP for the same write.
  test("clamps the base font size instead of refusing it", () => {
    expect(parseDocumentStyle({ baseFontSize: 40 }).baseFontSize).toBe(14);
    expect(parseDocumentStyle({ baseFontSize: 2 }).baseFontSize).toBe(8);
    expect(parseDocumentStyle({ baseFontSize: 10.4 }).baseFontSize).toBe(10);
  });

  test("falls back to defaults for a block written by an older version", () => {
    expect(parseDocumentStyle({ font: "comic-sans" })).toEqual(
      DOCUMENT_STYLE_DEFAULTS,
    );
    expect(parseDocumentStyle(null)).toEqual(DOCUMENT_STYLE_DEFAULTS);
  });
});
