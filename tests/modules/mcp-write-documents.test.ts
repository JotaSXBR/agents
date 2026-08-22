import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { listDocumentTemplates } from "@/modules/documents/templates";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  documentTemplateCreate,
  documentTemplateDelete,
  documentTemplateUpdate,
} from "@/modules/mcp/write-documents";

// Authoring a rich document over MCP is the point of this surface, and the dry-run is what makes it
// usable without a visual editor: it RENDERS. A preview that only diffed field counts would report
// "blocks: 6 → 7" and say nothing about whether the seventh lays out.

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("MCP document-write gate (no DB)", () => {
  test("document_template_create without mcp:write → insufficient_scope", async () => {
    const r = await documentTemplateCreate(
      principal({ scopes: ["mcp:read"] }),
      { name: "x" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("an unknown starter is refused by name, and points at the list tool", async () => {
    const r = await documentTemplateCreate(principal({}), {
      starter: "invoice",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("document_starters_list");
  });

  test("document_template_update with an invalid id → error", async () => {
    const r = await documentTemplateUpdate(principal({}), {
      document_template_id: "nope",
      name: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid document_template_id");
  });

  test("document_template_update with no fields → error naming them", async () => {
    const r = await documentTemplateUpdate(principal({}), {
      document_template_id: "1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("blocks");
  });
});

// ── DB-gated ──

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
let tenantId = 0n;

const ctx = () => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN" as const,
});

describe.skipIf(!dbUp)("MCP document writes", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "McpDoc", slug: `mcpdoc-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM document_templates WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // dry-run is the DEFAULT: omitting the flag must create nothing.
  test("dry-run renders the document and creates nothing", async () => {
    const r = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        dryRun: boolean;
        preview: { renderedBytes: number };
      };
      expect(data.dryRun).toBe(true);
      // Rendered, not described: the number is the size of a real PDF.
      expect(data.preview.renderedBytes).toBeGreaterThan(500);
    }
    expect(await listDocumentTemplates(ctx(), appDb)).toHaveLength(0);
  });

  test("applies with dry_run:false, and records an audit entry", async () => {
    const r = await documentTemplateCreate(
      principal({ tenantId }),
      { starter: "quote", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { applied: boolean; toolName: string };
      expect(data.applied).toBe(true);
      expect(data.toolName).toBe("send_orcamento");
    }
    const templates = await listDocumentTemplates(ctx(), appDb);
    expect(templates).toHaveLength(1);
    const audit = await suDb.auditLog.findMany({
      where: { tenantId, action: "mcp.document_template_create" },
      select: { target: true },
    });
    expect(audit).toHaveLength(1);
  });

  // The refusal is the whole reason the shape is not published in the tool schema: it has to name
  // the block and the rule, so an authoring client can fix its own write.
  test("a block that will not render is refused by name, before it saves", async () => {
    const before = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateCreate(
      principal({ tenantId }),
      {
        name: "Quebrado",
        blocks: [{ id: "li", type: "lineItems", field: "nao_existe" }],
        fields: [],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("nao_existe");
      expect(r.error).toContain("li");
    }
    expect(await listDocumentTemplates(ctx(), appDb)).toHaveLength(
      before.length,
    );
  });

  test("update dry-run diffs the projection and changes nothing", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateUpdate(
      principal({ tenantId }),
      { document_template_id: tpl?.id as string, name: "Orçamento 2026" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        dryRun: boolean;
        diff: Record<string, { before: unknown; after: unknown }>;
      };
      expect(data.dryRun).toBe(true);
      expect(data.diff.name).toEqual({
        before: "Orçamento",
        after: "Orçamento 2026",
      });
    }
    const [after] = await listDocumentTemplates(ctx(), appDb);
    expect(after?.name).toBe("Orçamento");
  });

  // The dry-run's whole job is to show what applying WOULD change, and `fields` is the half a client
  // cares most about: it is the agent's argument list. A projection that carries the patch for some
  // properties and the stored value for others reports "nothing changes" for a write that changes
  // the tool contract — the worst possible answer, because it is confident.
  test("the update dry-run diffs patched fields and style, not just names", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateUpdate(
      principal({ tenantId }),
      {
        document_template_id: tpl?.id as string,
        // Appended, not replaced: the blocks still point at the starter's fields, and dropping
        // those would be refused by the content check — a different rule, correctly.
        fields: [
          ...(tpl?.fields ?? []),
          { name: "observacao", label: "Observação", type: "text" },
        ],
        style: { ...tpl?.style, font: "mono" },
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        diff: Record<string, { before: unknown; after: unknown }>;
      };
      expect(data.diff.fields).toBeDefined();
      expect(data.diff.fields?.after).toContain("observacao:text");
      expect(
        (data.diff.style?.after as { font?: string } | undefined)?.font,
      ).toBe("mono");
    }
    // …and still applies nothing.
    const [after] = await listDocumentTemplates(ctx(), appDb);
    expect(after?.fields.some((f) => f.name === "observacao")).toBe(false);
    expect(after?.style.font).not.toBe("mono");
  });

  test("delete dry-run says what survives the deletion", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const r = await documentTemplateDelete(
      principal({ tenantId }),
      { document_template_id: tpl?.id as string },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { preview: { note: string } };
      expect(data.preview.note).toContain("frozen copy");
    }
    expect(await listDocumentTemplates(ctx(), appDb)).toHaveLength(1);
  });

  // The tenant fence: a template belonging to tenant A is not addressable from tenant B's token,
  // and the answer is the same "not found" either way.
  test("another tenant's template is not addressable", async () => {
    const [tpl] = await listDocumentTemplates(ctx(), appDb);
    const other = await suDb.tenant.create({
      data: { name: "McpDocB", slug: `mcpdocb-${process.pid}` },
    });
    try {
      const r = await documentTemplateUpdate(
        principal({ tenantId: other.id }),
        { document_template_id: tpl?.id as string, name: "roubado" },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("not found");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${other.id}`,
      );
    }
  });
});
