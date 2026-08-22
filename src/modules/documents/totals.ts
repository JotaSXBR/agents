import type { LineItemValue } from "./validate";

// Document arithmetic, in integer cents. Floats accumulate: 3 × 0,10 summed as floats is
// 0.30000000000000004, and a document that prints a total one cent off the sum of its own lines is
// the kind of error a customer photographs.
//
// The renderer computes this; the model never does. A model asked to add up its own line items will
// eventually get it wrong in front of a customer, and the number it got wrong is a price.

export interface DocumentTotals {
  subtotal: number;
  // The discount AS APPLIED, which is not always the discount that was supplied — see below.
  discount: number;
  tax: number;
  total: number;
}

function cents(value: number): number {
  return Math.round(value * 100);
}

// `tax` is an AMOUNT, not a rate, because the field that feeds it is declared `currency`. That
// settles the question a rate would open — whether it applies to the gross or to the discounted
// subtotal — by never asking it.
export function computeTotals(
  items: LineItemValue[],
  opts: { discount?: number; tax?: number } = {},
): DocumentTotals {
  const subtotalCents = items.reduce(
    (acc, item) => acc + cents(item.quantity * item.unitPrice),
    0,
  );
  const requestedDiscount = Math.max(0, cents(opts.discount ?? 0));
  // NOTE: clamped to the subtotal, and the CLAMPED value is what comes back, so the rows the
  // renderer prints add up to the total it prints. A discount larger than the subtotal is somebody's
  // mistake either way; a document whose own three numbers contradict each other is the worse way
  // for the customer to find out.
  const discountCents = Math.min(requestedDiscount, subtotalCents);
  const taxCents = Math.max(0, cents(opts.tax ?? 0));
  const totalCents = subtotalCents - discountCents + taxCents;
  return {
    subtotal: subtotalCents / 100,
    discount: discountCents / 100,
    tax: taxCents / 100,
    total: totalCents / 100,
  };
}

export function lineTotal(item: LineItemValue): number {
  return cents(item.quantity * item.unitPrice) / 100;
}
