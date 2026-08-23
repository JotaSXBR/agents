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

// The factors are QUANTIZED to the precision the document prints them at, before they are
// multiplied. A unit price of 0.105 renders as "R$ 0,11" and multiplied raw gives 3 × 0.105 = 0.315
// → 32 cents, so the customer reads "3 × R$ 0,11 = R$ 0,32" and cannot make those three numbers
// agree. Whatever the document shows has to be what it computed with; hidden digits are precisely
// the kind of discrepancy someone photographs.
//
// The precisions are the renderer's own: money at 2 decimals (formatMoney) and quantity at up to 4
// (formatNumber). They live here as the numbers those two formatters use, and a change on either
// side has to move both.
const QUANTITY_DECIMALS = 4;
const MONEY_DECIMALS = 2;

function quantize(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function displayedQuantity(value: number): number {
  return quantize(value, QUANTITY_DECIMALS);
}

export function displayedMoney(value: number): number {
  return quantize(value, MONEY_DECIMALS);
}

// `tax` is an AMOUNT, not a rate, because the field that feeds it is declared `currency`. That
// settles the question a rate would open — whether it applies to the gross or to the discounted
// subtotal — by never asking it.
export function computeTotals(
  items: LineItemValue[],
  opts: { discount?: number; tax?: number } = {},
): DocumentTotals {
  // Through lineTotal, so the subtotal is the sum of the lines the customer READS rather than of a
  // parallel calculation that happens to be near them.
  const subtotalCents = items.reduce(
    (acc, item) => acc + cents(lineTotal(item)),
    0,
  );
  // NOT quantized on the way in, and that is not an oversight: `cents()` IS the money quantization,
  // so a lone amount needs nothing more — measured, by removing a displayedMoney() here and finding
  // no test could tell. The factors below are different, because there a PRODUCT is taken before the
  // rounding, and the digits the document never showed survive into it.
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
  return (
    cents(displayedQuantity(item.quantity) * displayedMoney(item.unitPrice)) /
    100
  );
}
