import { type ZodError, z } from "zod";
import {
  type DocumentBlock,
  type DocumentField,
  documentBlockSchema,
  documentFieldSchema,
  MAX_BLOCKS_PER_DOCUMENT,
  MAX_LINE_ITEMS,
  parseDocumentStyle,
} from "./blocks";
import { isReservedTokenName, RESERVED_TOKEN_NAMES, tokensIn } from "./tokens";

// Everything that REFUSES a template or a set of values, as one pure decision with a decision table
// behind it. Written for whoever authored the thing, because the caller on the far end is either an
// operator in the console or a model composing a write over MCP — neither can read our source to
// find out what "invalid" meant.
//
// The rule the whole file exists for: a token that resolves to nothing must be caught HERE, at
// authoring time. Downstream it becomes a blank space in a document a customer keeps, and nothing
// anywhere reports it.

function issues(e: ZodError): string {
  return e.issues
    .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
    .join("; ");
}

export const documentBlocksSchema = z.array(documentBlockSchema);
export const documentFieldsSchema = z.array(documentFieldSchema);

export interface ParsedTemplateContent {
  blocks: DocumentBlock[];
  fields: DocumentField[];
}

export type TemplateParse =
  | { ok: true; content: ParsedTemplateContent }
  | { ok: false; reason: string };

const BLOCK_TYPES_HINT =
  'blocks are {"type":"header"|"text"|"fields"|"lineItems"|"totals"|"divider", "id":"…"}';

// Which declared field a block needs, and of which type. Kept as data so the check below reads as
// one loop rather than a branch per block type — a seventh block that points at a field is then one
// row here instead of a case somebody forgets.
interface FieldRef {
  prop: string;
  name: string;
  types: DocumentField["type"][];
}

function fieldRefs(block: DocumentBlock): FieldRef[] {
  switch (block.type) {
    case "lineItems":
      return [{ prop: "field", name: block.field, types: ["lineItems"] }];
    case "totals": {
      const refs: FieldRef[] = [
        { prop: "field", name: block.field, types: ["lineItems"] },
      ];
      if (block.discountField) {
        refs.push({
          prop: "discountField",
          name: block.discountField,
          types: ["currency", "number"],
        });
      }
      if (block.taxField) {
        refs.push({
          prop: "taxField",
          name: block.taxField,
          types: ["currency", "number"],
        });
      }
      return refs;
    }
    default:
      return [];
  }
}

// Every piece of a block that a token may appear in. A token in a header's `meta` value is as
// customer-visible as one in a paragraph, and listing the places once is what keeps a new
// text-carrying property from being the one nobody validates.
function textsIn(block: DocumentBlock): string[] {
  switch (block.type) {
    case "header":
      return [
        block.title ?? "",
        block.subtitle ?? "",
        ...(block.meta ?? []).flatMap((m) => [m.label, m.value]),
      ];
    case "text":
      return [block.text];
    case "fields":
      return block.rows.flatMap((r) => [r.label, r.value]);
    default:
      return [];
  }
}

// The style is taken as well as the blocks, and it is REQUIRED rather than optional, because the
// footer is rendered through the same token resolver the block texts are: a typo there resolves to a
// blank on the last line of every page of a document the customer keeps. Making it optional would
// mean the check is only as good as each caller remembering to opt in, and the invariant this file
// exists for — an unresolvable token is refused when it is WRITTEN, never at render — is not one a
// caller should be able to skip by leaving an argument out.
export function parseTemplateContent(
  rawBlocks: unknown,
  rawFields: unknown,
  rawStyle: unknown,
): TemplateParse {
  const blocksParsed = documentBlocksSchema.safeParse(rawBlocks ?? []);
  if (!blocksParsed.success) {
    return {
      ok: false,
      reason: `blocks: ${issues(blocksParsed.error)} — ${BLOCK_TYPES_HINT}.`,
    };
  }
  const fieldsParsed = documentFieldsSchema.safeParse(rawFields ?? []);
  if (!fieldsParsed.success) {
    return { ok: false, reason: `fields: ${issues(fieldsParsed.error)}` };
  }
  const blocks = blocksParsed.data;
  const fields = fieldsParsed.data;

  if (blocks.length > MAX_BLOCKS_PER_DOCUMENT) {
    return {
      ok: false,
      reason: `blocks: at most ${MAX_BLOCKS_PER_DOCUMENT} per document, got ${blocks.length}.`,
    };
  }

  const seenBlockIds = new Set<string>();
  for (const b of blocks) {
    if (seenBlockIds.has(b.id)) {
      return {
        ok: false,
        reason: `blocks: duplicate block id "${b.id}" — ids address a block across reorders, so two blocks cannot share one.`,
      };
    }
    seenBlockIds.add(b.id);
  }

  const byName = new Map<string, DocumentField>();
  for (const f of fields) {
    if (byName.has(f.name)) {
      return { ok: false, reason: `fields: duplicate field name "${f.name}".` };
    }
    if (isReservedTokenName(f.name)) {
      return {
        ok: false,
        reason: `fields: "${f.name}" starts with a reserved prefix (company_, empresa_, doc_, documento_) — those names already resolve to the company profile or the document itself, and a field would shadow them silently.`,
      };
    }
    byName.set(f.name, f);
  }

  for (const b of blocks) {
    for (const ref of fieldRefs(b)) {
      const target = byName.get(ref.name);
      if (!target) {
        return {
          ok: false,
          reason: `blocks: ${b.type} block "${b.id}" points ${ref.prop} at "${ref.name}", which is not a declared field.`,
        };
      }
      if (!ref.types.includes(target.type)) {
        return {
          ok: false,
          reason: `blocks: ${b.type} block "${b.id}" needs ${ref.prop} to name a field of type ${ref.types.join(" or ")}, but "${ref.name}" is ${target.type}.`,
        };
      }
    }
    for (const text of textsIn(b)) {
      const unknown = unknownToken(text, byName);
      if (unknown) {
        return {
          ok: false,
          reason: `blocks: block "${b.id}" uses {{${unknown}}}, which is neither a declared field nor a reserved name. Declare it in fields, or remove it — an unresolved token renders as a blank space in the customer's document.`,
        };
      }
    }
  }

  const footer = parseDocumentStyle(rawStyle).footerText;
  const unknownInFooter = footer ? unknownToken(footer, byName) : null;
  if (unknownInFooter) {
    return {
      ok: false,
      reason: `style: footerText uses {{${unknownInFooter}}}, which is neither a declared field nor a reserved name. Declare it in fields, or remove it — an unresolved token renders as a blank on the last line of every page.`,
    };
  }

  return { ok: true, content: { blocks, fields } };
}

