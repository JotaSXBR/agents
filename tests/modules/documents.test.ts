import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clearCompanyLogo, setCompanyLogo } from "@/modules/documents/company";
import {
  getIssuedDocumentPdf,
  issueDocument,
  listIssuedDocuments,
  revokeIssuedDocument,
  storageKey,
} from "@/modules/documents/issue";
import { documentStarter } from "@/modules/documents/starters";
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  getDocumentTemplate,
  previewDocumentTemplate,
  SLUG_MAX,
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import {
  readCompanySettings,
  setCompanyLogoKey,
  updateCompanySettings,
} from "@/modules/tenant-settings/service";

// DB-backed: what the scoped writes and the RLS fence actually do. The rules themselves are a table
// in document-blocks.test.ts; this file proves the persistence follows the decision — and covers the
// three things only a real database can answer: idempotency under a repeated key, numbering under
// concurrency, and one tenant reaching for another's bytes.

// A layout that PRINTS something. An empty one is refused at authoring — every issued document
// would be a numbered blank page — so a fixture that only cares about names and slugs still has to
// carry a block.
const MINIMAL_BLOCKS = [{ id: "corpo", type: "text", text: "Olá." }];

function pdfHeader(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8.subarray(0, 5)).toString("latin1");
}

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const DIR = `/tmp/fazerai-documents-${process.pid}`;
let tenantA = 0n;
let tenantB = 0n;
let templateId = 0n;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

const VALUES = {
  cliente: "Ana Ribeiro",
  itens: [
    { description: "Consultoria", quantity: 2, unitPrice: 450 },
    { description: "Treinamento", quantity: 1, unitPrice: 1299.9 },
  ],
  desconto: 100,
  validade: "2026-09-05",
};

