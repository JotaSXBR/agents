import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { DEFAULT_TIMEZONE } from "@/graph/time";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
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
import { calendarDay } from "./issue";
import { unprintableProblem } from "./printable";
import { renderDocumentPdf } from "./render";
import { sampleValues } from "./sample";
import {
  type AuthoredHalves,
  authoredStyleProblem,
  type DocumentValues,
  invalidDocumentTemplate,
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
// The REST schema caps this at 40, but MCP and an imported bundle do not go through it, and the slug
// becomes a TOOL NAME: providers cap a function name (OpenAI at 64), and a name over the cap is
// rejected with the whole request — the agent stops replying, for one template nobody thought was
// dangerous. The bound belongs where every transport passes.
export const SLUG_MAX = 40;

export function slugProblem(slug: string): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
    return "the slug must start with a letter and contain only lowercase letters, digits and underscores";
  }
  if (slug.length > SLUG_MAX) {
    return `the slug must be at most ${SLUG_MAX} characters (it becomes the tool name send_${"<slug>"}, and providers cap a tool name)`;
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

// Everything a write is refused for that is NOT about the document's content: the name, the slug's
// shape, and the slug already being taken in this tenant. Separated because a DRY RUN has to reach
// the same answer as the apply — a preview that renders the document and then reports "valid" for a
// blank name or a slug that collides is worse than no preview, because the caller acts on it.
//
// The database's unique index stays the authority on a slug taken concurrently (slugConflict); this
// is the check that can run without writing anything.
export async function documentTemplateWriteProblem(
  ctx: TenantContext,
  input: {
    name?: unknown;
    slug?: string;
    description?: unknown;
    numberPrefix?: unknown;
  },
  base: PrismaClient = basePrisma,
  opts: { deriveSlugFromName: boolean; excludeId?: bigint } = {
    deriveSlugFromName: true,
  },
): Promise<string | null> {
  const { deriveSlugFromName, excludeId } = opts;
  const metadata = templateMetadataProblem(input);
  if (metadata) return metadata;
  const name =
    input.name !== undefined ? templateNameSchema.parse(input.name) : undefined;
  // Only CREATE derives a slug from the name; a rename keeps the slug it already has, because the
  // slug is a tool name an agent may already be granted. Deriving here on an update would refuse a
  // perfectly good rename over a slug the write was never going to use — and only on the dry run,
  // which is the worst place to disagree with the apply.
  const slug =
    input.slug ??
    (deriveSlugFromName && name !== undefined
      ? slugifyTemplateName(name)
      : undefined);
  if (slug === undefined) return null;
  const problem = slugProblem(slug);
  if (problem) return `slug: ${problem}.`;
  const taken = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    }),
  );
  return taken
    ? `a document template with the slug "${slug}" already exists`
    : null;
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
  // The console's own operation: the text of `text` blocks, by BLOCK ID, merged into the layout as
  // it stands at write time. The console edits the words and nothing else, and sending the whole
  // `blocks` array to do that makes it authoritative over a layout it did not author — an API or MCP
  // client that added or reordered a block while the modal was open would have that work silently
  // replaced by the snapshot the modal loaded. Block ids exist precisely so a console edit survives
  // a reorder from another transport (docs/documents.md).
  blockText?: Record<string, string>;
  fields?: unknown;
  style?: unknown;
  numberPrefix?: string | null;
  enabled?: boolean;
}

export const templateNameSchema = z.string().trim().min(1).max(120);
// Appended VERBATIM to the model-facing tool description, on every turn of every agent granted the
// template. Unbounded, one accidental paste makes every one of those turns carry it — the same
// ceiling HTTP tool descriptions are already held to, and for the same reason.
export const templateDescriptionSchema = z.string().max(2_000).nullable();
// Rendered into every document AND returned in the tool's own result, which the flow log stores and
// the model reads back on the next turn. Short by nature ("ORC-"), so the bound is generous and the
// point is only that there IS one: an accidental paste here breaks the page and the context alike.
export const templateNumberPrefixSchema = z.string().max(20).nullable();

