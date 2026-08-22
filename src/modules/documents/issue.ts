import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import type { CompanySettings } from "@/modules/tenant-settings/service";
import {
  type DocumentBlock,
  type DocumentField,
  type DocumentStyle,
  parseDocumentStyle,
} from "./blocks";
import { documentVerdict } from "./deliverable";
import { formatDate, formatDocumentNumber } from "./format";
import { renderDocumentPdf } from "./render";
import { readRenderContext } from "./templates";
import {
  type DocumentValues,
  parseDocumentValues,
  parseTemplateContent,
} from "./validate";

// Issuing a document: one core, two callers (the REST route and the agent's own tool), as the API
// contract requires.
//
// Two-phase and idempotent, transplanted from the quote generator it replaces because that part of
// it was right: a burst, a retry or a resumed turn carrying the same idempotencyKey produces ONE
// document and ONE PDF, never N numbered documents in front of one customer.
//   Phase A (scoped): create the PENDING row race-safely on the [tenantId, idempotencyKey] unique
//     and re-read. An already-READY row comes back untouched.
//   Phase B (no tx): render the STORED snapshot — not the caller's argument — outside any
//     transaction (this is CPU-bound), write it to a path derived from the row id, then CAS to READY.

export interface DocumentSnapshot {
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
  company: CompanySettings;
  values: DocumentValues;
  issuedAt: string;
}

export interface IssueDocumentParams {
  tenantId: bigint;
  templateId: bigint;
  idempotencyKey: string;
  values: unknown;
  threadId?: string | null;
  chatwootInstanceId?: bigint | null;
  conversationId?: bigint | null;
  // Returns the PDF bytes alongside the row. The agent's tool needs them (it attaches the file it
  // just issued); the REST route does not, and asking for them there would buy a disk read per call.
  withBytes?: boolean;
  base?: PrismaClient;
  storageDir?: string;
  now?: Date;
}

