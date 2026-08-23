import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  getIssuedDocumentPdf,
  issueDocument,
  listIssuedDocuments,
  revokeIssuedDocument,
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
        { name: "Imagem", slug: "image", blocks: [], fields: [] },
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
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        BigInt(tpl.id),
        { style: { ...starter.style, footerText: "{{nao_declarado}}" } },
        appDb,
      ),
    ).rejects.toThrow(/nao_declarado/);
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
        { name, blocks: [], fields: [] },
        appDb,
      ).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(AppError);
      expect((failed as AppError).statusCode).toBe(400);
      expect((failed as AppError).message).toContain("name");
    }
    // The same question on the update path, which raised the same raw error.
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      { name: "Nomeado", blocks: [], fields: [] },
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
      values: { cliente: "Ana", valor: 100, referencia: "serviço" },
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
        values: { cliente: "Ana", valor: 100, referencia: "serviço" },
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
          blocks: [],
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
          blocks: [],
          fields: [],
        },
        appDb,
      ),
    ).rejects.toThrow(/2000/);
    // …and on the patch, which is the half an operator reaches by pasting.
    await expect(
      updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { description: "x".repeat(2_001) },
        appDb,
      ),
    ).rejects.toThrow(/2000/);
  });
});