// Both writes name a template, and a raw `.parse` here is not a validation response: nothing maps a
// ZodError, so it reaches the fallback handler as an INTERNAL_SERVER_ERROR and an operator who left
// the name empty is told the server broke. The create route in particular CANNOT require the name at
// the transport — the body schema is shared with the patch — so this is where the answer is decided.
// The metadata rules as ONE answer, so the four ways a template gets written cannot drift: the REST
// and MCP writes (which throw), the MCP dry runs (which must refuse exactly what the apply refuses),
// and an imported bundle (which warns and skips). Every one of them had to be told separately about
// the description bound, and one of them was not.
export function templateMetadataProblem(input: {
  name?: unknown;
  description?: unknown;
  numberPrefix?: unknown;
}): string | null {
  if (
    input.name !== undefined &&
    !templateNameSchema.safeParse(input.name).success
  ) {
    return "name: must be between 1 and 120 characters.";
  }
  // The name is DRAWN: it resolves {{doc_title}}, which every bundled starter prints in its header.
  if (typeof input.name === "string") {
    const problem = unprintableProblem(input.name, "name");
    if (problem) return problem;
  }
  if (
    input.description !== undefined &&
    !templateDescriptionSchema.safeParse(input.description ?? null).success
  ) {
    return "description: must be at most 2000 characters.";
  }
  if (
    input.numberPrefix !== undefined &&
    !templateNumberPrefixSchema.safeParse(input.numberPrefix ?? null).success
  ) {
    return "numberPrefix: must be at most 20 characters.";
  }
  // The prefix is DRAWN: it is the front of every document number on the page. A length check alone
  // let a character the fonts cannot encode through, and the renderer then prints a different one —
  // on every document that template ever issues.
  if (typeof input.numberPrefix === "string") {
    const problem = unprintableProblem(input.numberPrefix, "numberPrefix");
    if (problem) return problem;
  }
  return null;
}

function parseNumberPrefix(value: unknown): string | null {
  const problem = templateMetadataProblem({ numberPrefix: value });
  if (problem) {
    throw new AppError(problem, 400, "errors.invalidDocumentNumberPrefix");
  }
  return templateNumberPrefixSchema.parse(value ?? null);
}

function parseTemplateDescription(value: unknown): string | null {
  const problem = templateMetadataProblem({ description: value });
  if (problem) {
    throw new AppError(
      problem,
      400,
      "errors.invalidDocumentTemplateDescription",
    );
  }
  return templateDescriptionSchema.parse(value ?? null);
}

function parseTemplateName(value: unknown): string {
  const problem = templateMetadataProblem({ name: value });
  if (problem) {
    throw new AppError(problem, 400, "errors.invalidDocumentTemplateName");
  }
  return templateNameSchema.parse(value);
}

// Every write goes through the AUTHORING gate, never the tolerant reader: what the operator wrote
// either takes effect or comes back named. The style comes back out of it too, so the value that was
// validated is the value that gets stored — validating one and saving another is the shape of bug
// this whole split exists to prevent.
function validated(input: {
  blocks: unknown;
  fields: unknown;
  style: unknown;
  authored?: AuthoredHalves;
}): {
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
} {
  const parsed = parseAuthoredTemplate(
    input.blocks,
    input.fields,
    input.style,
    input.authored,
  );
  if (!parsed.ok) {
    throw invalidDocumentTemplate(parsed.reason);
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

// The stored row as it IS, not as this version reads it. The preview needs this: `toDto` drops a
// block a newer build wrote, and a preview built on that promises a save the apply will refuse.
async function rawTemplateRow(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient,
): Promise<Row> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.documentTemplate.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "document template not found",
      "errors.documentTemplateNotFound",
    );
  }
  return row;
}