export interface IssuedDocumentResult {
  id: string;
  number: string;
  title: string;
  status: string;
  fileName: string;
  bytes?: ArrayBuffer;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function storageKey(tenantId: bigint, documentId: bigint): string {
  return `${tenantId}/${documentId}.pdf`;
}

export function documentFileName(title: string, number: string | null): string {
  // ASCII-only, because the file name travels through a multipart upload to Chatwoot and then into
  // a Content-Disposition header on the way to the customer's phone. Derived from the template's own
  // title, never from a value the model wrote.
  const base = `${title} ${number ?? ""}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "documento"}.pdf`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export async function issueDocument(
  params: IssueDocumentParams,
): Promise<IssuedDocumentResult> {
  const base = params.base ?? basePrisma;
  const dir = params.storageDir ?? config.documentsStorageDir;
  const tenantId = params.tenantId;
  const ctx = sysCtx(tenantId);
  const now = params.now ?? new Date();

  // The idempotency check comes FIRST, before the template is even read. Validating the caller's
  // values against the CURRENT template up front would make a retry fail the moment the template
  // changed — which is exactly backwards: the whole point of the key is that the document already
  // exists and its content was frozen when it was issued. It is also the cheaper order, since the
  // common retry never touches the template at all.
  const existing = await runScopedOn(base, ctx, (db) =>
    loadByKey(db, tenantId, params.idempotencyKey),
  );
  if (existing) {
    return finish(existing, {
      base,
      ctx,
      dir,
      tenantId,
      withBytes: params.withBytes,
    });
  }

  const prepared = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate.findUnique({
      where: { id: params.templateId },
      select: {
        id: true,
        name: true,
        blocks: true,
        fields: true,
        style: true,
        numberPrefix: true,
        enabled: true,
      },
    }),
  );
  if (!prepared) {
    throw new NotFoundError(
      "document template not found",
      "errors.documentTemplateNotFound",
    );
  }
  if (!prepared.enabled) {
    throw new AppError(
      "this document template is disabled",
      400,
      "errors.documentTemplateDisabled",
    );
  }
  const content = parseTemplateContent(prepared.blocks, prepared.fields);
  if (!content.ok) {
    throw new AppError(content.reason, 400, "errors.invalidDocumentTemplate");
  }
  const parsedValues = parseDocumentValues(
    content.content.fields,
    params.values,
  );
  if (!parsedValues.ok) {
    throw new AppError(
      parsedValues.reason,
      400,
      "errors.invalidDocumentValues",
    );
  }
  const { company } = await readRenderContext(ctx, base);
  const snapshot: DocumentSnapshot = {
    blocks: content.content.blocks,
    fields: content.content.fields,
    style: parseDocumentStyle(prepared.style),
    company,
    values: parsedValues.values,
    issuedAt: now.toISOString(),
  };

  // `create` rather than `createMany({ skipDuplicates })` because the counter must be bumped exactly
  // once per row actually inserted, and skipDuplicates cannot say whether it inserted.
  //
  // Three scoped calls, not one: a P2002 ABORTS the PostgreSQL transaction it was raised in, so
  // recovering the winner cannot happen inside the transaction that lost. Catching the conflict and
  // re-reading in the same one turns a benign race — which the idempotency key exists to make benign
  // — into "current transaction is aborted" and a 500 for the caller that merely arrived second.
  const created = await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.create({
      data: {
        tenantId,
        templateId: prepared.id,
        title: prepared.name,
        // FROZEN with the row, not joined from the template when the number is printed: the prefix
        // is part of how this document identifies itself. Read live, renaming ORC- to PROP- would
        // rewrite every number already in a customer's hands, and deleting the template (which nulls
        // the FK by design — the documents outlive it) would drop the prefix altogether.
        numberPrefix: prepared.numberPrefix,
        threadId: params.threadId ?? null,
        chatwootInstanceId: params.chatwootInstanceId ?? null,
        conversationId: params.conversationId ?? null,
        idempotencyKey: params.idempotencyKey,
        status: "PENDING",
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    }),
  ).catch((err: unknown) => {
    if (isUniqueViolation(err)) return null; // lost the race → the winner is read below
    throw err;
  });
  if (created) {
    // Bumped AFTER the insert, so a losing race on the idempotency key does not consume a number.
    // A crash between the two leaves the row unnumbered, which the load below heals — monotonic,
    // with a gap only where a process actually died.
    await runScopedOn(base, ctx, (db) =>
      assignNumber(db, prepared.id, created.id),
    );
  }
  const row = await runScopedOn(base, ctx, (db) =>
    loadByKey(db, tenantId, params.idempotencyKey),
  );
  if (!row) throw new AppError("failed to persist the document", 500);
  return finish(row, { base, ctx, dir, tenantId, withBytes: params.withBytes });
}

interface LoadedDocument {
  id: bigint;
  number: number | null;
  title: string;
  status: string;
  snapshot: unknown;
  pdfStorageKey: string | null;
  templateId: bigint | null;
  numberPrefix: string | null;
}

async function loadByKey(
  db: ScopedDb,
  tenantId: bigint,
  idempotencyKey: string,
): Promise<LoadedDocument | null> {
  const doc = await db.issuedDocument.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      snapshot: true,
      pdfStorageKey: true,
      templateId: true,
      numberPrefix: true,
    },
  });
  if (!doc) return null;
  return {
    id: doc.id,
    number: doc.number,
    title: doc.title,
    status: doc.status,
    snapshot: doc.snapshot,
    pdfStorageKey: doc.pdfStorageKey,
    templateId: doc.templateId,
    numberPrefix: doc.numberPrefix,
  };
}

// Everything after the row exists: heal a missing number, render if it is still PENDING, and answer.
// Shared by both entry paths so a retry and a fresh issuance cannot drift apart.
async function finish(
  loaded: LoadedDocument,
  deps: {
    base: PrismaClient;
    ctx: TenantContext;
    dir: string;
    tenantId: bigint;
    withBytes?: boolean;
  },
): Promise<IssuedDocumentResult> {
  const { base, ctx, dir, tenantId } = deps;
  let row = loaded;
  if (row.number === null && row.templateId) {
    const templateId = row.templateId;
    const healed = await runScopedOn(base, ctx, (db) =>
      assignNumber(db, templateId, row.id),
    );
    if (healed !== null) row = { ...row, number: healed };
  }
  const numberLabel = formatDocumentNumber(row.number, row.numberPrefix);
  const fileName = documentFileName(row.title, numberLabel);

  if (row.status === "READY" && row.pdfStorageKey) {
    return {
      id: String(row.id),
      number: numberLabel,
      title: row.title,
      status: row.status,
      fileName,
      ...(deps.withBytes
        ? { bytes: await readStoredBytes(dir, row.pdfStorageKey) }
        : {}),
    };
  }

  // Render the STORED snapshot, which is what makes a retry produce the same document even if the
  // template was edited in between.
  const stored = row.snapshot as DocumentSnapshot;
  const style = parseDocumentStyle(stored.style);
  const { logo } = await readRenderContext(ctx, base);
  const buffer = await renderDocumentPdf({
    blocks: stored.blocks,
    fields: stored.fields,
    style,
    values: stored.values,
    company: stored.company,
    // NOTE: the logo is read live rather than frozen into the snapshot — bytes do not belong in a
    // JSON column. It only matters on a retry that re-renders, and a letterhead swapped in that
    // window is the operator's own change taking effect.
    logo,
    meta: {
      number: numberLabel,
      date: formatDate(stored.issuedAt.slice(0, 10), style.locale),
      title: row.title,
    },
  });
  const key = storageKey(tenantId, row.id);
  // Bun.write creates parent directories. The path is derived from numeric ids only.
  await Bun.write(`${dir}/${key}`, buffer);
  await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "READY", pdfStorageKey: key },
    }),
  );
  return {
    id: String(row.id),
    number: numberLabel,
    title: row.title,
    status: "READY",
    fileName,
    ...(deps.withBytes
      ? {
          bytes: buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
          ) as ArrayBuffer,
        }
      : {}),
  };
}