describe.skipIf(!dbUp)("document templates + issuance", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "DocA", slug: `doc-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "DocB", slug: `doc-b-${process.pid}` },
    });
    tenantB = b.id;
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: starter.name,
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        numberPrefix: "ORC-",
      },
      appDb,
    );
    templateId = BigInt(tpl.id);
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      for (const table of [
        "agent_tool_selections",
        "issued_documents",
        "document_templates",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
    await rm(DIR, { recursive: true, force: true });
  });

  test("creates a template and derives the agent's tool name from it", async () => {
    const tpl = await getDocumentTemplate(ctx(tenantA), templateId, appDb);
    expect(tpl.slug).toBe("orcamento");
    expect(tpl.toolName).toBe("send_orcamento");
    expect(tpl.blocks.length).toBeGreaterThan(0);
  });

  test("refuses a template whose blocks and fields disagree", async () => {
    await expect(
      createDocumentTemplate(
        ctx(tenantA),
        {
          name: "Quebrado",
          blocks: [{ id: "li", type: "lineItems", field: "nao_existe" }],
          fields: [],
        },
        appDb,
      ),
    ).rejects.toThrow(/not a declared field/);
  });

  // Half the rules are about how blocks and fields refer to each other, so patching one has to
  // re-check both. Validating only the half that was sent accepts a template whose blocks point at
  // fields the same request just removed.
  test("re-validates both halves when only one is patched", async () => {
    await expect(
      updateDocumentTemplate(ctx(tenantA), templateId, { fields: [] }, appDb),
    ).rejects.toThrow();
    const still = await getDocumentTemplate(ctx(tenantA), templateId, appDb);
    expect(still.fields.length).toBeGreaterThan(0);
  });

  test("refuses a slug that would collide with a built-in tool", async () => {
    await expect(
      createDocumentTemplate(
        ctx(tenantA),
        { name: "Imagem", slug: "image", blocks: MINIMAL_BLOCKS, fields: [] },
        appDb,
      ),
    ).rejects.toThrow(/built-in tool/);
  });

  test("previews an unsaved draft without issuing anything", async () => {
    const before = await listIssuedDocuments(ctx(tenantA), {}, appDb);
    const bytes = await previewDocumentTemplate(
      ctx(tenantA),
      {
        name: "Rascunho",
        blocks: [{ id: "t", type: "text", text: "Olá {{cliente}}" }],
        fields: [{ name: "cliente", label: "Cliente", type: "text" }],
      },
      appDb,
    );
    expect(pdfHeader(bytes)).toBe("%PDF-");
    const after = await listIssuedDocuments(ctx(tenantA), {}, appDb);
    expect(after.length).toBe(before.length);
    // The preview must not consume the template's counter either.
    const row = await suDb.documentTemplate.findUnique({
      where: { id: templateId },
      select: { lastNumber: true },
    });
    expect(row?.lastNumber).toBe(0);
  });

  test("issues a READY document with a numbered, retrievable PDF", async () => {
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: "k1",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    expect(doc.status).toBe("READY");
    expect(doc.number).toBe("ORC-0001");
    expect(doc.fileName).toBe("Orcamento-ORC-0001.pdf");
    const { bytes } = await getIssuedDocumentPdf(
      ctx(tenantA),
      BigInt(doc.id),
      appDb,
      DIR,
    );
    expect(pdfHeader(bytes)).toBe("%PDF-");
  });

  test("refuses values the template did not declare", async () => {
    await expect(
      issueDocument({
        tenantId: tenantA,
        templateId,
        idempotencyKey: "bad-values",
        values: { ...VALUES, inventado: "x" },
        base: appDb,
        storageDir: DIR,
      }),
    ).rejects.toThrow(/inventado/);
  });

  // A burst, a retry or a resumed turn carrying the same key must produce ONE document — never two
  // numbered documents in front of one customer.
  test("is idempotent: the same key returns the same document and consumes one number", async () => {
    const first = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: "k2",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    const second = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: "k2",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
      withBytes: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.number).toBe(first.number);
    expect(pdfHeader(second.bytes as ArrayBuffer)).toBe("%PDF-");
    const count = await suDb.issuedDocument.count({
      where: { tenantId: tenantA, idempotencyKey: "k2" },
    });
    expect(count).toBe(1);
  });

  // The counter is bumped with UPDATE … RETURNING on the template row, so the row lock makes the
  // read-modify-write atomic. Concurrent issuances must never take the same number.
  test("numbers concurrent issuances without collision", async () => {
    const before = await suDb.documentTemplate.findUnique({
      where: { id: templateId },
      select: { lastNumber: true },
    });
    const issued = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        issueDocument({
          tenantId: tenantA,
          templateId,
          idempotencyKey: `race-${i}`,
          values: VALUES,
          base: appDb,
          storageDir: DIR,
        }),
      ),
    );
    const numbers = issued.map((d) => d.number);
    expect(new Set(numbers).size).toBe(6);
    const after = await suDb.documentTemplate.findUnique({
      where: { id: templateId },
      select: { lastNumber: true },
    });
    expect(after?.lastNumber).toBe((before?.lastNumber ?? 0) + 6);
  });

  // The snapshot is what makes an issued document immutable: editing the template afterwards cannot
  // change a PDF the customer already holds.
  //
  // It is also the regression guard for the ORDER of the two checks inside issueDocument. Validating
  // the caller's values against the CURRENT template before looking the key up made this retry fail
  // with "cliente is not a declared field" — a 400 for a document that already existed, because the
  // template had since dropped the field. The key means the document is already frozen; nothing
  // about the template as it stands today can change that.
  test("a retried issuance renders the stored snapshot, not the edited template", async () => {
    // Its OWN template: this row gets edited out from under its documents, and doing that to the
    // shared one leaves every later issuance failing on fields the edit removed — a pollution that
    // reads as four unrelated defects.
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const own = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Orçamento congelado",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const ownId = BigInt(own.id);
    const first = await issueDocument({
      tenantId: tenantA,
      templateId: ownId,
      idempotencyKey: "frozen",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
      withBytes: true,
    });
    await updateDocumentTemplate(
      ctx(tenantA),
      ownId,
      {
        blocks: [{ id: "only", type: "text", text: "outra coisa" }],
        fields: [],
      },
      appDb,
    );
    const again = await issueDocument({
      tenantId: tenantA,
      templateId: ownId,
      idempotencyKey: "frozen",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
      withBytes: true,
    });
    expect(again.id).toBe(first.id);
    expect((again.bytes as ArrayBuffer).byteLength).toBe(
      (first.bytes as ArrayBuffer).byteLength,
    );
    const row = await suDb.issuedDocument.findUnique({
      where: { id: BigInt(first.id) },
      select: { snapshot: true },
    });
    const snap = row?.snapshot as { blocks: { id: string }[] };
    expect(snap.blocks.length).toBeGreaterThan(1);
  });

  test("a revoked document stops being served", async () => {
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: "revoke-me",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    await revokeIssuedDocument(ctx(tenantA), BigInt(doc.id), appDb);
    await expect(
      getIssuedDocumentPdf(ctx(tenantA), BigInt(doc.id), appDb, DIR),
    ).rejects.toThrow(/not found/);

    // …including through the key that issued it. The key is derived from the VALUES, so the agent
    // asked to send the same quote again lands back on this exact row — and the retry path returns
    // stored bytes without ever asking the question the download route asks. Revoking would then
    // stop the operator's own link while the agent kept attaching the voided document.
    await expect(
      issueDocument({
        tenantId: tenantA,
        templateId,
        idempotencyKey: "revoke-me",
        values: VALUES,
        withBytes: true,
        base: appDb,
        storageDir: DIR,
      }),
    ).rejects.toThrow(/revoked/);
  });

  // The filesystem has no RLS, so the scoped read of the row — and with it the storage key — is the
  // whole boundary. 404 rather than 403: which of the reasons applies is information about a
  // document the caller may not be entitled to know exists.
  test("a tenant cannot read another tenant's document, nor list it", async () => {
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: "fenced",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    await expect(
      getIssuedDocumentPdf(ctx(tenantB), BigInt(doc.id), appDb, DIR),
    ).rejects.toThrow(/not found/);
    const theirList = await listIssuedDocuments(ctx(tenantB), {}, appDb);
    expect(theirList).toHaveLength(0);
    await expect(
      getDocumentTemplate(ctx(tenantB), templateId, appDb),
    ).rejects.toThrow();
  });

  // The letterhead is read at issue time and frozen into the snapshot, so a profile edited later
  // does not rewrite documents already sent.
  test("freezes the company profile into the issued document", async () => {
    await updateCompanySettings(
      ctx(tenantA),
      { name: "Ateliê São João", document: "12.345.678/0001-90" },
      appDb,
    );
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: "letterhead",
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    await updateCompanySettings(ctx(tenantA), { name: "Outro nome" }, appDb);
    const row = await suDb.issuedDocument.findUnique({
      where: { id: BigInt(doc.id) },
      select: { snapshot: true },
    });
    const snap = row?.snapshot as { company: { name: string } };
    expect(snap.company.name).toBe("Ateliê São João");
  });

  // Deleting a template must not take the documents issued from it with it: the row renders from its
  // own snapshot, and the foreign key is provenance, not a dependency.
  test("deleting a template leaves its issued documents readable", async () => {
    const starter = documentStarter("receipt", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Recibo temporário",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId: BigInt(tpl.id),
      idempotencyKey: "orphan",
      values: {
        cliente: "Ana",
        valor: 100,
        referencia: "serviço",
        pago_em: "2026-09-05",
      },
      base: appDb,
      storageDir: DIR,
    });
    await deleteDocumentTemplate(ctx(tenantA), BigInt(tpl.id), appDb);
    const { bytes } = await getIssuedDocumentPdf(
      ctx(tenantA),
      BigInt(doc.id),
      appDb,
      DIR,
    );
    expect(pdfHeader(bytes)).toBe("%PDF-");
    const row = await suDb.issuedDocument.findUnique({
      where: { id: BigInt(doc.id) },
      select: { templateId: true },
    });
    expect(row?.templateId).toBeNull();
    // The PDF is published by renaming a temporary into place, so a reader never sees a half-written
    // file. The window itself is not reachable from a single-process test (see issue.ts), but the
    // residue is: a successful issuance leaves no `.part` behind.
    const litter = await readdir(`${DIR}/${tenantA}`).catch(() => []);
    expect(litter.filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  // ── the losing side of an idempotency race ──
  //
  // Both callers have to MISS the initial lookup and then collide on the insert, which no amount of
  // luck reaches from a test. Forced here by letting another connection win the key in between: the
  // conflict then lands on the real unique index, in the real transaction, which is the only way to
  // exercise what recovery from it has to survive.
  test("a caller that loses the idempotency race gets the winner's document", async () => {
    const key = `race-${process.pid}`;
    let raced = false;
    const racing = appDb.$extends({
      query: {
        issuedDocument: {
          async create({ args, query }) {
            if (!raced) {
              raced = true;
              await suDb.issuedDocument.create({
                data: {
                  tenantId: tenantA,
                  templateId,
                  title: "Orçamento",
                  // What a real competing issuance writes, which is the point: the row that comes
                  // back has to be the WINNER's, prefix included, not a reconstruction of our own.
                  numberPrefix: "ORC-",
                  idempotencyKey: key,
                  status: "PENDING",
                  snapshot: (args.data as { snapshot: unknown })
                    .snapshot as never,
                },
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const doc = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      base: racing,
      storageDir: DIR,
    });
    expect(raced).toBe(true);
    expect(doc.status).toBe("READY");
    expect(doc.number).toMatch(/^ORC-/);
    expect(
      await suDb.issuedDocument.count({
        where: { tenantId: tenantA, idempotencyKey: key },
      }),
    ).toBe(1);
  });

  // ── the printed number is frozen with the document ──
  //
  // Its own template, because this test EDITS and then DELETES the one it uses.
  //
  // The number a customer reads on the PDF has to keep matching the number the console lists and the
  // file name the download carries. Resolving the prefix from the live template breaks all three at
  // once: renaming ORC- to PROP- rewrites history, and deleting the template (which nulls the FK,
  // by design — the documents survive it) drops the prefix entirely.
  test("prints the number from the prefix frozen at issuance", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Orçamento numerado",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        numberPrefix: "ORC-",
      },
      appDb,
    );
    const tplId = BigInt(tpl.id);
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId: tplId,
      idempotencyKey: `frozen-prefix-${process.pid}`,
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    expect(doc.number).toMatch(/^ORC-\d{4}$/);

    await updateDocumentTemplate(
      ctx(tenantA),
      tplId,
      { numberPrefix: "PROP-" },
      appDb,
    );
    const listed = await listIssuedDocuments(
      ctx(tenantA),
      { templateId: tplId },
      appDb,
    );
    expect(listed.map((d) => d.number)).toContain(doc.number);
    const { fileName } = await getIssuedDocumentPdf(
      ctx(tenantA),
      BigInt(doc.id),
      appDb,
      DIR,
    );
    expect(fileName).toContain(doc.number);

    // And the same after the template is gone, which is when the live join has nothing left to read.
    await deleteDocumentTemplate(ctx(tenantA), tplId, appDb);
    const afterDelete = await getIssuedDocumentPdf(
      ctx(tenantA),
      BigInt(doc.id),
      appDb,
      DIR,
    );
    expect(afterDelete.fileName).toContain(doc.number);
    const orphaned = await listIssuedDocuments(ctx(tenantA), {}, appDb);
    expect(orphaned.find((d) => d.id === doc.id)?.number).toBe(doc.number);
  });

  // ── a preview is a render, so its values go through the same gate ──
  //
  // /preview accepts caller-supplied values, and they reach the renderer on the request thread. Left
  // unchecked they are a shape the renderer was never promised: a missing required field silently
  // renders a blank, a string where a number belongs throws inside react-pdf, and a line-item array
  // past MAX_LINE_ITEMS lays out on the API process at whatever length the caller sent.
  test("refuses preview values the template's own fields would refuse", async () => {
    await expect(
      previewDocumentTemplate(
        ctx(tenantA),
        { id: templateId, values: { cliente: "Ana", itens: "não é lista" } },
        appDb,
      ),
    ).rejects.toThrow(/itens/);
    await expect(
      previewDocumentTemplate(
        ctx(tenantA),
        {
          id: templateId,
          values: {
            cliente: "Ana",
            itens: Array.from({ length: 101 }, () => ({
              description: "x",
              quantity: 1,
              unitPrice: 1,
            })),
          },
        },
        appDb,
      ),
    ).rejects.toThrow(/100/);
    // A template id of ZERO is a supplied id, not a missing one. No sequence hands out 0, so the
    // honest answer is "no such template" — the truthy reading rendered a blank draft preview
    // instead, telling the operator their template was fine.
    await expect(
      previewDocumentTemplate(ctx(tenantA), { id: 0n }, appDb),
    ).rejects.toThrow(/not found/i);
    // The blocks a CALLER writes are checked the way a write checks them, unknown property and all.
    // Tolerance belongs to what came out of storage — a property a newer build wrote — and never to
    // what the caller just sent: a preview that accepts it renders a PDF nobody can save.
    await expect(
      previewDocumentTemplate(
        ctx(tenantA),
        {
          id: templateId,
          blocks: [
            { id: "cabecalho", type: "header", title: "X", tagline: "?" },
          ],
        },
        appDb,
      ),
    ).rejects.toThrow(/tagline/);
    // A preview has to show what the SAVE would produce, so it merges a partial style the way the
    // patch does. Replacing outright rendered a saved template without its footer while saving the
    // same patch kept it — the preview approving a document the apply would not make.
    const saved = await getDocumentTemplate(ctx(tenantA), templateId, appDb);
    expect(saved.style.footerText).toBeTruthy();
    const previewed = await previewDocumentTemplate(
      ctx(tenantA),
      { id: templateId, style: { font: "mono" } },
      appDb,
    );
    expect(pdfHeader(previewed)).toBe("%PDF-");
    // The merge itself, observed through the one thing a preview reports out loud: its validation.
    // A template whose SAVED footer names a declared field, previewed with a style patch that does
    // not mention the footer and with the fields removed. Merged, the saved footer is still there
    // and its token now names nothing — refused. Replaced, there is no footer at all and the
    // preview would happily render. The two branches answer differently, which is what makes this
    // an assertion rather than a coincidence.
    const footered = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Com rodapé",
        slug: "com_rodape",
        blocks: [{ id: "t", type: "text", text: "Sem token nenhum." }],
        fields: [{ name: "cliente", label: "Cliente", type: "text" }],
        style: { footerText: "{{cliente}}" },
      },
      appDb,
    );
    const mergedStyle = await previewDocumentTemplate(
      ctx(tenantA),
      { id: BigInt(footered.id), style: { font: "mono" }, fields: [] },
      appDb,
    ).catch((e: unknown) => e);
    expect(mergedStyle).toBeInstanceOf(AppError);
    expect((mergedStyle as AppError).message).toContain("footerText");

    // The metadata gate is the preview's own, not one it inherits from a caller: the REST route
    // reaches this function directly, and a prefix the create would refuse must not render — nor be
    // fed unbounded into a PDF built on the request thread.
    await expect(
      previewDocumentTemplate(
        ctx(tenantA),
        { id: templateId, numberPrefix: "P".repeat(21) },
        appDb,
      ),
    ).rejects.toThrow(/numberPrefix/);
    // …and the same gate holds it to what the page can print: the prefix is DRAWN, at the front of
    // every document number that template ever issues, so a length check alone let a character the
    // fonts turn into a different one through.
    await expect(
      previewDocumentTemplate(
        ctx(tenantA),
        { id: templateId, numberPrefix: "ORÇ😀-" },
        appDb,
      ),
    ).rejects.toThrow(/numberPrefix/);
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { numberPrefix: "ORÇ😀-" },
        appDb,
      ),
    ).rejects.toThrow(/numberPrefix/);

    // The sample-value path is untouched: omitting values still renders.
    const bytes = await previewDocumentTemplate(
      ctx(tenantA),
      { id: templateId },
      appDb,
    );
    expect(pdfHeader(bytes)).toBe("%PDF-");
  });

  // Creation already answers a taken slug with a conflict; an update raising the same constraint has
  // to answer the same way, or the console shows an internal error for a name the operator can fix.
  test("answers a slug already taken on update with a conflict", async () => {
    const starter = documentStarter("receipt", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Recibo para renomear",
        slug: "recibo_para_renomear",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        BigInt(tpl.id),
        { slug: "orcamento" },
        appDb,
      ),
    ).rejects.toThrow(/already exists/);
  });

  // The logo key is derived from the tenant id and the file EXTENSION, so replacing a PNG with
  // another PNG produces the same key. Anything that keys off it — the console's blob, a browser
  // cache of a response served with max-age — would go on showing the previous letterhead while
  // freshly issued documents already carry the new one. The version is the half that moves.
  test("a same-format logo replacement moves the version, though the key does not", async () => {
    const first = await setCompanyLogoKey(
      ctx(tenantB),
      `${tenantB}-logo.png`,
      appDb,
    );
    const second = await setCompanyLogoKey(
      ctx(tenantB),
      `${tenantB}-logo.png`,
      appDb,
    );
    expect(second.logoKey).toBe(first.logoKey);
    expect(second.logoVersion).toBeGreaterThan(first.logoVersion);
    // Two writes inside one millisecond are still two versions: a clock is not a counter.
    const a = await setCompanyLogoKey(
      ctx(tenantB),
      `${tenantB}-logo.png`,
      appDb,
      1_000,
    );
    const b = await setCompanyLogoKey(
      ctx(tenantB),
      `${tenantB}-logo.png`,
      appDb,
      1_000,
    );
    expect(b.logoVersion).toBeGreaterThan(a.logoVersion);
  });

  // A patch that touches ONLY the style still has to be validated: the footer's tokens are checked
  // against the DECLARED FIELDS, which live in the half this patch did not send. A condition that
  // only fires on blocks/fields would save an unresolvable footer without a word.
  test("validates a patch that changes only the style", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Orçamento com rodapé",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const refused = await updateDocumentTemplate(
      ctx(tenantA),
      BigInt(tpl.id),
      { style: { ...starter.style, footerText: "{{nao_declarado}}" } },
      appDb,
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).message).toContain("nao_declarado");
    // A 400 and not the 409 about a newer version: the stored content here reads fine, and the
    // fault is in what the CALLER just sent. The 409 message quotes the original reason, so
    // matching the reason alone cannot tell the two apart — the status is what does.
    expect((refused as AppError).statusCode).toBe(400);
    const after = await getDocumentTemplate(
      ctx(tenantA),
      BigInt(tpl.id),
      appDb,
    );
    expect(after.style.footerText).toBe(starter.style.footerText);
  });

  // The write body is shared by create and update, so `name` cannot be required there — the create
  // route substitutes "". A raw ZodError escaping the service is not a validation response: nothing
  // maps it, so it reaches the fallback handler as an INTERNAL_SERVER_ERROR and the operator gets a
  // 500 for a name they can fix by typing one.
  test("answers a missing or empty name with a 400, never a 500", async () => {
    for (const name of ["", "   ", "x".repeat(121)]) {
      const failed = await createDocumentTemplate(
        ctx(tenantA),
        { name, blocks: MINIMAL_BLOCKS, fields: [] },
        appDb,
      ).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(AppError);
      expect((failed as AppError).statusCode).toBe(400);
      expect((failed as AppError).message).toContain("name");
    }
    // The same question on the update path, which raised the same raw error.
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      { name: "Nomeado", blocks: MINIMAL_BLOCKS, fields: [] },
      appDb,
    );
    const patchFailed = await updateDocumentTemplate(
      ctx(tenantA),
      BigInt(tpl.id),
      { name: "" },
      appDb,
    ).catch((e: unknown) => e);
    expect(patchFailed).toBeInstanceOf(AppError);
    expect((patchFailed as AppError).statusCode).toBe(400);
  });

  // ── two callers healing the same unnumbered row ──
  //
  // A document exists unnumbered for a moment by design: the counter is bumped AFTER the insert so a
  // lost idempotency race consumes no number. In that window the loser of such a race re-reads the
  // row, sees `number: null`, and heals it — at the same time as the winner. Without a claim on the
  // document row, both take a number from the counter, one update is discarded, and the caller whose
  // update lost renders a document with NO number at all and writes it over the winner's PDF: the
  // customer's link then serves a quote with a blank where its identity should be.
  test("two callers healing the same unnumbered document agree on one number", async () => {
    const key = `unnumbered-${process.pid}`;
    const seed = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    // Back to the state the window leaves behind, and to what a crash between the two statements
    // leaves behind too.
    await suDb.issuedDocument.update({
      where: { id: BigInt(seed.id) },
      data: { number: null, status: "PENDING", pdfStorageKey: null },
    });
    const before = await suDb.documentTemplate.findUnique({
      where: { id: templateId },
      select: { lastNumber: true },
    });

    const [a, b] = await Promise.all([
      issueDocument({
        tenantId: tenantA,
        templateId,
        idempotencyKey: key,
        values: VALUES,
        base: appDb,
        storageDir: DIR,
      }),
      issueDocument({
        tenantId: tenantA,
        templateId,
        idempotencyKey: key,
        values: VALUES,
        base: appDb,
        storageDir: DIR,
      }),
    ]);
    expect(a.number).toBe(b.number);
    expect(a.number).toMatch(/^ORC-\d{4}$/);
    const after = await suDb.documentTemplate.findUnique({
      where: { id: templateId },
      select: { lastNumber: true },
    });
    // One number consumed, not two: the claim is what makes the second caller read the first's
    // answer instead of taking one of its own.
    expect(after?.lastNumber).toBe((before?.lastNumber ?? 0) + 1);
  });

  // Two settings writers, one JSON column. The console edits the profile text through one route and
  // uploads the logo through another, so an operator who saves the form while the upload is still in
  // flight has both in flight at once. Read in one transaction and written in another, each merges
  // into the value it read and the later commit discards the other: the profile save erases the logo
  // that had just finished, and both requests answer success.
  test("a profile save and a logo write do not discard each other", async () => {
    await updateCompanySettings(ctx(tenantB), { name: "Antes" }, appDb);
    const [profile, logo] = await Promise.all([
      updateCompanySettings(ctx(tenantB), { name: "Depois" }, appDb),
      setCompanyLogoKey(ctx(tenantB), `${tenantB}-logo.png`, appDb),
    ]);
    expect([profile.name, logo.name]).toContain("Depois");
    const settled = await runScopedOn(appDb, ctx(tenantB), (db) =>
      readCompanySettings(db, tenantB),
    );
    // Both survive: whichever committed second merged into the other's result, not into a stale read.
    expect(settled.name).toBe("Depois");
    expect(settled.logoKey).toBe(`${tenantB}-logo.png`);
  });

  // Revocation has to win every race it is in, and this is the one it could lose: the render happens
  // OUTSIDE any transaction (it is CPU-bound), so an operator can void the document while its PDF is
  // being drawn. Without revocation in the CAS the row would flip to READY afterwards and its bytes
  // would be handed to the agent for delivery — a voided document reaching the customer anyway.
  test("a revocation landing mid-render stops the bytes", async () => {
    const key = `revoke-midrender-${process.pid}`;
    let revokedDuringRender = false;
    let tenantReads = 0;
    // The company profile is read TWICE in one issuance: once to freeze it into the snapshot, before
    // the row exists, and once at render time, after the row exists and before the CAS. The second
    // read is the window this test is about — revoking on the first would land before there is
    // anything to revoke.
    const racing = appDb.$extends({
      query: {
        tenant: {
          async findUnique({ args, query }) {
            const out = await query(args);
            tenantReads++;
            if (tenantReads === 2 && !revokedDuringRender) {
              revokedDuringRender = true;
              await suDb.issuedDocument.updateMany({
                where: { tenantId: tenantA, idempotencyKey: key },
                data: { revoked: true },
              });
            }
            return out;
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(
      issueDocument({
        tenantId: tenantA,
        templateId,
        idempotencyKey: key,
        values: VALUES,
        withBytes: true,
        base: racing,
        storageDir: DIR,
      }),
    ).rejects.toThrow(/revoked/);
    expect(revokedDuringRender).toBe(true);
    const row = await suDb.issuedDocument.findFirst({
      where: { tenantId: tenantA, idempotencyKey: key },
      select: { status: true },
    });
    // Still PENDING: the CAS refused to promote a document that had been voided under it.
    expect(row?.status).toBe("PENDING");
  });

  // The counter lives on the template, and the template can be deleted between the insert and the
  // numbering (the FK nulls templateId by design — documents outlive their template). Rendering
  // anyway would hand the customer a document with a blank where its number belongs.
  test("refuses to render a document it could not number", async () => {
    const starter = documentStarter("receipt", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Recibo efêmero",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const key = `unnumberable-${process.pid}`;
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId: BigInt(tpl.id),
      idempotencyKey: key,
      values: {
        cliente: "Ana",
        valor: 100,
        referencia: "serviço",
        pago_em: "2026-09-05",
      },
      base: appDb,
      storageDir: DIR,
    });
    // Back to the state the window leaves behind, then take the template away.
    await suDb.issuedDocument.update({
      where: { id: BigInt(doc.id) },
      data: { number: null, status: "PENDING", pdfStorageKey: null },
    });
    await deleteDocumentTemplate(ctx(tenantA), BigInt(tpl.id), appDb);
    await expect(
      issueDocument({
        tenantId: tenantA,
        templateId: BigInt(tpl.id),
        idempotencyKey: key,
        values: {
          cliente: "Ana",
          valor: 100,
          referencia: "serviço",
          pago_em: "2026-09-05",
        },
        base: appDb,
        storageDir: DIR,
      }),
    ).rejects.toThrow(/numbered/);
  });

  // What the console actually does: change the WORDS. Sending the whole blocks array to do that
  // makes the console authoritative over a layout it did not author — a block added or reordered
  // over the API while the modal was open would be replaced by the snapshot the modal loaded. Ids
  // exist so an edit survives a reorder from another transport.
  test("a text edit by block id survives a reorder that landed meanwhile", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Orçamento reordenado",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const id = BigInt(tpl.id);
    const textBlock = tpl.blocks.find((b) => b.type === "text");
    if (!textBlock) throw new Error("starter has no text block");

    // Another client appends a block — the console's modal knows nothing about it.
    await updateDocumentTemplate(
      ctx(tenantA),
      id,
      {
        blocks: [
          ...tpl.blocks,
          {
            id: "novo_texto",
            type: "text",
            text: "Adicionado por outro cliente",
          },
        ],
      },
      appDb,
    );

    // …and only then does the console save its wording.
    await updateDocumentTemplate(
      ctx(tenantA),
      id,
      { blockText: { [textBlock.id]: "TEXTO DO CONSOLE" } },
      appDb,
    );

    const after = await getDocumentTemplate(ctx(tenantA), id, appDb);
    expect(after.blocks.some((b) => b.id === "novo_texto")).toBe(true);
    expect(
      after.blocks.find((b) => b.id === textBlock.id) as { text?: string },
    ).toMatchObject({ text: "TEXTO DO CONSOLE" });
  });

  // An id that is not a text block is refused rather than dropped: silently ignoring it is how a
  // caller believes it edited something it did not.
  test("refuses blockText for an id that is not a text block", async () => {
    const tpl = await getDocumentTemplate(ctx(tenantA), templateId, appDb);
    const notText = tpl.blocks.find((b) => b.type !== "text");
    if (!notText) throw new Error("starter has only text blocks");
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { blockText: { [notText.id]: "x" } },
        appDb,
      ),
    ).rejects.toThrow(/not a text block/);
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { blockText: { nao_existe: "x" } },
        appDb,
      ),
    ).rejects.toThrow(/not a text block/);
  });

  // The date a document carries is the day in the AGENT's zone, not in UTC. A quote issued at 22:00
  // in São Paulo is 01:00 UTC the next day, so slicing the instant hands the customer a document
  // dated tomorrow — on paper, with a number on it. Frozen at issuance so a re-render cannot drift.
  test("dates the document by the issuing timezone, not by UTC", async () => {
    const at = new Date("2026-09-06T01:30:00.000Z"); // 22:30 on the 5th in São Paulo
    const doc = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: `tz-${process.pid}`,
      values: VALUES,
      now: at,
      timezone: "America/Sao_Paulo",
      base: appDb,
      storageDir: DIR,
    });
    const row = await suDb.issuedDocument.findUnique({
      where: { id: BigInt(doc.id) },
      select: { snapshot: true },
    });
    const snapshot = row?.snapshot as { issuedAt: string; issuedDate: string };
    expect(snapshot.issuedDate).toBe("2026-09-05");
    // The instant itself is unchanged — it is the DAY that is resolved, not the timestamp.
    expect(snapshot.issuedAt).toBe("2026-09-06T01:30:00.000Z");

    // And a tenant east of UTC lands on the other side of the same instant.
    const tokyo = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: `tz-tokyo-${process.pid}`,
      values: VALUES,
      now: new Date("2026-09-05T22:30:00.000Z"), // 07:30 on the 6th in Tokyo
      timezone: "Asia/Tokyo",
      base: appDb,
      storageDir: DIR,
    });
    const tokyoRow = await suDb.issuedDocument.findUnique({
      where: { id: BigInt(tokyo.id) },
      select: { snapshot: true },
    });
    const tokyoSnapshot = tokyoRow?.snapshot as
      | { issuedDate: string }
      | undefined;
    expect(tokyoSnapshot?.issuedDate).toBe("2026-09-06");
  });

  // Both bounds live at the SERVICE, not on the REST schema, because MCP and an imported bundle do
  // not pass through it. The slug becomes `send_<slug>`, and a provider rejects the whole request
  // over a tool name past its cap — the agent stops replying. The description is appended verbatim
  // to that tool's model-facing description on every turn.
  test("bounds the slug and the description for every transport", async () => {
    await expect(
      createDocumentTemplate(
        ctx(tenantA),
        {
          name: "Longo",
          slug: "a".repeat(SLUG_MAX + 1),
          blocks: MINIMAL_BLOCKS,
          fields: [],
        },
        appDb,
      ),
    ).rejects.toThrow(new RegExp(String(SLUG_MAX)));
    await expect(
      createDocumentTemplate(
        ctx(tenantA),
        {
          name: "Descritivo",
          slug: "descritivo",
          description: "x".repeat(2_001),
          blocks: MINIMAL_BLOCKS,
          fields: [],
        },
        appDb,
      ),
    ).rejects.toThrow(/2000/);
    // An explicit empty slug is a malformed identifier the caller WROTE. A truthiness fallback would
    // silently replace it with one derived from the name — while the MCP dry run, which only fills
    // in an absent slug, refuses exactly that input. Preview and apply have to answer alike.
    await expect(
      createDocumentTemplate(
        ctx(tenantA),
        { name: "Slug vazio", slug: "", blocks: MINIMAL_BLOCKS, fields: [] },
        appDb,
      ),
    ).rejects.toThrow(/slug/);

    // The number prefix is rendered into every document AND returned in the tool's own result, which
    // the flow log stores and the model reads back on the next turn.
    await expect(
      createDocumentTemplate(
        ctx(tenantA),
        {
          name: "Prefixado",
          slug: "prefixado",
          numberPrefix: "P".repeat(21),
          blocks: MINIMAL_BLOCKS,
          fields: [],
        },
        appDb,
      ),
    ).rejects.toThrow(/numberPrefix/);
    // …and on the patch, which is the half an operator reaches by pasting.
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { description: "x".repeat(2_001) },
        appDb,
      ),
    ).rejects.toThrow(/2000/);
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { numberPrefix: "P".repeat(21) },
        appDb,
      ),
    ).rejects.toThrow(/numberPrefix/);
  });

  // The shared write body carries `blockText` because the PATCH needs it, and it means nothing on a
  // create: there is no stored layout to merge into. Accepting and dropping it is the exact failure
  // the field exists to prevent — a 200 that discarded what the caller asked for.
  test("refuses blockText on create instead of dropping it", async () => {
    await expect(
      createDocumentTemplate(
        ctx(tenantA),
        {
          name: "Com blockText",
          slug: "com_block_text",
          blocks: [{ id: "t", type: "text", text: "Olá" }],
          fields: [],
          blockText: { t: "Outro" },
        },
        appDb,
      ),
    ).rejects.toThrow(/only an update/);
  });

  // Storage is tolerant on the way OUT so a row written by a NEWER build still renders here. That
  // guarantee is worth nothing if an ordinary save writes the tolerant READING back: the console
  // always sends style and blockText, so one click would permanently delete the layout the newer
  // build wrote. What the patch does not address is not rewritten.
  test("an ordinary save does not delete content this version cannot read", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Do futuro",
        slug: "do_futuro",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const id = BigInt(tpl.id);
    const textBlock = tpl.blocks.find((b) => b.type === "text");
    if (!textBlock) throw new Error("starter has no text block");

    // What a newer build wrote: a property this version's schema does not know. The schema STRIPS it
    // on the way out, which is the tolerance — and writing that stripped reading back is how the
    // tolerance turns into deletion.
    const fromTheFuture = tpl.blocks.map((b) =>
      b.id === textBlock.id ? { ...b, glow: "neon" } : b,
    );
    await suDb.documentTemplate.update({
      where: { id },
      data: {
        blocks: fromTheFuture as never,
        style: { ...tpl.style, watermark: "RASCUNHO" } as never,
      },
    });

    // …and an ordinary console save: the words, and the style.
    await updateDocumentTemplate(
      ctx(tenantA),
      id,
      {
        blockText: { [textBlock.id]: "TEXTO NOVO" },
        style: { ...tpl.style, font: "mono" },
      },
      appDb,
    );

    const raw = await suDb.documentTemplate.findUnique({
      where: { id },
      select: { blocks: true, style: true },
    });
    const saved = raw?.blocks as { id: string; glow?: string; text?: string }[];
    expect(saved.find((b) => b.id === textBlock.id)?.glow).toBe("neon");
    // The STYLE half of the same contract: the console sends style on every save, so writing the
    // parsed object alone would delete a newer build's settings on an edit to the wording.
    expect((raw?.style as { watermark?: string })?.watermark).toBe("RASCUNHO");
    // …and the edit the operator actually made did land.
    expect(saved.find((b) => b.id === textBlock.id)?.text).toBe("TEXTO NOVO");
    expect((raw?.style as { font?: string })?.font).toBe("mono");
  });

  // A block whose TYPE this version cannot read at all is the other half of the same contract, and
  // it cannot be saved around: writing what parsed would drop it. Refusing keeps it — and says why,
  // because the raw schema error reads like the operator's own edit is at fault when all they
  // changed was a word.
  test("refuses to save a template holding a block type it cannot read", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Bloco do futuro",
        slug: "bloco_do_futuro",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const id = BigInt(tpl.id);
    const textBlock = tpl.blocks.find((b) => b.type === "text");
    if (!textBlock) throw new Error("starter has no text block");
    await suDb.documentTemplate.update({
      where: { id },
      data: {
        blocks: [
          ...tpl.blocks,
          { id: "assinatura", type: "signature", label: "Assine aqui" },
        ] as never,
      },
    });
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        id,
        { blockText: { [textBlock.id]: "x" } },
        appDb,
      ),
    ).rejects.toThrow(/newer version wrote/);
    const raw = await suDb.documentTemplate.findUnique({
      where: { id },
      select: { blocks: true },
    });
    const keptBlocks = raw?.blocks as { id: string }[] | undefined;
    expect(keptBlocks?.find((b) => b.id === "assinatura")).toBeDefined();

    // …and the PREVIEW says the same thing. It used to read the parsed DTO, where the unknown block
    // has already been dropped, so a style-only preview rendered a clean PDF and the MCP dry run
    // built on it reported the write as fine — a dry run approving a write that cannot be applied.
    await expect(
      previewDocumentTemplate(
        ctx(tenantA),
        { id, style: { font: "mono" } },
        appDb,
      ),
    ).rejects.toThrow(/newer version wrote/);
  });

  // The same zero, on the list filter: `?templateId=0` selects the documents of a template that
  // cannot exist, which is none of them. Read as "no filter given" it answers with every document
  // the tenant has ever issued.
  test("filters by a template id of zero rather than ignoring it", async () => {
    const all = await listIssuedDocuments(ctx(tenantA), {}, appDb);
    expect(all.length).toBeGreaterThan(0);
    expect(
      await listIssuedDocuments(ctx(tenantA), { templateId: 0n }, appDb),
    ).toEqual([]);
  });

  // The template can be deleted between the read that loads it and the insert that references it.
  // The foreign key then refuses the row, and a raw P2003 reaches the caller as a 500 — and an agent
  // turn as an integration-failure alert about somebody deleting their own template. It is the same
  // event the read itself would have reported a moment earlier, so it gets the same answer.
  test("answers a template deleted mid-issuance the way a missing one is answered", async () => {
    const starter = documentStarter("receipt", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Recibo em fuga",
        slug: "recibo_em_fuga",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const id = BigInt(tpl.id);
    let deleted = false;
    // Deletes between the template read and the insert — the window the foreign key is guarding.
    const racing = appDb.$extends({
      query: {
        issuedDocument: {
          async create({ args, query }) {
            if (!deleted) {
              deleted = true;
              await suDb.documentTemplate.delete({ where: { id } });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const failed = await issueDocument({
      tenantId: tenantA,
      templateId: id,
      idempotencyKey: `fk-race-${process.pid}`,
      values: {
        cliente: "Ana",
        valor: 100,
        referencia: "serviço",
        pago_em: "2026-09-05",
      },
      base: racing,
      storageDir: DIR,
    }).catch((e: unknown) => e);
    expect(deleted).toBe(true);
    expect(failed).toBeInstanceOf(AppError);
    expect((failed as AppError).statusCode).toBe(404);
    expect((failed as AppError).translationKey).toBe(
      "errors.documentTemplateNotFound",
    );
  });

  // A partial style patch must change ONLY what it names. Validated on its own, the parse fills
  // every omitted property with a default, and writing that result resets the operator's colour,
  // margin, locale, currency and page numbers — an edit to one setting silently rewriting the other
  // eight, reported as a success.
  test("a partial style patch leaves the settings it did not name alone", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Estilo próprio",
        slug: "estilo_proprio",
        blocks: starter.blocks,
        fields: starter.fields,
        style: {
          ...starter.style,
          accentColor: "#AA3311",
          margin: "wide",
          currency: "USD",
          locale: "en-US",
          showPageNumbers: true,
        },
      },
      appDb,
    );
    const id = BigInt(tpl.id);
    await updateDocumentTemplate(
      ctx(tenantA),
      id,
      { style: { font: "mono" } },
      appDb,
    );
    const after = await getDocumentTemplate(ctx(tenantA), id, appDb);
    expect(after.style.font).toBe("mono");
    expect(after.style.accentColor).toBe("#AA3311");
    expect(after.style.margin).toBe("wide");
    expect(after.style.currency).toBe("USD");
    expect(after.style.locale).toBe("en-US");
    expect(after.style.showPageNumbers).toBe(true);
  });

  // …and a style the CALLER wrote is still refused by name. The strict pass moved off the merged
  // value (which carries whatever a newer build stored) onto the patch itself, and it has to still
  // be there.
  test("still names a bad value in the style the caller sent", async () => {
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { style: { accentColor: "vermelho" } },
        appDb,
      ),
    ).rejects.toThrow(/accentColor/);
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { style: { fontt: "serif" } },
        appDb,
      ),
    ).rejects.toThrow(/fontt/);
  });

  // Truthiness on a filter is the widest possible answer to the narrowest possible question: a
  // caller asking for template 0 or for the empty thread key had its filter dropped and received
  // the tenant's whole recent list instead of nothing.
  test("an explicit filter that is falsy still filters", async () => {
    const all = await listIssuedDocuments(ctx(tenantA), {}, appDb);
    expect(all.length).toBeGreaterThan(0);
    expect(
      await listIssuedDocuments(ctx(tenantA), { templateId: 0n }, appDb),
    ).toEqual([]);
    expect(
      await listIssuedDocuments(ctx(tenantA), { threadId: "" }, appDb),
    ).toEqual([]);
  });

  // The FILE has one publisher, decided by the filesystem: `link` fails with EEXIST when the name is
  // taken, so a second render adopts what is there rather than replacing it. Without that, and
  // because the logo is read live, a letterhead swapped between two renders of one key made the
  // published document visibly change after it had been served.
  test("a render that publishes second adopts the first file, never replaces it", async () => {
    const key = `claim-loser-${process.pid}`;
    const seed = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    const id = BigInt(seed.id);
    const path = `${DIR}/${tenantA}/${id}.pdf`;
    // Back to PENDING so a second issuance renders again, with a marker in the published file that
    // only survives if the loser leaves it alone.
    await suDb.issuedDocument.update({
      where: { id },
      data: { status: "PENDING", pdfStorageKey: null },
    });
    await Bun.write(path, "WINNER");

    let claimed = false;
    // Another caller wins the claim while this render is between its write and its own CAS.
    const racing = appDb.$extends({
      query: {
        issuedDocument: {
          async updateMany({ args, query }) {
            if (!claimed) {
              claimed = true;
              await suDb.issuedDocument.update({
                where: { id },
                data: {
                  status: "READY",
                  pdfStorageKey: `${tenantA}/${id}.pdf`,
                },
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    // …and the caller returns the PUBLISHED bytes, not its own render: the logo is read live, so the
    // two can differ, and withBytes would have attached one PDF to a reply while the download link
    // served another. This holds whether the claim was won or lost — what is on disk is the
    // document.
    const loser = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      withBytes: true,
      base: racing,
      storageDir: DIR,
    });
    expect(new TextDecoder().decode(loser.bytes)).toBe("WINNER");
    expect(claimed).toBe(true);
    expect(await Bun.file(path).text()).toBe("WINNER");
    const litter = await readdir(`${DIR}/${tenantA}`);
    expect(litter.filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  // The other end of the same claim: the winner took it and then its rename FAILED, rolling the row
  // back to PENDING. Nobody published, so the loser must not report READY over bytes no download can
  // produce — the customer would be told a document exists that its own link cannot serve.
  test("refuses when the claim was lost and nothing was published", async () => {
    const key = `claim-rollback-${process.pid}`;
    const seed = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    const id = BigInt(seed.id);
    await suDb.issuedDocument.update({
      where: { id },
      data: { status: "PENDING", pdfStorageKey: null },
    });

    let claimed = false;
    let rolledBack = false;
    const racing = appDb.$extends({
      query: {
        issuedDocument: {
          // Before this render's CAS: someone else takes the claim, so ours fails.
          async updateMany({ args, query }) {
            if (!claimed) {
              claimed = true;
              await suDb.issuedDocument.update({
                where: { id },
                data: {
                  status: "READY",
                  pdfStorageKey: `${tenantA}/${id}.pdf`,
                },
              });
            }
            return query(args);
          },
          // Before this render re-reads: the winner's rename failed and it rolled its row back.
          async findUnique({ args, query }) {
            if (claimed && !rolledBack) {
              rolledBack = true;
              await suDb.issuedDocument.update({
                where: { id },
                data: { status: "PENDING", pdfStorageKey: null },
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(
      issueDocument({
        tenantId: tenantA,
        templateId,
        idempotencyKey: key,
        values: VALUES,
        withBytes: true,
        base: racing,
        storageDir: DIR,
      }),
    ).rejects.toThrow(/stored/);
    expect(rolledBack).toBe(true);
  });

  // The same rule when the claim is WON but the file was already there: this call adopts the
  // published file (link answered EEXIST) and must hand back those bytes, not the render it happens
  // to hold. Won and lost end in the same place — what is on disk is the document.
  test("adopting an existing file returns that file, even when the claim is won", async () => {
    const key = `adopt-${process.pid}`;
    const seed = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    const id = BigInt(seed.id);
    // The row goes back to PENDING (so this render proceeds and wins the claim) while the FILE
    // stays where it is — the state a crash between publishing and the claim leaves behind.
    await suDb.issuedDocument.update({
      where: { id },
      data: { status: "PENDING", pdfStorageKey: null },
    });
    await Bun.write(`${DIR}/${storageKey(tenantA, id)}`, "PUBLISHED-FIRST");

    const again = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      withBytes: true,
      base: appDb,
      storageDir: DIR,
    });
    expect(again.status).toBe("READY");
    expect(new TextDecoder().decode(again.bytes)).toBe("PUBLISHED-FIRST");
  });

  // …and what it must NOT adopt: a file left behind by the quotes subsystem this one replaces.
  //
  // An install upgraded from quotes keeps writing into the directory its QUOTES_STORAGE_DIR names
  // (Coolify freezes that value), and that directory already holds `<tenantId>/<quoteId>.pdf`.
  // `issued_documents` is a new table with a new sequence, so its ids start over and land on those
  // names. Adoption then reads as "another renderer got here first" and marks the row READY over a
  // stranger's quote — which is what the download serves and what the agent attaches to the
  // conversation. A path segment no numeric id can produce is what keeps the two sets apart.
  test("never adopts a legacy quote PDF that happens to share its id", async () => {
    const key = `legacy-${process.pid}`;
    const seed = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      base: appDb,
      storageDir: DIR,
    });
    const id = BigInt(seed.id);
    // The upgraded install's leftover: same tenant, same numeric id, another customer's document.
    const legacyPath = `${DIR}/${tenantA}/${id}.pdf`;
    await Bun.write(legacyPath, "SOMEONE-ELSES-QUOTE");
    // Back to PENDING with the file gone, so this issuance renders and publishes for real.
    await suDb.issuedDocument.update({
      where: { id },
      data: { status: "PENDING", pdfStorageKey: null },
    });
    await rm(`${DIR}/${storageKey(tenantA, id)}`, { force: true });

    const again = await issueDocument({
      tenantId: tenantA,
      templateId,
      idempotencyKey: key,
      values: VALUES,
      withBytes: true,
      base: appDb,
      storageDir: DIR,
    });
    expect(again.status).toBe("READY");
    expect(pdfHeader(Buffer.from(again.bytes as ArrayBuffer))).toBe("%PDF-");
    // The leftover is untouched, and it is not what this document points at.
    expect(await Bun.file(legacyPath).text()).toBe("SOMEONE-ELSES-QUOTE");
    const stored = await suDb.issuedDocument.findUnique({
      where: { id },
      select: { pdfStorageKey: true },
    });
    expect(stored?.pdfStorageKey).not.toBe(`${tenantA}/${id}.pdf`);
  });

  // A same-format replacement reuses the same path, so the bytes change before the row that records
  // the change does. If that row does not commit, the endpoint reports a failure while every
  // document already renders the NEW letterhead and every cached client still shows the old one —
  // the mismatch logoVersion exists to prevent.
  test("a failed logo write leaves the previous letterhead in place", async () => {
    // NOTE: setCompanyLogo reads config.documentsStorageDir directly — there is no dir to inject —
    // so this test writes into the configured one. Everything it asserts is therefore scoped to its
    // OWN tenant's key: the directory is shared with other runs, and a stale file from one of them
    // is not this test's subject. It cleans up after itself at the end.
    const dir = `${config.documentsStorageDir}/company`;
    const key = `${tenantB}-logo.png`;
    await Bun.write(`${dir}/${key}`, "OLD-LOGO");
    const png = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
      0x60, 0x82,
    ];
    // The settings write fails after the bytes are already on disk.
    const failing = appDb.$extends({
      query: {
        tenant: {
          async update() {
            throw new Error("settings write failed");
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(
      setCompanyLogo(
        ctx(tenantB),
        {
          type: "image/png",
          size: png.length,
          arrayBuffer: async () => new Uint8Array(png).buffer as ArrayBuffer,
        },
        failing,
      ),
    ).rejects.toThrow(/settings write failed/);
    expect(await Bun.file(`${dir}/${key}`).text()).toBe("OLD-LOGO");
    const litter = (await readdir(dir)).filter((f) => f.startsWith(`${key}.`));
    expect(litter.filter((f) => f.endsWith(".prev"))).toEqual([]);
    expect(litter.filter((f) => f.endsWith(".part"))).toEqual([]);

    // …and the SUCCESS path leaves nothing behind either: the set-aside copy is only insurance, and
    // insurance that is never collected is litter that grows with every upload.
    const saved = await setCompanyLogo(
      ctx(tenantB),
      {
        type: "image/png",
        size: png.length,
        arrayBuffer: async () => new Uint8Array(png).buffer as ArrayBuffer,
      },
      appDb,
    );
    expect(saved.logoKey).toBe(key);
    expect(
      (await readdir(dir)).filter(
        (f) =>
          f.startsWith(`${key}.`) &&
          (f.endsWith(".prev") || f.endsWith(".part")),
      ),
    ).toEqual([]);

    // A FIRST upload whose row does not commit must leave no file at all: there is no previous
    // letterhead to go back to, and keeping the new one would be an unreferenced logo on disk for a
    // row that never existed. (Round 24 folded two restore branches into one and dropped this half.)
    await rm(`${dir}/${key}`, { force: true });
    await expect(
      setCompanyLogo(
        ctx(tenantB),
        {
          type: "image/png",
          size: png.length,
          arrayBuffer: async () => new Uint8Array(png).buffer as ArrayBuffer,
        },
        failing,
      ),
    ).rejects.toThrow(/settings write failed/);
    expect(await Bun.file(`${dir}/${key}`).exists()).toBe(false);

    // Two overlapping uploads of the SAME format share one path, so they have to serialise: one
    // moving the file aside while the other sees the path free is how the committed version ends up
    // describing the other request's image. The swap runs inside the per-tenant settings lock.
    const upload = (marker: number) =>
      setCompanyLogo(
        ctx(tenantB),
        {
          type: "image/png",
          size: png.length,
          arrayBuffer: async () =>
            new Uint8Array([...png.slice(0, -1), marker]).buffer as ArrayBuffer,
        },
        appDb,
      );
    // Both are valid PNGs by structure; only the last byte differs, so whichever committed last is
    // identifiable from the file itself.
    await Promise.all([upload(0x82), upload(0x82)]);
    const settled = await runScopedOn(appDb, ctx(tenantB), (db) =>
      readCompanySettings(db, tenantB),
    );
    expect(settled.logoKey).toBe(key);
    expect(await Bun.file(`${dir}/${key}`).exists()).toBe(true);
    expect(
      (await readdir(dir)).filter(
        (f) =>
          f.startsWith(`${key}.`) &&
          (f.endsWith(".prev") || f.endsWith(".part")),
      ),
    ).toEqual([]);
    await rm(`${dir}/${key}`, { force: true });
  });

  // An operator asking for the logo to be gone means gone: clearing the key alone left the image on
  // disk and in every backup taken afterwards. And a PNG replaced by a JPEG writes a NEW path, so
  // the old extension's file is referenced by nothing and kept forever.
  test("removes the file a logo no longer references", async () => {
    const dir = `${config.documentsStorageDir}/company`;
    const pngKey = `${tenantB}-logo.png`;
    const jpgKey = `${tenantB}-logo.jpg`;
    const png = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
      0x60, 0x82,
    ];
    const jpg = [
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 10, 0, 10, 0,
      0, 0, 0xff, 0xd9,
    ];
    const upload = (type: string, body: number[]) =>
      setCompanyLogo(
        ctx(tenantB),
        {
          type,
          size: body.length,
          arrayBuffer: async () => new Uint8Array(body).buffer as ArrayBuffer,
        },
        appDb,
      );

    await upload("image/png", png);
    expect(await Bun.file(`${dir}/${pngKey}`).exists()).toBe(true);
    // Same format: ONE path, rewritten in place. Removing "the previous key" here would delete the
    // letterhead that was just installed.
    await upload("image/png", png);
    expect(await Bun.file(`${dir}/${pngKey}`).exists()).toBe(true);
    // Format change: the new path is written and the old one must not survive it.
    await upload("image/jpeg", jpg);
    expect(await Bun.file(`${dir}/${jpgKey}`).exists()).toBe(true);
    expect(await Bun.file(`${dir}/${pngKey}`).exists()).toBe(false);
    // A failure BEFORE anything is published — the lock, or the read that precedes the publish —
    // has nothing of this request's on disk to undo. The rollback used to remove "the new file"
    // unconditionally, which over a database hiccup deleted the live letterhead the row still names.
    const failsBeforePublish = appDb.$extends({
      query: {
        tenant: {
          findUnique() {
            throw new Error("settings read failed");
          },
        },
      },
    }) as unknown as typeof appDb;
    await expect(
      setCompanyLogo(
        ctx(tenantB),
        {
          type: "image/jpeg",
          size: jpg.length,
          arrayBuffer: async () => new Uint8Array(jpg).buffer as ArrayBuffer,
        },
        failsBeforePublish,
      ),
    ).rejects.toThrow();
    expect(await Bun.file(`${dir}/${jpgKey}`).exists()).toBe(true);

    // The ORDER: file after row, never before. A clear whose row write fails must leave the file
    // alone — the settings still name it, and a logo the settings name has to be on disk.
    const failing = appDb.$extends({
      query: {
        tenant: {
          update() {
            throw new Error("settings write failed");
          },
        },
      },
    }) as unknown as typeof appDb;
    await expect(clearCompanyLogo(ctx(tenantB), failing)).rejects.toThrow();
    expect(await Bun.file(`${dir}/${jpgKey}`).exists()).toBe(true);
    // …and clearing removes what is left.
    await clearCompanyLogo(ctx(tenantB), appDb);
    expect(await Bun.file(`${dir}/${jpgKey}`).exists()).toBe(false);
  });
});