export async function createDocumentTemplate(
  ctx: TenantContext,
  input: DocumentTemplateInput,
  base: PrismaClient = basePrisma,
): Promise<DocumentTemplateDto> {
  const name = parseTemplateName(input.name);
  // Derived only when the slug is genuinely ABSENT. An explicit "" is a malformed identifier the
  // caller wrote, and a truthiness fallback silently replaced it with one derived from the name —
  // while the dry run, which uses `?? `, refused exactly that input. A preview that says no to what
  // the apply says yes to is the same contract break as the reverse.
  const slug = input.slug ?? slugifyTemplateName(name);
  const problem = slugProblem(slug);
  if (problem) {
    throw new AppError(`slug: ${problem}.`, 400, "errors.invalidDocumentSlug");
  }
  if (input.blockText !== undefined) {
    // Accepted by the shared body schema because the PATCH needs it, and meaningless here: there is
    // no stored layout to merge into, and the caller is already sending the blocks. Refused rather
    // than ignored — a 200 that discarded what was asked for is the failure this whole field exists
    // to prevent.
    throw invalidDocumentTemplate(
      "blockText: only an update can replace text by block id; when creating, write the text inside blocks.",
    );
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
          description: parseTemplateDescription(input.description ?? null),
          blocks: content.blocks as unknown as Prisma.InputJsonValue,
          fields: content.fields as unknown as Prisma.InputJsonValue,
          style: style as unknown as Prisma.InputJsonValue,
          numberPrefix: parseNumberPrefix(input.numberPrefix ?? null),
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
  // Read, validate and write under ONE lock on the template row.
  //
  // A patch that touches any of blocks/fields/style is validated against the OTHER two as they stand
  // — that is the rule below — and then writes all of them back. Two clients patching different
  // parts therefore each merge into the snapshot they read, and the later write silently replaces
  // the earlier one: a text edit acknowledged with a 200 and then overwritten by a style edit
  // carrying the pre-edit blocks. The lock is what makes the second request read the first's result
  // instead of a snapshot from before it.
  //
  // NO LOCAL FAILURE MEASURED: a test issuing both patches under Promise.all could not reach the
  // interleaving on this stack — the two transactions serialised, and the test passed with the lock
  // removed, three runs out of three. It was deleted rather than kept as a proof of nothing. The
  // interleaving that this guards is between API REPLICAS, which is the deployed topology and which
  // no single-process test reaches; the same guard on the settings blob (patchBlock) IS covered,
  // because a test there does fail without it.
  return runScopedOn(base, ctx, async (db) => {
    await db.$queryRaw`SELECT 1 FROM "document_templates" WHERE "id" = ${id} FOR UPDATE`;
    const found = await db.documentTemplate.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!found) {
      throw new NotFoundError(
        "document template not found",
        "errors.documentTemplateNotFound",
      );
    }
    const current = toDto(found);
    const row = await patched(current, found, patch, db, id);
    return toDto(row);
  });
}

// Text by block id, onto the layout as it stands. An id that is not a `text` block is refused
// rather than ignored: silently dropping it is how a caller believes it edited something it did not.
function applyBlockText(
  blocks: unknown[],
  text: Record<string, string>,
): unknown[] {
  const byId = new Map(
    blocks.map((b) => [
      (b as { id?: unknown } | null)?.id,
      b as { id?: unknown; type?: unknown },
    ]),
  );
  for (const id of Object.keys(text)) {
    if (byId.get(id)?.type !== "text") {
      throw invalidDocumentTemplate(
        `blockText: "${id}" is not a text block of this template.`,
      );
    }
  }
  // Spread, so every property of the stored block survives — including ones this version does not
  // know about. Only `text` is replaced.
  return blocks.map((raw) => {
    const b = raw as { id?: unknown; type?: unknown };
    const id = typeof b.id === "string" ? b.id : "";
    return b.type === "text" && text[id] !== undefined
      ? { ...b, text: text[id] as string }
      : raw;
  });
}

