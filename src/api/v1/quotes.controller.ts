import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  generateQuote,
  getQuotePdf,
  listQuotes,
  type QuoteSnapshot,
  revokeQuote,
} from "@/modules/quotes/service";

// Quote generation + retrieval. POST generates idempotently (the same idempotencyKey returns the
// same quote, no re-render); GET streams the PDF, authenticated and tenant-scoped (the scoped read
// is the boundary — the filesystem has no RLS). Served under /api, never staticPlugin.

function tenantId(ctx: TenantContext | null): bigint {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx.tenantId;
}

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const quotesController = new Elysia({
  prefix: "/v1/quotes",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      quotes: await listQuotes(ctxOrThrow(tenantContext), {
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        limit: t.Optional(
          t.String({
            description: "Max rows to return (positive integer string).",
          }),
        ),
      }),
      detail: doc("List quotes", "Lists the tenant's generated quotes."),
      response: errors(401, 403),
    },
  )
  .post(
    "/:id/revoke",
    async ({ tenantContext, params }) => {
      await revokeQuote(ctxOrThrow(tenantContext), BigInt(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Quote id (BigInt string)." }),
      }),
      detail: doc("Revoke quote", "Revokes a generated quote by id."),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      quote: await generateQuote({
        tenantId: tenantId(tenantContext),
        idempotencyKey: body.idempotencyKey,
        snapshot: body.snapshot as QuoteSnapshot,
        conversationId: body.conversationId
          ? BigInt(body.conversationId)
          : null,
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        idempotencyKey: t.String({
          minLength: 1,
          maxLength: 200,
          description:
            "Idempotency key (same key returns the same quote, no re-render).",
        }),
        conversationId: t.Optional(
          t.String({
            description:
              "Chatwoot conversation id this quote belongs to. Required for the agent to be able to send it (send_quote matches the quote to the conversation it is called from); a quote generated without it can only be read through this API.",
          }),
        ),
        snapshot: t.Object(
          {
            title: t.String({
              minLength: 1,
              maxLength: 200,
              description: "Quote title.",
            }),
            customerName: t.Optional(
              t.Union([t.String(), t.Null()], {
                description: "Customer name (optional).",
              }),
            ),
            currency: t.String({
              minLength: 1,
              maxLength: 8,
              description: "Currency code (e.g. BRL, USD).",
            }),
            items: t.Array(
              t.Object({
                description: t.String({
                  minLength: 1,
                  maxLength: 500,
                  description: "Line item description.",
                }),
                quantity: t.Number({ description: "Line item quantity." }),
                unitPrice: t.Number({ description: "Line item unit price." }),
              }),
              { minItems: 1, maxItems: 100, description: "Quote line items." },
            ),
            notes: t.Optional(
              t.Union([t.String(), t.Null()], {
                description: "Free-form notes (optional).",
              }),
            ),
            issuedAt: t.Optional(
              t.String({
                description: "Issue date (ISO string); defaults to now.",
              }),
            ),
          },
          { description: "Immutable quote content snapshot." },
        ),
      }),
      detail: doc(
        "Generate quote",
        "Idempotently generates a quote and renders its PDF.",
      ),
      response: errors(400, 401, 403),
    },
  )
  .get(
    "/:id/pdf",
    async ({ tenantContext, params }) => {
      const ctx = tenantContext;
      if (!ctx) throw new ForbiddenError();
      const { bytes } = await getQuotePdf(ctx, BigInt(params.id));
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="quote-${params.id}.pdf"`,
        },
      });
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({ description: "Quote id (BigInt string)." }),
      }),
      detail: doc(
        "Download quote PDF",
        "Streams the rendered quote PDF for inline viewing.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