// One question, asked of every text that reaches resolveTokens: block texts and the style's footer
// alike. Returns the first token that would render as a blank, or null.
function unknownToken(
  text: string,
  byName: Map<string, DocumentField>,
): string | null {
  for (const token of tokensIn(text)) {
    if (byName.has(token) || RESERVED_TOKEN_NAMES.includes(token)) continue;
    return token;
  }
  return null;
}

// ── values (what one issuance supplies) ──

export const lineItemValueSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().finite().nonnegative(),
  unitPrice: z.number().finite().nonnegative(),
});
export type LineItemValue = z.infer<typeof lineItemValueSchema>;

export type DocumentValue = string | number | LineItemValue[];
export type DocumentValues = Record<string, DocumentValue>;

export type ValuesParse =
  | { ok: true; values: DocumentValues }
  | { ok: false; reason: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// The shape is not the rule. "2026-02-31" matches the pattern, and neither the renderer nor
// Intl refuses it — JavaScript rolls it forward to March 3, so the customer keeps a PDF carrying a
// date nobody typed and no error is ever raised. Round-tripping through UTC is what separates a
// date that exists from a string that looks like one.
function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  // TWO clauses, not three. Over every string the regex above admits (110_000 of them, measured),
  // comparing the year and the day agrees with also comparing the month on every single input: a day
  // that overflows lands on another day, and a month outside 1..12 lands in another year. The third
  // clause decides nothing, and a rule carrying a clause that decides nothing is one nobody can
  // safely edit later.
  return at.getUTCFullYear() === year && at.getUTCDate() === day;
}

function valueProblem(field: DocumentField, value: unknown): string | null {
  switch (field.type) {
    case "text":
      return typeof value === "string" && value.length <= 2_000
        ? null
        : "must be a string of at most 2000 characters";
    case "number":
    case "currency":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "must be a finite number";
    case "date":
      // NOTE: ISO date only, never a pre-formatted string. The document is rendered in the
      // template's locale, and a date the model already wrote as "22/08" cannot be reformatted —
      // an en-US document would then carry one Brazilian date in the middle of it.
      return typeof value === "string" && isCalendarDate(value)
        ? null
        : "must be an ISO date (YYYY-MM-DD)";
    case "lineItems": {
      if (!Array.isArray(value)) return "must be a list of line items";
      if (value.length > MAX_LINE_ITEMS) {
        return `must have at most ${MAX_LINE_ITEMS} line items`;
      }
      const parsed = z.array(lineItemValueSchema).safeParse(value);
      return parsed.success
        ? null
        : `line items: ${issues(parsed.error)} — each is {"description":"…","quantity":n,"unitPrice":n}`;
    }
  }
}

export function parseDocumentValues(
  fields: DocumentField[],
  raw: unknown,
): ValuesParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      reason: "values must be an object keyed by field name.",
    };
  }
  const input = raw as Record<string, unknown>;
  const declared = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      return {
        ok: false,
        reason: `values: "${key}" is not a declared field of this template (declared: ${[...declared].join(", ") || "none"}).`,
      };
    }
  }
  const values: DocumentValues = {};
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined || value === null || value === "") {
      if (field.required) {
        return {
          ok: false,
          reason: `values: "${field.name}" (${field.label}) is required.`,
        };
      }
      continue;
    }
    const problem = valueProblem(field, value);
    if (problem) {
      return { ok: false, reason: `values: "${field.name}" ${problem}.` };
    }
    values[field.name] = value as DocumentValue;
  }
  return { ok: true, values };
}