// What this patch would make the template's content BE, validated exactly once.
//
// Shared by the apply and by the preview that promises what the apply will do, because they were
// answering the same question from different sources and disagreeing: the preview read the parsed
// DTO, where a block a NEWER build wrote has already been dropped, so a style-only dry run rendered
// happily and the apply then refused the very same patch as unreadable. A dry run that approves a
// write which cannot be performed is worse than no dry run.
//
// `stored` is null when there is nothing saved yet — a create, or a preview of one.
export function patchedContent(
  stored: {
    blocks?: unknown;
    fields?: unknown;
    style?: unknown;
  } | null,
  patch: {
    blocks?: unknown;
    fields?: unknown;
    style?: unknown;
    blockText?: Record<string, string>;
  },
): {
  content: {
    blocks: DocumentBlock[];
    fields: DocumentField[];
    style: DocumentStyle;
  };
  blocks: unknown[];
  fields: unknown[];
  rawStyle: Record<string, unknown>;
} {
  // The RAW stored columns are the base, not the parsed DTO. `toDto` reads tolerantly — it drops a
  // property this version does not know, and falls back to empty arrays when a row does not parse
  // at all — and writing that reading back would make an ordinary console save (which always sends
  // style and blockText) permanently delete layout a newer build wrote. Storage is tolerant on the
  // way OUT precisely so it survives; writing the parsed view back is how that guarantee is lost.
  const rawBlocks = (patch.blocks ?? stored?.blocks ?? []) as unknown[];
  const blocks = patch.blockText
    ? applyBlockText(rawBlocks, patch.blockText)
    : rawBlocks;
  // `blockText` is caller-written TEXT that does not make the blocks caller-authored (see below), so
  // the authored-halves check below never sees it — and the console's ordinary save is exactly a
  // blockText patch. Checked here, on the values as they arrived, which is the only place that knows
  // they came from a caller at all.
  for (const [id, text] of Object.entries(patch.blockText ?? {})) {
    const problem = unprintableProblem(text, `blockText."${id}"`);
    if (problem) throw invalidDocumentTemplate(problem);
  }
  const rawFields = (patch.fields ?? stored?.fields ?? []) as unknown[];
  // `blockText` does NOT make the blocks caller-authored: it writes strings into blocks that were
  // already there and can introduce no property of its own. Counting it here is what would make a
  // console save trip over a property a newer build wrote — the very save this is protecting.
  const authored = {
    blocks: patch.blocks !== undefined,
    fields: patch.fields !== undefined,
    // The caller's style is checked strictly on its OWN, just below, because the value VALIDATED
    // here is the patch merged over the stored style — which carries whatever a newer build put
    // there, and which the caller did not write.
    style: false,
  };
  if (patch.style !== undefined) {
    const problem = authoredStyleProblem(patch.style);
    if (problem) {
      throw invalidDocumentTemplate(problem);
    }
  }
  // MERGED BEFORE validation, not after. A partial patch like {font:"mono"} validated on its own
  // makes parseDocumentStyle fill every omitted property with a DEFAULT, and spreading that result
  // over the stored style then resets the operator's colour, margin, locale, currency and page
  // numbers — an edit to one setting silently rewriting the other eight. Merging first means the
  // parse sees the style the template actually has.
  const rawStyle = (stored?.style ?? {}) as Record<string, unknown>;
  const mergedStyle =
    patch.style !== undefined
      ? { ...rawStyle, ...(patch.style as Record<string, unknown>) }
      : rawStyle;
  let content: ReturnType<typeof validated>;
  try {
    // Strict only where the CALLER wrote. A half that came out of storage belongs to whoever
    // wrote it, and refusing this save because that half carries a property we do not know would
    // make every save of such a template impossible.
    content = validated({
      blocks,
      fields: rawFields,
      style: mergedStyle,
      authored,
    });
  } catch (e) {
    // A stored block this version cannot read at all (an unknown TYPE, not just an unknown
    // property) fails the shared parse, and there is no safe way to save around it: writing what
    // parsed would drop it. Refusing keeps it, and says why — the generic "invalid discriminator"
    // reads like the operator's own edit is at fault when they only changed a word.
    //
    // Conditioned on the STORED content actually being unreadable: without that test, any failure
    // on a wording-only or style-only patch — including one caused by what the caller just sent —
    // was reported as a newer version's doing, pointing them at the wrong remedy while the dry run
    // answered correctly.
    const storedUnreadable =
      stored !== null &&
      !parseTemplateContent(
        stored.blocks ?? [],
        stored.fields ?? [],
        stored.style,
      ).ok;
    if (
      e instanceof AppError &&
      storedUnreadable &&
      !authored.blocks &&
      !authored.fields
    ) {
      throw new AppError(
        `this template contains content a newer version wrote and this one cannot read, so saving from here would drop it (${e.message}) — edit it from the client that wrote it, or send blocks explicitly to replace them.`,
        409,
        "errors.documentTemplateUnreadable",
      );
    }
    throw e;
  }
  return { content, blocks, fields: rawFields, rawStyle };
}

