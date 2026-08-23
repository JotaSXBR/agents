import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_STYLE_DEFAULTS,
  documentAuthoringSchema,
  MAX_BLOCKS_PER_DOCUMENT,
  MAX_DOCUMENT_AMOUNT,
  MAX_FIELDS_PER_DOCUMENT,
  MAX_LINE_ITEMS,
  parseDocumentStyle,
} from "@/modules/documents/blocks";
import { printedDate } from "@/modules/documents/issue";
import { computeTotals } from "@/modules/documents/totals";
import {
  parseAuthoredTemplate,
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

// ── the authoring gate ──
//
// Two questions, deliberately answered differently. Reading a STORED row has to be tolerant: a row
// written by a newer build must still render, so an unknown key is dropped rather than fatal.
// Reading an AUTHORED template has to be strict: what the operator wrote either takes effect or is
// refused by name, because the alternative is a template that silently differs from the one they
// submitted and nothing anywhere says so.
describe("parseAuthoredTemplate (writes) vs parseTemplateContent (stored rows)", () => {
  test("names a misspelled block property instead of dropping it", () => {
    const bad = [{ id: "t", type: "text", text: "Olá", alignn: "center" }];
    const authored = parseAuthoredTemplate(bad, FIELDS, {});
    expect(authored.ok).toBe(false);
    expect(authored.ok === false && authored.reason).toContain("alignn");
    // …and the stored reader still takes it, minus the key it does not know.
    const stored = parseTemplateContent(bad, FIELDS, {});
    expect(stored.ok).toBe(true);
  });

  test("names a misspelled key nested inside a block", () => {
    const r = parseAuthoredTemplate(
      [
        {
          id: "h",
          type: "header",
          meta: [{ label: "Cliente", value: "{{cliente}}", bold: true }],
        },
      ],
      FIELDS,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("bold");
  });

  test("names a misspelled field property", () => {
    const r = parseAuthoredTemplate(
      blocks(),
      [{ name: "cliente", label: "Cliente", type: "text", requred: true }],
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("requred");
  });

  // The tolerant reader answers an invalid style by returning EVERY default, so a write that named
  // one bad colour would be saved with the operator's font, margin and currency thrown away too —
  // and reported as a success.
  test("refuses an invalid style value rather than resetting the whole style", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, {
      font: "serif",
      accentColor: "red",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("accentColor");
    // The stored reader keeps its tolerance: a row like that still renders, on defaults.
    expect(
      parseTemplateContent(blocks(), FIELDS, {
        font: "serif",
        accentColor: "red",
      }).ok,
    ).toBe(true);
  });

  test("names a misspelled style property", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, { fontt: "serif" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("fontt");
  });

  // baseFontSize is CLAMPED, not refused (docs/mcp.md: "type and choice, never size"), and the clamp
  // changes a value rather than dropping a key — so it must survive the strict pass.
  test("still clamps the base font size instead of refusing it", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, { baseFontSize: 400 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.content.style.baseFontSize).toBe(14);
  });

  test("accepts a well-formed template and returns the parsed style", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, { font: "mono" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.content.style.font).toBe("mono");
  });

  // The declared fields become the agent's tool schema, published on every turn. Unbounded, a single
  // write turns every turn of every granted agent into a payload the provider may refuse outright.
  test("refuses more declared fields than the ceiling", () => {
    const many = Array.from(
      { length: MAX_FIELDS_PER_DOCUMENT + 1 },
      (_, i) => ({
        name: `campo_${i}`,
        label: `Campo ${i}`,
        type: "text",
      }),
    );
    const r = parseAuthoredTemplate([], many, {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(
      String(MAX_FIELDS_PER_DOCUMENT),
    );
  });
});

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
      {},
    );
    expect(r.ok).toBe(true);
  });

  // The footer is rendered through the SAME token resolver the block texts are, and it prints on
  // every page. A typo there is the most invisible kind: it costs a blank on the last line of a
  // document the customer keeps, and nothing in the console ever says so.
  test("refuses an unresolvable token in the style's footer", () => {
    const r = parseTemplateContent(blocks(), FIELDS, {
      footerText: "{{empresa}} · {{doc_number}}",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("footerText");
    expect(r.ok === false && r.reason).toContain("empresa");
  });

  test("accepts a footer built from declared fields and reserved names", () => {
    const r = parseTemplateContent(blocks(), FIELDS, {
      footerText: "{{company_name}} · {{doc_number}} · {{cliente}}",
    });
    expect(r.ok).toBe(true);
  });

  // A token the RESOLVER cannot even read as a name. It matches nothing, so the "unknown token"
  // scan never saw it and authoring succeeded — and then the resolver did not match it either, so
  // the braces printed verbatim in a document the customer keeps. The invariant is that an
  // expression which will not resolve is refused when written, and that has to include the ones we
  // could not parse as a name at all.
  test("refuses a token expression the resolver cannot read", () => {
    for (const text of [
      "Olá {{Cliente}}",
      "Olá {{company-name}}",
      "Olá {{ 1cliente }}",
      "Olá {{}}",
    ]) {
      const r = parseTemplateContent(
        blocks({ id: "t", type: "text", text }),
        FIELDS,
        {},
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain("not a readable token");
    }
    // The same rule on the footer, which prints on every page.
    const footer = parseTemplateContent(blocks(), FIELDS, {
      footerText: "{{Company_name}}",
    });
    expect(footer.ok).toBe(false);
    expect(footer.ok === false && footer.reason).toContain("footerText");
  });

  test("accepts a reserved token without a field behind it", () => {
    const r = parseTemplateContent(
      blocks({
        id: "t",
        type: "text",
        text: "{{company_name}} · {{empresa_documento}} · {{doc_number}}",
      }),
      FIELDS,
      {},
    );
    expect(r.ok).toBe(true);
  });

  // The rule the file exists for.
  test("refuses a token that names neither a field nor a reserved name", () => {
    const r = parseTemplateContent(
      blocks({ id: "t", type: "text", text: "Prazo: {{prazo}}" }),
      FIELDS,
      {},
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
      {},
    );
    expect(inMeta.ok).toBe(false);
    const inRows = parseTemplateContent(
      blocks({
        id: "f",
        type: "fields",
        rows: [{ label: "Total", value: "{{inexistente}}" }],
      }),
      FIELDS,
      {},
    );
    expect(inRows.ok).toBe(false);
  });

  test("refuses a field whose name would shadow the letterhead", () => {
    const r = parseTemplateContent(
      blocks(),
      [{ name: "empresa_nome", label: "Nome", type: "text" }],
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("reserved prefix");
  });

  test("refuses a duplicate field name and a duplicate block id", () => {
    const dupField = parseTemplateContent(
      blocks(),
      [
        { name: "x", label: "A", type: "text" },
        { name: "x", label: "B", type: "text" },
      ],
      {},
    );
    expect(dupField.ok).toBe(false);
    const dupBlock = parseTemplateContent(
      [
        { id: "same", type: "divider" },
        { id: "same", type: "divider" },
      ],
      [],
      {},
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
      {},
    );
    expect(missing.ok).toBe(false);
    const wrongType = parseTemplateContent(
      blocks({ id: "li", type: "lineItems", field: "cliente" }),
      FIELDS,
      {},
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
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("discountField");
  });

  test("refuses an unknown block type, naming the ones that exist", () => {
    const r = parseTemplateContent([{ id: "x", type: "image" }], [], {});
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
    const r = parseTemplateContent(many, [], {});
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

  // Shape is not enough: a date the calendar does not have is a string of the right form, and the
  // renderer does not refuse it — JavaScript rolls 2026-02-31 forward to March 3, so the customer
  // keeps a PDF carrying a date nobody typed. It has to round-trip to the same day or be refused.
  test("refuses a date the calendar does not have", () => {
    for (const validade of [
      "2026-02-31",
      "2026-13-01",
      "2026-04-31",
      "2026-00-10",
    ]) {
      const r = parseDocumentValues(FIELDS as never, {
        cliente: "Ana",
        validade,
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain("ISO date");
    }
    // The leap day of a leap year is a real date, and stays one.
    expect(
      parseDocumentValues(FIELDS as never, {
        cliente: "Ana",
        validade: "2028-02-29",
      }).ok,
    ).toBe(true);
    expect(
      parseDocumentValues(FIELDS as never, {
        cliente: "Ana",
        validade: "2026-02-29",
      }).ok,
    ).toBe(false);
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

  // "Required" has to mean the document ends up with the thing. An empty list is present, so it
  // clears the missing-value check, and the array parser has nothing to object to — leaving an agent
  // able to issue a numbered quote with no rows and a total of zero, in front of a customer, with
  // every gate reporting success.
  test("refuses an empty list for a required lineItems field", () => {
    const r = parseDocumentValues(
      [
        { name: "itens", label: "Itens", type: "lineItems", required: true },
      ] as never,
      { itens: [] },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("itens");
    // An OPTIONAL list is different: nothing was promised, and the block simply renders empty.
    const optional = parseDocumentValues(
      [{ name: "extras", label: "Extras", type: "lineItems" }] as never,
      { extras: [] },
    );
    expect(optional.ok).toBe(true);
  });

  // Required has to mean the customer READS something. Whitespace and control characters are
  // non-empty as a string and empty once sanitised, so a required customer name could clear every
  // gate and come out as a blank line on a numbered document.
  test("refuses required text that is blank once sanitised", () => {
    const required = [
      { name: "cliente", label: "Cliente", type: "text", required: true },
    ] as never;
    for (const cliente of ["   ", "\u0000\u0001", "\u00a0\u00a0"]) {
      const r = parseDocumentValues(required, { cliente });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain("cliente");
    }
    expect(parseDocumentValues(required, { cliente: " Ana " }).ok).toBe(true);
    // An OPTIONAL text field is free to be blank: nothing was promised.
    expect(
      parseDocumentValues(
        [{ name: "obs", label: "Obs", type: "text" }] as never,
        { obs: "   " },
      ).ok,
    ).toBe(true);
  });

  // Finite is not the same as usable. The arithmetic is in integer cents, so a unit price of 1e308
  // clears `Number.isFinite` and then becomes Infinity in cents — a numbered PDF whose total reads
  // as infinity, or, one order down, one that is merely wrong.
  test("refuses amounts the cent arithmetic cannot hold", () => {
    const over = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      desconto: 1e308,
    });
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.reason).toContain("at most");

    // A quantity and a unit price can each be inside the cap while their product is outside it.
    const line = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [
        {
          description: "Consultoria",
          quantity: MAX_DOCUMENT_AMOUNT,
          unitPrice: MAX_DOCUMENT_AMOUNT,
        },
      ],
    });
    expect(line.ok).toBe(false);
    expect(line.ok === false && line.reason).toContain("Consultoria");

    // A full document at the ceiling still adds up exactly: MAX_LINE_ITEMS lines of the cap stay
    // inside the safe-integer range the cents live in, which is how the cap was chosen.
    const atCeiling = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: Array.from({ length: MAX_LINE_ITEMS }, () => ({
        description: "x",
        quantity: 1,
        unitPrice: MAX_DOCUMENT_AMOUNT,
      })),
    });
    expect(atCeiling.ok).toBe(true);
    const totals = computeTotals(
      Array.from({ length: MAX_LINE_ITEMS }, () => ({
        description: "x",
        quantity: 1,
        unitPrice: MAX_DOCUMENT_AMOUNT,
      })),
    );
    expect(Number.isSafeInteger(Math.round(totals.total * 100))).toBe(true);
    expect(totals.total).toBe(MAX_LINE_ITEMS * MAX_DOCUMENT_AMOUNT);
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

// The contract a client authors against and the gate a write passes through have to be the same
// statement. Zod strips an unknown key; the write refuses it by name (see the authoring gate above),
// so a schema published without `additionalProperties: false` would promise a permissiveness no
// write honours — and the client would be refused by a document it had every reason to trust.
describe("documentAuthoringSchema", () => {
  test("publishes every object as closed, nested rows included", () => {
    const schema = documentAuthoringSchema();
    const open: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => {
          walk(n, `${path}[${i}]`);
        });
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if ("properties" in obj && obj.additionalProperties !== false) {
        open.push(path);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    };
    walk(schema, "");
    expect(open).toEqual([]);
    // …and it does reach inside a block, not just the top of one.
    expect(JSON.stringify(schema.blocks)).toContain("additionalProperties");
  });
});

// Which day a document PRINTS. Two fields can answer, and only one of them is right for a customer
// east or west of UTC — the mistake is invisible in the bytes, so it is pinned here.
describe("printedDate", () => {
  test("prints the frozen day, not the UTC slice of the instant", () => {
    expect(
      printedDate({
        // 22:30 on the 5th in São Paulo, which is the 6th in UTC.
        issuedAt: "2026-09-06T01:30:00.000Z",
        issuedDate: "2026-09-05",
      }),
    ).toBe("2026-09-05");
  });

  // A row written before the frozen day existed was rendered from the slice; re-rendering it must
  // not silently move its date.
  test("falls back to the instant's day only when nothing was frozen", () => {
    expect(printedDate({ issuedAt: "2026-09-06T01:30:00.000Z" })).toBe(
      "2026-09-06",
    );
  });
});
