import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type CompanySettings,
  readCompanySettings,
} from "@/modules/tenant-settings/service";
import {
  type DocumentBlock,
  type DocumentField,
  type DocumentStyle,
  parseDocumentStyle,
} from "./blocks";
import { type CompanyLogo, readCompanyLogo } from "./company";
import { formatDate, formatDocumentNumber } from "./format";
import { renderDocumentPdf } from "./render";
import { sampleValues } from "./sample";
import {
  type DocumentValues,
  parseAuthoredTemplate,
  parseDocumentValues,
  parseTemplateContent,
} from "./validate";

// Document templates: the tenant's own letterhead + layout for a class of document (quote, proposal,
// receipt). CRUD plus the preview render, which is the piece that makes authoring over the API
// usable — build the blocks from a script or an MCP client, then look at the PDF.
//
// Granting a template to an agent is a separate concern (AgentToolSelection, source=DOCUMENT), for
// the same reason a tool definition and its grant are separate: authoring is one decision and
// exposure to a model is another.

// The slug becomes the agent's tool name, so it lives in the same character set a tool name does.
export function slugifyTemplateName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "documento";
}

export function documentToolName(slug: string): string {
  return `send_${slug}`;
}

// A slug whose tool name would collide with a native tool is refused HERE, when it is written,
// because the collision only shows up later as an agent that has two tools with one name and no way
// for the operator to tell which one the model called.
function slugProblem(slug: string): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
    return "the slug must start with a letter and contain only lowercase letters, digits and underscores";
  }
  if (
    (NATIVE_TOOL_NAMES as readonly string[]).includes(documentToolName(slug))
  ) {
    return `the slug would produce the tool name "${documentToolName(slug)}", which is already a built-in tool`;
  }
  return null;
}

// A slug is unique per tenant in the database, and both writes can hit that index — the create with
// a name already in use, the update with a rename onto one. Answering the same constraint two
// different ways is how a rename ends up as a 500 for something the operator can fix by typing
// another name, so the mapping lives here and both callers use it.
function slugConflict(slug: string): (e: unknown) => never {
  return (e: unknown) => {
    if (e instanceof Error && (e as { code?: string }).code === "P2002") {
      throw new ConflictError(
        `a document template with the slug "${slug}" already exists`,
        "errors.documentTemplateSlugTaken",
      );
    }
    throw e;
  };
}

export interface DocumentTemplateDto {
  id: string;
  name: string;
  slug: string;
  toolName: string;
  description: string | null;
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
  numberPrefix: string | null;
  lastNumber: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  blocks: true,
  fields: true,
  style: true,
  numberPrefix: true,
  lastNumber: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Row = Prisma.DocumentTemplateGetPayload<{ select: typeof SELECT }>;

// Content is validated on the way IN, so a row is trusted on the way out — except that a row written
// by an older version of this file may not satisfy today's schema. Falling back to an empty document
// rather than throwing keeps the console listable: a template that cannot be parsed has to be
// visible to be fixed.
function toDto(row: Row): DocumentTemplateDto {
  const parsed = parseTemplateContent(row.blocks, row.fields, row.style);
  return {
    id: String(row.id),
    name: row.name,
    slug: row.slug,
    toolName: documentToolName(row.slug),
    description: row.description,
    blocks: parsed.ok ? parsed.content.blocks : [],
    fields: parsed.ok ? parsed.content.fields : [],
    style: parseDocumentStyle(row.style),
    numberPrefix: row.numberPrefix,
    lastNumber: row.lastNumber,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface DocumentTemplateInput {
  name: string;
  slug?: string;
  description?: string | null;
  blocks?: unknown;
  fields?: unknown;
  style?: unknown;
  numberPrefix?: string | null;
  enabled?: boolean;
}

export const templateNameSchema = z.string().trim().min(1).max(120);

// Both writes name a template, and a raw `.parse` here is not a validation response: nothing maps a
// ZodError, so it reaches the fallback handler as an INTERNAL_SERVER_ERROR and an operator who left
// the name empty is told the server broke. The create route in particular CANNOT require the name at
// the transport — the body schema is shared with the patch — so this is where the answer is decided.
function parseTemplateName(value: unknown): string {
  const parsed = templateNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "name: must be between 1 and 120 characters.",
      400,
      "errors.invalidDocumentTemplateName",
    );
  }
  return parsed.data;
}

// Every write goes through the AUTHORING gate, never the tolerant reader: what the operator wrote
// either takes effect or comes back named. The style comes back out of it too, so the value that was
// validated is the value that gets stored — validating one and saving another is the shape of bug
// this whole split exists to prevent.
function validated(input: {
  blocks: unknown;
  fields: unknown;
  style: unknown;
}): {
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
} {
  const parsed = parseAuthoredTemplate(input.blocks, input.fields, input.style);
  if (!parsed.ok) {
    throw new AppError(parsed.reason, 400, "errors.invalidDocumentTemplate");
  }
  return parsed.content;
}

export async function listDocumentTemplates(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<DocumentTemplateDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate.findMany({ orderBy: { name: "asc" }, select: SELECT }),
  );
  return rows.map(toDto);
}

