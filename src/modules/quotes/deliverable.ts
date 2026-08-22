// Whether a generated quote may still be put in front of a customer, and when it may not, WHY.
//
// The four conditions were inlined in `getQuotePdf` and nowhere else, because nothing else read a
// quote. Delivering one to the customer (issue #21) asks the same question a second time and needs a
// DIFFERENT answer shape: the HTTP route collapses every block into 404 on purpose (the console
// learns nothing about a quote it may not read), while the model calling `send_quote` has to say
// something true to the customer, and "the operator revoked it" and "it was never rendered" are not
// the same sentence. One predicate, two renderings — the alternative is four conditions written
// twice, which is how the fifth one ends up in only one of them.
export type QuoteDeliveryBlock = "not_rendered" | "revoked" | "expired";

// The columns the decision reads, and only those: both call sites select exactly this.
export interface QuoteDeliverability {
  status: string;
  pdfStorageKey: string | null;
  revoked: boolean;
  expiresAt: Date | null;
}

// A verdict and not a boolean, so that "deliverable" CARRIES the storage key it just proved is
// there. Answering `null` and leaving the caller to re-check `pdfStorageKey` puts a branch below
// every call that no input can reach, and an unreachable branch is one nothing can test.
export type QuoteDeliveryVerdict =
  | { ok: true; pdfStorageKey: string }
  | { ok: false; block: QuoteDeliveryBlock };

// NOTE: `revoked` is asked FIRST, ahead of the render check the HTTP route used to ask first. A
// revoked row explains the other two away — the operator's own decision is the reason the quote is
// not going out, whatever else is true of it — and on the route the order is invisible, since all
// three answer 404 there.
export function quoteDeliveryVerdict(
  quote: QuoteDeliverability,
  now: Date,
): QuoteDeliveryVerdict {
  if (quote.revoked) return { ok: false, block: "revoked" };
  if (quote.status !== "READY" || !quote.pdfStorageKey) {
    return { ok: false, block: "not_rendered" };
  }
  if (quote.expiresAt && quote.expiresAt.getTime() < now.getTime()) {
    return { ok: false, block: "expired" };
  }
  return { ok: true, pdfStorageKey: quote.pdfStorageKey };
}
