import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  getIssuedDocumentPdf,
  issueDocument,
  listIssuedDocuments,
  revokeIssuedDocument,
} from "@/modules/documents/issue";

// Documents issued from a template. POST issues idempotently (the same idempotencyKey returns the
// same document, no re-render and no second number); GET streams the PDF, authenticated and
// tenant-scoped — the scoped read is the boundary, because the filesystem has no RLS. Served under
// /api, never staticPlugin.

// NOTE: these AppError translationKeys are localized centrally in `onError`, not through a literal
// translate() call, so they are declared here for the i18n extractor (keepRemoved: false). They
// belong to the documents MODULE, and they are declared in this controller because the api extractor
// only scans `src/api/**` — a declaration next to the throw site would be invisible to it, and the
// customer-facing effect of a missing key is silent: `onError` falls back to the English message.
// t/translate magic comments — keep defaults in sync with src/api/locales/*.json:
// translate('errors.documentTemplateNotFound', 'Document template not found')
// translate('errors.documentNotFound', 'Document not found')
// translate('errors.documentTemplateDisabled', 'This document template is disabled')
// translate('errors.documentTemplateSlugTaken', 'A document template with this identifier already exists')
// translate('errors.invalidDocumentTemplate', 'This document template is not valid')
// translate('errors.invalidDocumentValues', 'The values do not match what this template declares')
// translate('errors.invalidDocumentSlug', 'This identifier is not valid')
// translate('errors.invalidDocumentTemplateName', 'The document template name must be between 1 and 120 characters')
// translate('errors.documentRevoked', 'This document was revoked and cannot be issued again')
// translate('errors.documentNotNumbered', 'This document could not be numbered because its template no longer exists')
// translate('errors.invalidDocumentTemplateDescription', 'The document template description is too long')
// translate('errors.documentTemplateUnreadable', 'This template contains content a newer version wrote, so it cannot be saved from here')
// translate('errors.invalidDocumentNumberPrefix', 'The document number prefix is too long')
// translate('errors.documentNotStored', 'This document could not be stored')
// translate('errors.logoNotFound', 'Logo not found')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Ids are constrained HERE, at the transport, rather than left to the global handler that turns a
// BigInt parse error into a 400 by matching the word "BigInt" in an engine's message. That mapping
// was measured and it does work today — but it is a coupling to wording nobody here controls, and a
// malformed id is a validation failure the route can name on its own.
export const documentsController = new Elysia({
  prefix: "/v1/documents",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      documents: await listIssuedDocuments(ctxOrThrow(tenantContext), {
        limit: query.limit ? Number(query.limit) : undefined,
        templateId: query.templateId ? BigInt(query.templateId) : undefined,
        threadId: query.threadId,
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        // Constrained at the TRANSPORT, because the handler coerces both: `Number("abc")` is NaN and
        // reaches Prisma's `take`, and `BigInt("abc")` throws — a 500 for a malformed query string,
        // where the route advertises a validation response.
        limit: t.Optional(
          t.String({
            pattern: "^[1-9][0-9]*$",
            description: "Max rows to return (positive integer).",
          }),
        ),
        templateId: t.Optional(
          t.String({
            pattern: "^[0-9]+$",
            description: "Only documents from this template.",
          }),
        ),
        threadId: t.Optional(
          t.String({ description: "Only documents issued on this thread." }),
        ),
      }),
      detail: doc(
        "List issued documents",
        "Lists the documents the tenant has issued.",
      ),
      response: errors(401, 403),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      return {
        instance: instanceIdentity,
        document: await issueDocument({
          tenantId: ctx.tenantId as bigint,
          templateId: BigInt(body.templateId),
          idempotencyKey: body.idempotencyKey,
          values: body.values ?? {},
          threadId: body.threadId ?? null,
          conversationId: body.conversationId
            ? BigInt(body.conversationId)
            : null,
        }),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        templateId: t.String({
          pattern: "^[0-9]+$",
          description: "Template to issue from (BigInt string).",
        }),
        idempotencyKey: t.String({
          minLength: 1,
          maxLength: 200,
          description:
            "Same key returns the same document — no re-render, no second number.",
        }),
        // NOTE: a permissive Record for the same reason the template's blocks are one — Elysia's
        // `normalize` strips undeclared keys, and the keys here are the tenant's own field names,
        // which no static schema can enumerate.
        values: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              'Values keyed by the template\'s declared field names. A lineItems field takes [{"description","quantity","unitPrice"}].',
          }),
        ),
        threadId: t.Optional(
          t.String({
            description:
              "Conversation thread key (tenant:instance:conversation) this document belongs to.",
          }),
        ),
        conversationId: t.Optional(
          t.String({ description: "Conversation row id (BigInt string)." }),
        ),
      }),
      detail: doc(
        "Issue document",
        "Idempotently issues a document from a template and renders its PDF.",
      ),
      // 409 is a real answer here: an idempotency key can land on a row that was revoked, that could
      // not be numbered, or that nobody managed to store. A status the route returns and the
      // contract does not name is a status no generated client knows how to handle.
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .post(
    "/:id/revoke",
    async ({ tenantContext, params }) => {
      await revokeIssuedDocument(ctxOrThrow(tenantContext), BigInt(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          pattern: "^[0-9]+$",
          description: "Document id (BigInt string).",
        }),
      }),
      detail: doc(
        "Revoke document",
        "Revokes an issued document; its PDF stops being served.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/:id/pdf",
    async ({ tenantContext, params }) => {
      const ctx = tenantContext;
      if (!ctx) throw new ForbiddenError();
      const { bytes, fileName } = await getIssuedDocumentPdf(
        ctx,
        BigInt(params.id),
      );
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${fileName}"`,
          // The document is TENANT-scoped, and the scoped read of the row is the only thing that
          // fences it — the filesystem has none. A shared proxy caching by URL would replay these
          // bytes without that read ever running, handing one tenant's document to another
          // requester. `no-store` rather than the logo route's `private, max-age`: a priced document
          // is worth less caching than a letterhead is.
          "Cache-Control": "private, no-store",
        },
      });
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          pattern: "^[0-9]+$",
          description: "Document id (BigInt string).",
        }),
      }),
      detail: doc(
        "Download document PDF",
        "Streams the rendered PDF for inline viewing.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