export async function getDocumentTemplate(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<DocumentTemplateDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "document template not found",
      "errors.documentTemplateNotFound",
    );
  }
  return toDto(row);
}

export async function createDocumentTemplate(
  ctx: TenantContext,
  input: DocumentTemplateInput,
  base: PrismaClient = basePrisma,
): Promise<DocumentTemplateDto> {
  const name = parseTemplateName(input.name);
  const slug = input.slug ? input.slug : slugifyTemplateName(name);
  const problem = slugProblem(slug);
  if (problem) {
    throw new AppError(`slug: ${problem}.`, 400, "errors.invalidDocumentSlug");
  }
  const content = validated({
    blocks: input.blocks ?? [],
    fields: input.fields ?? [],
    style: input.style,
  });
  const style = content.style;
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const row = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate
      .create({
        data: {
          tenantId,
          name,
          slug,
          description: input.description ?? null,
          blocks: content.blocks as unknown as Prisma.InputJsonValue,
          fields: content.fields as unknown as Prisma.InputJsonValue,
          style: style as unknown as Prisma.InputJsonValue,
          numberPrefix: input.numberPrefix ?? null,
          enabled: input.enabled ?? true,
        },
        select: SELECT,
      })
      .catch(slugConflict(slug)),
  );
  return toDto(row);
}

export async function updateDocumentTemplate(
  ctx: TenantContext,
  id: bigint,
  patch: Partial<DocumentTemplateInput>,
  base: PrismaClient = basePrisma,
): Promise<DocumentTemplateDto> {
  const current = await getDocumentTemplate(ctx, id, base);
  const data: Prisma.DocumentTemplateUpdateInput = {};
  if (patch.name !== undefined) data.name = parseTemplateName(patch.name);
  if (patch.slug !== undefined) {
    const problem = slugProblem(patch.slug);
    if (problem) {
      throw new AppError(
        `slug: ${problem}.`,
        400,
        "errors.invalidDocumentSlug",
      );
    }
    data.slug = patch.slug;
  }
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.numberPrefix !== undefined) data.numberPrefix = patch.numberPrefix;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  // NOTE: blocks, fields and style are validated TOGETHER even when only one was sent, because the
  // rules are about the relationship between them — a block pointing at a field, a token in a block
  // or in the footer naming one. Validating only the patched part would accept a template whose
  // blocks reference fields the other half just removed, or a footer whose token the fields never
  // declared.
  if (
    patch.blocks !== undefined ||
    patch.fields !== undefined ||
    patch.style !== undefined
  ) {
    const content = validated({
      blocks: patch.blocks ?? current.blocks,
      fields: patch.fields ?? current.fields,
      style: patch.style ?? current.style,
    });
    data.blocks = content.blocks as unknown as Prisma.InputJsonValue;
    data.fields = content.fields as unknown as Prisma.InputJsonValue;
    if (patch.style !== undefined) {
      data.style = content.style as unknown as Prisma.InputJsonValue;
    }
  }
  const row = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate
      .update({ where: { id }, data, select: SELECT })
      .catch(slugConflict(patch.slug ?? current.slug)),
  );
  return toDto(row);
}

