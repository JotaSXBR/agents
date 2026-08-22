import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
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
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import { updateCompanySettings } from "@/modules/tenant-settings/service";

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
});
