import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError, NotFoundError } from "@/lib/errors";
import { type QuoteRenderData, renderQuotePdf } from "@/lib/pdf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type QuoteDeliveryBlock,
  quoteDeliveryVerdict,
} from "@/modules/quotes/deliverable";

// Quote generation. Two-phase + idempotent (the hardened spec): a burst/retry/resume with the same
// idempotencyKey produces ONE quote and ONE PDF, never N links to the lead.
//   Phase A (tx): create the PENDING row race-safely (createMany skipDuplicates on the
//     [tenantId, idempotencyKey] unique) and re-read. An already-READY row is returned as-is.
//   Phase B (no tx): render the PDF (CPU-bound; outside the tx so the pool isn't pinned), write it
//     to a path DERIVED FROM THE ROW ID (deterministic → a retry overwrites, no orphan), then
//     CAS the row to READY. Serving is only ever via the authenticated, tenant-scoped route.

const quoteItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().finite().nonnegative(),
  unitPrice: z.number().finite().nonnegative(),
});

export const quoteSnapshotSchema = z.object({
  title: z.string().min(1).max(200),
  customerName: z.string().max(200).nullish(),
  currency: z.string().min(1).max(8),
  items: z.array(quoteItemSchema).min(1).max(100),
  notes: z.string().max(2_000).nullish(),
  issuedAt: z.string().max(40).optional(),
});
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;

export interface GenerateQuoteParams {
  tenantId: bigint;
  idempotencyKey: string;
  snapshot: QuoteSnapshot;
  conversationId?: bigint | null;
  threadId?: string | null;
  base?: PrismaClient;
  storageDir?: string;
}

export interface QuoteResult {
  id: string;
  status: string;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function storageKey(tenantId: bigint, quoteId: bigint): string {
  return `${tenantId}/${quoteId}.pdf`;
}

// The name the CUSTOMER sees on the attachment, and the same one the authenticated route already
// puts in its Content-Disposition: one artifact, one name, in whatever locale the tenant runs.
export function quoteFileName(quoteId: bigint | string): string {
  return `quote-${quoteId}.pdf`;
}

// A stored PDF, or null when the row points at a file that is not there. The filesystem has no RLS,
// so the KEY is the boundary: it is only ever resolvable through a tenant-scoped read of the row.
async function readQuoteBytes(
  dir: string,
  key: string,
): Promise<ArrayBuffer | null> {
  const file = Bun.file(`${dir}/${key}`);
  if (!(await file.exists())) return null;
  return await file.arrayBuffer();
}

// Chatwoot conversation ids are int4 on our mirror. A caller-supplied value outside that range is
// not a conversation anybody has; binding it would make Postgres raise on a lookup that meant to
// answer "no such row".
const MAX_CHATWOOT_CONVERSATION_ID = 2147483647n;

// The conversation a quote belongs to arrives as a CHATWOOT conversation id, which is unique per
// Chatwoot account and not per tenant: a tenant running more than one instance holds conversations
// numbered alike. Every other conversation lookup in the tree keys on (tenant, instance,
// conversation) for exactly that reason, and this table was the outlier that could afford not to,
// because nothing read the column. Delivering the PDF to the customer (issue #21) reads it, so the
// ambiguity became reachable, and the failure it produces is another customer's quote.
//
// The row therefore carries the resolved THREAD id, which is unique within the tenant, and the
// resolution is fail-closed: no mirrored conversation, or more than one, leaves it null and
// `send_quote` refuses rather than picking. `conversationId` is untouched and stays as the caller
// wrote it — it is what the console shows, and it is not what delivery matches on.
async function resolveThreadId(
  db: Pick<PrismaClient, "conversation">,
  conversationId: bigint | null | undefined,
): Promise<string | null> {
  if (
    conversationId === null ||
    conversationId === undefined ||
    conversationId <= 0n ||
    conversationId > MAX_CHATWOOT_CONVERSATION_ID
  ) {
    return null;
  }
  const rows = await db.conversation.findMany({
    where: { chatwootConversationId: Number(conversationId) },
    select: { threadId: true },
    take: 2,
  });
  return rows.length === 1 ? (rows[0]?.threadId ?? null) : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export async function generateQuote(
  params: GenerateQuoteParams,
): Promise<QuoteResult> {
  const base = params.base ?? basePrisma;
  const dir = params.storageDir ?? config.quotesStorageDir;
  const snapshot = quoteSnapshotSchema.parse(params.snapshot);
  const tenantId = params.tenantId;

  // Phase A: race-safe create-or-load of the PENDING row (+ the tenant name for the header,
  // read scoped so it is always the caller's own tenant).
  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    // Resolved BEFORE the create, so the row is born with the key delivery matches on. An explicit
    // caller-supplied thread wins: it is already the unambiguous form.
    const threadId =
      params.threadId ?? (await resolveThreadId(db, params.conversationId));
    await db.quote
      .createMany({
        data: [
          {
            tenantId,
            conversationId: params.conversationId ?? null,
            threadId,
            idempotencyKey: params.idempotencyKey,
            snapshot: snapshot as Prisma.InputJsonValue,
            status: "PENDING",
          },
        ],
        skipDuplicates: true,
      })
      .catch((err) => {
        if (!isUniqueViolation(err)) throw err; // concurrent insert → fall through to re-read
      });
    const quote = await db.quote.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId,
          idempotencyKey: params.idempotencyKey,
        },
      },
      select: { id: true, status: true, pdfStorageKey: true, snapshot: true },
    });
    const tenant = await db.tenant.findFirst({ select: { name: true } });
    return { quote, tenantName: tenant?.name ?? "" };
  });
  const row = loaded.quote;
  if (!row) throw new AppError("failed to persist quote", 500);
  if (row.status === "READY" && row.pdfStorageKey) {
    return { id: String(row.id), status: row.status };
  }

  // Phase B: render the stored snapshot (NOT the caller's argument — idempotent) and persist.
  const stored = quoteSnapshotSchema.parse(row.snapshot);
  const render: QuoteRenderData = {
    tenantName: loaded.tenantName,
    title: stored.title,
    customerName: stored.customerName ?? null,
    currency: stored.currency,
    items: stored.items,
    notes: stored.notes ?? null,
    issuedAt: stored.issuedAt,
  };
  const buffer = await renderQuotePdf(render);
  const key = storageKey(tenantId, row.id);
  // Bun.write creates parent directories. The path is derived from numeric ids only.
  await Bun.write(`${dir}/${key}`, buffer);

  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.quote.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "READY", pdfStorageKey: key },
    }),
  );
  return { id: String(row.id), status: "READY" };
}

