import { describe, expect, test } from "bun:test";
import {
  type QuoteDeliverability,
  type QuoteDeliveryBlock,
  quoteDeliveryVerdict,
} from "@/modules/quotes/deliverable";

// Issue #21. The rule lived inside `getQuotePdf`, where every block answered the same 404 and the
// order among them could not be observed. `send_quote` observes it: the reason is what the model
// tells the customer. So the table below pins the reason and not just the yes/no.

const NOW = new Date("2026-08-22T12:00:00.000Z");

function quote(over: Partial<QuoteDeliverability> = {}): QuoteDeliverability {
  return {
    status: "READY",
    pdfStorageKey: "7/42.pdf",
    revoked: false,
    expiresAt: null,
    ...over,
  };
}

describe("quoteDeliveryVerdict", () => {
  const table: Array<{
    name: string;
    row: QuoteDeliverability;
    expected: QuoteDeliveryBlock | null;
  }> = [
    { name: "rendered, live, never revoked", row: quote(), expected: null },
    {
      name: "still rendering",
      row: quote({ status: "PENDING", pdfStorageKey: null }),
      expected: "not_rendered",
    },
    {
      name: "READY but with no file behind it",
      row: quote({ pdfStorageKey: null }),
      expected: "not_rendered",
    },
    {
      name: "revoked by the operator",
      row: quote({ revoked: true }),
      expected: "revoked",
    },
    {
      name: "expired before now",
      row: quote({ expiresAt: new Date(NOW.getTime() - 1) }),
      expected: "expired",
    },
    {
      name: "expiring exactly now is still live",
      row: quote({ expiresAt: NOW }),
      expected: null,
    },
    {
      name: "expiring later is live",
      row: quote({ expiresAt: new Date(NOW.getTime() + 60_000) }),
      expected: null,
    },
    // The precedence cases. Each row is blocked twice over, and the answer names the block the
    // customer-facing sentence should be about.
    {
      name: "revoked wins over never-rendered",
      row: quote({ revoked: true, status: "PENDING", pdfStorageKey: null }),
      expected: "revoked",
    },
    {
      name: "revoked wins over expired",
      row: quote({ revoked: true, expiresAt: new Date(NOW.getTime() - 1) }),
      expected: "revoked",
    },
    {
      name: "never-rendered wins over expired",
      row: quote({
        status: "PENDING",
        pdfStorageKey: null,
        expiresAt: new Date(NOW.getTime() - 1),
      }),
      expected: "not_rendered",
    },
  ];

  for (const c of table) {
    test(c.name, () => {
      const verdict = quoteDeliveryVerdict(c.row, NOW);
      expect(verdict.ok ? null : verdict.block).toBe(c.expected);
      // A deliverable verdict carries the key, so no caller has to ask for it again.
      if (verdict.ok)
        expect(verdict.pdfStorageKey).toBe(c.row.pdfStorageKey ?? "");
    });
  }
});