// The body of the patch, run inside the caller's lock. Split out so the transaction above reads as
// what it is — read, decide, write, once — rather than as a wall of field handling.
async function patched(
  current: DocumentTemplateDto,
  stored: Row,
  patch: Partial<DocumentTemplateInput>,
  db: ScopedDb,
  id: bigint,
): Promise<Row> {
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
  if (patch.description !== undefined) {
    data.description = parseTemplateDescription(patch.description);
  }
  if (patch.numberPrefix !== undefined) {
    data.numberPrefix = parseNumberPrefix(patch.numberPrefix);
  }
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  // NOTE: blocks, fields and style are validated TOGETHER even when only one was sent, because the
  // rules are about the relationship between them — a block pointing at a field, a token in a block
  // or in the footer naming one. Validating only the patched part would accept a template whose
  // blocks reference fields the other half just removed, or a footer whose token the fields never
  // declared.
  if (
    patch.blocks !== undefined ||
    patch.blockText !== undefined ||
    patch.fields !== undefined ||
    patch.style !== undefined
  ) {
    const {
      content,
      blocks,
      fields: rawFields,
      rawStyle,
    } = patchedContent(stored, patch);
    // Written back RAW, so anything this version does not understand survives the save. Each column
    // is written only when the patch actually addressed it.
    if (patch.blocks !== undefined || patch.blockText !== undefined) {
      data.blocks = blocks as unknown as Prisma.InputJsonValue;
    }
    if (patch.fields !== undefined) {
      data.fields = rawFields as unknown as Prisma.InputJsonValue;
    }
    if (patch.style !== undefined) {
      // Written back over the raw stored style, taking ONLY the properties the patch addressed.
      //
      // Spreading the whole parsed style looks equivalent and is not: the parse fills every property
      // it could not read with a default, so a `font` a newer build wrote was replaced by "sans" on
      // any style save — an operator changing a colour silently downgrading a setting they cannot
      // even see. Storage is tolerant on the way out precisely so that value survives; writing the
      // parsed view back is how that guarantee is lost, and it is the same mistake `toDto` made for
      // whole blocks.
      const written = Object.keys(patch.style as Record<string, unknown>);
      data.style = {
        ...rawStyle,
        ...Object.fromEntries(
          written
            .filter((k) => k in content.style)
            .map((k) => [k, (content.style as Record<string, unknown>)[k]]),
        ),
      } as unknown as Prisma.InputJsonValue;
    }
  }
  return db.documentTemplate
    .update({ where: { id }, data, select: SELECT })
    .catch(slugConflict(patch.slug ?? current.slug));
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
  // Same shape the patch takes, so the console previews exactly what it will save: the words, by
  // block id, merged into the saved layout.
  blockText?: Record<string, string>;
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
  const logo = await readCompanyLogo(company);
  // A logo the settings NAME and the disk does not have is a cross-format replacement landing
  // between these two reads: the upload commits the new key and deletes the file the old one named,
  // which is exactly the file this read is reaching for. Answering null there freezes a document
  // without a letterhead forever, even though both the profile before and the profile after had
  // one — and the document is immutable, so nothing ever fixes it.
  //
  // Re-read once instead of holding the company lock across a render: the lock is taken by every
  // profile save, and an issuance is not something a save should have to wait behind. One retry is
  // enough because the replacement has already committed by the time the file is gone.
  if (!logo && company.logoKey) {
    const latest = await runScopedOn(base, ctx, (db) =>
      readCompanySettings(db, tenantId),
    );
    if (latest.logoKey && latest.logoKey !== company.logoKey) {
      return { company: latest, logo: await readCompanyLogo(latest) };
    }
  }
  return { company, logo };
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
  // The document's own calendar day, so a generated sample date matches the date printed on it.
  day: string,
): DocumentValues {
  if (raw === undefined) return sampleValues(fields, now, day);
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
  // The RAW row, not the DTO: a preview built on the tolerant reading renders a template whose
  // unreadable half has already been dropped, and then says "this would work" about a patch the
  // apply refuses. Same source, same answer.
  const saved =
    input.id !== undefined ? await rawTemplateRow(ctx, input.id, base) : null;
  // The same metadata gate a write passes. Without it a preview renders a prefix the create would
  // refuse — preview and apply disagreeing again — and feeds an unbounded string into a PDF built on
  // the request thread.
  const metadata = templateMetadataProblem({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.numberPrefix !== undefined
      ? { numberPrefix: input.numberPrefix }
      : {}),
  });
  if (metadata) {
    throw invalidDocumentTemplate(metadata);
  }
  // The same statement the apply runs, from the same source: strictness on the halves the caller
  // wrote, the style merged over the stored one, and the stored halves read as they are.
  const { content } = patchedContent(saved, {
    ...(input.blocks !== undefined ? { blocks: input.blocks } : {}),
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.blockText ? { blockText: input.blockText } : {}),
  });
  const style = content.style;
  const now = input.now ?? new Date();
  // Computed ONCE and used for both the document's date and any generated sample date, so the two
  // cannot land on different sides of a day boundary.
  const previewDay = calendarDay(now, DEFAULT_TIMEZONE);
  const values = callerValues(content.fields, input.values, now, previewDay);
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
      // The same day calculation an issuance freezes, so the preview and the document it previews
      // cannot disagree on a date the customer reads. A template has no agent of its own — it can be
      // granted to several — so this is the fleet default zone, which is also what the REST issue
      // path falls back to.
      //
      // NOT COVERED BY A TEST, deliberately and measured: a rendered PDF exposes neither greppable
      // text (react-pdf subsets its fonts, so the content stream carries glyph ids) nor a
      // deterministic byte stream (two renders of identical input differ), so nothing here can
      // observe the date that came out. The equivalent decision on the ISSUE path is covered, and
      // this line calls the same helper — that is the whole of the assurance, and it is written down
      // rather than implied.
      date: formatDate(previewDay, style.locale),
      title: input.name ?? saved?.name ?? "",
    },
  });
}