export interface QuotePdf {
  bytes: ArrayBuffer;
}

// Authenticated, tenant-scoped read of a generated PDF. The scoped read is the boundary; the
// filesystem has no RLS, so the row (and thus the key) is only resolvable for the owning tenant.
export async function getQuotePdf(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
  storageDir?: string,
): Promise<QuotePdf> {
  const dir = storageDir ?? config.quotesStorageDir;
  const row = await runScopedOn(base, ctx, (db) =>
    db.quote.findUnique({
      where: { id },
      select: {
        status: true,
        pdfStorageKey: true,
        revoked: true,
        expiresAt: true,
      },
    }),
  );
  // Every block answers the same 404 here, deliberately: which of them it was is information about
  // a quote this caller may not read. `send_quote` asks the same predicate and DOES name the reason,
  // because there the answer is a sentence to a customer (modules/quotes/deliverable.ts).
  const verdict = row ? quoteDeliveryVerdict(row, new Date()) : null;
  if (!verdict?.ok) throw new NotFoundError("quote not found");
  const bytes = await readQuoteBytes(dir, verdict.pdfStorageKey);
  if (!bytes) throw new NotFoundError("quote not found");
  return { bytes };
}

// What `send_quote` gets back: the bytes to attach, or the reason there is nothing to attach.
export type QuoteForDelivery =
  | { ok: true; id: string; fileName: string; bytes: ArrayBuffer }
  | { ok: false; reason: "none" | "missing_file" | QuoteDeliveryBlock };

// The quote this conversation would send, for the tool that sends it (issue #21).
//
// It reads the thread's MOST RECENT quote and then asks whether that one can go out — never "the
// most recent one that can". A revised quote supersedes the one before it, and a fallback would
// attach the price the operator just replaced, silently, at the moment the customer is deciding on
// it. So a revoked or expired newest quote is a refusal with a reason, not a reason to look further
// back.
//
// Matched on `threadId` and never on `conversationId`: see resolveThreadId for why that column is
// not unique enough to hand a document to a customer by.
export async function loadQuoteForDelivery(
  ctx: TenantContext,
  threadId: string,
  base: PrismaClient = basePrisma,
  storageDir?: string,
): Promise<QuoteForDelivery> {
  const dir = storageDir ?? config.quotesStorageDir;
  const row = await runScopedOn(base, ctx, (db) =>
    db.quote.findFirst({
      where: { threadId },
      orderBy: { id: "desc" },
      select: {
        id: true,
        status: true,
        pdfStorageKey: true,
        revoked: true,
        expiresAt: true,
      },
    }),
  );
  if (!row) return { ok: false, reason: "none" };
  const verdict = quoteDeliveryVerdict(row, new Date());
  if (!verdict.ok) return { ok: false, reason: verdict.block };
  const bytes = await readQuoteBytes(dir, verdict.pdfStorageKey);
  if (!bytes) return { ok: false, reason: "missing_file" };
  return {
    ok: true,
    id: String(row.id),
    fileName: quoteFileName(row.id),
    bytes,
  };
}

export interface QuoteListItem {
  id: string;
  status: string;
  title: string | null;
  currency: string | null;
  conversationId: string | null;
  threadId: string | null;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

export async function listQuotes(
  ctx: TenantContext,
  opts: { limit?: number } = {},
  base: PrismaClient = basePrisma,
): Promise<QuoteListItem[]> {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.quote.findMany({
      orderBy: { id: "desc" },
      take,
      select: {
        id: true,
        status: true,
        snapshot: true,
        conversationId: true,
        threadId: true,
        expiresAt: true,
        revoked: true,
        createdAt: true,
      },
    }),
  );
  return rows.map((r) => {
    const s = (r.snapshot ?? {}) as { title?: string; currency?: string };
    return {
      id: String(r.id),
      status: r.status,
      title: s.title ?? null,
      currency: s.currency ?? null,
      conversationId: r.conversationId ? String(r.conversationId) : null,
      threadId: r.threadId,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      revoked: r.revoked,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export async function revokeQuote(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const res = await db.quote.updateMany({
      where: { id },
      data: { revoked: true },
    });
    if (res.count === 0) {
      throw new NotFoundError("quote not found", "errors.quoteNotFound");
    }
  });
}