// UPDATE … RETURNING on the template row: the row lock makes the read-modify-write atomic, so two
// concurrent issuances of the same template never take the same number. Guarded on the document
// still being unnumbered so a second healer cannot overwrite the first's value.
async function assignNumber(
  db: {
    $queryRaw: PrismaClient["$queryRaw"];
    issuedDocument: PrismaClient["issuedDocument"];
  },
  templateId: bigint,
  documentId: bigint,
): Promise<number | null> {
  const rows = await db.$queryRaw<{ last_number: number }[]>`
    UPDATE "document_templates"
    SET "last_number" = "last_number" + 1
    WHERE "id" = ${templateId}
    RETURNING "last_number"
  `;
  const next = rows[0]?.last_number;
  if (next === undefined) return null;
  const res = await db.issuedDocument.updateMany({
    where: { id: documentId, number: null },
    data: { number: next },
  });
  return res.count === 1 ? next : null;
}

async function readStoredBytes(dir: string, key: string): Promise<ArrayBuffer> {
  const file = Bun.file(`${dir}/${key}`);
  if (!(await file.exists())) {
    throw new NotFoundError("document not found", "errors.documentNotFound");
  }
  return file.arrayBuffer();
}

// ── reading back ──

export interface DocumentPdf {
  bytes: ArrayBuffer;
  fileName: string;
}

// Authenticated, tenant-scoped read of an issued PDF. The scoped read is the boundary: the
// filesystem has no RLS, so the row — and with it the storage key — is only resolvable for the
// owning tenant.
export async function getIssuedDocumentPdf(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
  storageDir?: string,
): Promise<DocumentPdf> {
  const dir = storageDir ?? config.documentsStorageDir;
  const row = await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.findUnique({
      where: { id },
      select: {
        title: true,
        number: true,
        pdfStorageKey: true,
        revoked: true,
        numberPrefix: true,
      },
    }),
  );
  if (!row)
    throw new NotFoundError("document not found", "errors.documentNotFound");
  const verdict = documentVerdict(row);
  // NOTE: 404 for every refusal, revoked included. Which of the reasons applies is information about
  // a document the caller may not be entitled to know exists.
  if (!verdict.ok) {
    throw new NotFoundError("document not found", "errors.documentNotFound");
  }
  const file = Bun.file(`${dir}/${verdict.pdfStorageKey}`);
  if (!(await file.exists())) {
    throw new NotFoundError("document not found", "errors.documentNotFound");
  }
  return {
    bytes: await file.arrayBuffer(),
    fileName: documentFileName(
      row.title,
      formatDocumentNumber(row.number, row.numberPrefix),
    ),
  };
}

export interface IssuedDocumentListItem {
  id: string;
  title: string;
  number: string;
  templateId: string | null;
  status: string;
  threadId: string | null;
  conversationId: string | null;
  revoked: boolean;
  createdAt: string;
}

export async function listIssuedDocuments(
  ctx: TenantContext,
  opts: { limit?: number; templateId?: bigint; threadId?: string } = {},
  base: PrismaClient = basePrisma,
): Promise<IssuedDocumentListItem[]> {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.issuedDocument.findMany({
      where: {
        ...(opts.templateId ? { templateId: opts.templateId } : {}),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
      },
      orderBy: { id: "desc" },
      take,
      select: {
        id: true,
        title: true,
        number: true,
        templateId: true,
        status: true,
        threadId: true,
        conversationId: true,
        revoked: true,
        createdAt: true,
        numberPrefix: true,
      },
    }),
  );
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    number: formatDocumentNumber(r.number, r.numberPrefix),
    templateId: r.templateId ? String(r.templateId) : null,
    status: r.status,
    threadId: r.threadId,
    conversationId: r.conversationId ? String(r.conversationId) : null,
    revoked: r.revoked,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function revokeIssuedDocument(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const res = await db.issuedDocument.updateMany({
      where: { id },
      data: { revoked: true },
    });
    if (res.count === 0) {
      throw new NotFoundError("document not found", "errors.documentNotFound");
    }
  });
}