export async function deleteDocumentTemplate(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const res = await db.documentTemplate.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "document template not found",
        "errors.documentTemplateNotFound",
      );
    }
  });
}

export interface ResourceReferences {
  agents: { id: string; name: string }[];
}

// Reverse index: which agents were granted this template, so the console can warn before deleting
// one an agent is still offering.
export async function documentTemplateReferences(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ResourceReferences> {
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.agentToolSelection.findMany({
      where: { documentTemplateId: id },
      select: { agent: { select: { id: true, name: true } } },
    });
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.agent) seen.set(String(r.agent.id), r.agent.name);
    }
    return {
      agents: [...seen].map(([agentId, name]) => ({ id: agentId, name })),
    };
  });
}

// ── preview ──

export interface PreviewInput {
  // When given, the saved template supplies whatever the draft leaves out — which is what lets the
  // console preview a change to one block without resending the rest.
  id?: bigint;
  name?: string;
  blocks?: unknown;
  fields?: unknown;
  style?: unknown;
  numberPrefix?: string | null;
  values?: unknown;
  now?: Date;
}

export interface ResolvedRenderContext {
  company: CompanySettings;
  logo: CompanyLogo | null;
}

export async function readRenderContext(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<ResolvedRenderContext> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const company = await runScopedOn(base, ctx, (db) =>
    readCompanySettings(db, tenantId),
  );
  return { company, logo: await readCompanyLogo(company) };
}

// A preview is a RENDER, so caller-supplied values face the same gate the issued ones do. Passed
// through unchecked they are a shape the renderer was never promised: a missing required field
// prints a blank where the customer expects a name, a string where a number belongs throws inside
// react-pdf, and a line-item array past the ceiling lays out on the API process at whatever length
// the caller sent. Omitting them is the other path, and it stays free — sample values are ours.
function callerValues(
  fields: DocumentField[],
  raw: unknown,
  now: Date,
): DocumentValues {
  if (raw === undefined) return sampleValues(fields, now);
  const parsed = parseDocumentValues(fields, raw);
  if (!parsed.ok) {
    throw new AppError(parsed.reason, 400, "errors.invalidDocumentValues");
  }
  return parsed.values;
}

// Renders a draft the caller has not saved (or a saved one, with sample values). The bytes are never
// stored: a preview is a picture of a decision, not a document — nothing about it is issued,
// numbered or delivered.
export async function previewDocumentTemplate(
  ctx: TenantContext,
  input: PreviewInput,
  base: PrismaClient = basePrisma,
): Promise<Buffer> {
  const saved = input.id
    ? await getDocumentTemplate(ctx, input.id, base)
    : null;
  const content = validated({
    blocks: input.blocks ?? saved?.blocks ?? [],
    fields: input.fields ?? saved?.fields ?? [],
    style: input.style ?? saved?.style,
  });
  const style = content.style;
  const now = input.now ?? new Date();
  const values = callerValues(content.fields, input.values, now);
  const { company, logo } = await readRenderContext(ctx, base);
  const prefix =
    input.numberPrefix !== undefined ? input.numberPrefix : saved?.numberPrefix;
  return renderDocumentPdf({
    blocks: content.blocks,
    fields: content.fields,
    style,
    values,
    company,
    logo,
    meta: {
      // A believable number, not a real one: the preview must not consume the template's counter.
      number: formatDocumentNumber(42, prefix ?? null),
      date: formatDate(now.toISOString().slice(0, 10), style.locale),
      title: input.name ?? saved?.name ?? "",
    },
  });
}
