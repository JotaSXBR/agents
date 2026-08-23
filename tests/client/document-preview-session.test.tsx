/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useDocumentPreview } from "@/client/pages/resources/documents/useDocumentPreview";

// The preview is keyed on the EDITING SESSION, not on the template.
//
// The request is debounced by 600 ms, so whatever the previous session produced stays on screen
// until the next response lands. Keyed on the template id that reads as correct and does nothing in
// the case that matters: an operator edits a template, cancels, and reopens the SAME one — the id
// has not changed, so the discarded draft's PDF is what they read while typing the new one.
//
// The call site is now protected by the compiler (`session` is a required number, and a template id
// is a string), so what is left to prove here is the rule itself: a new session drops the previous
// document AT ONCE, without waiting for the request that replaces it.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

let minted = 0;
URL.createObjectURL = () => `blob:preview-${++minted}`;
URL.revokeObjectURL = () => {};
globalThis.fetch = (async () =>
  new Response(new Blob(["%PDF-1.7"]), {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  })) as unknown as typeof fetch;

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

let reopen: () => void = () => {};
let seen: string | null = null;

function Harness() {
  const [session, setSession] = useState(1);
  reopen = () => setSession((s) => s + 1);
  const preview = useDocumentPreview({ name: "Orçamento" }, session);
  seen = preview.url;
  return <span data-testid="url">{preview.url ?? "none"}</span>;
}

describe("useDocumentPreview", () => {
  test("a new session drops the previous document before the next one arrives", async () => {
    const view = render(<Harness />);
    await waitFor(
      () => {
        expect(view.getByTestId("url").textContent).toBe("blob:preview-1");
      },
      { timeout: 3000 },
    );

    // Reopening the modal on the same template: same draft, new session. The document has to be
    // gone on the very next paint, not 600 ms later when the replacement request resolves.
    act(() => {
      reopen();
    });
    expect(seen).toBeNull();
    expect(view.getByTestId("url").textContent).toBe("none");

    // …and the replacement does arrive, so the reset is a reset and not a teardown.
    await waitFor(
      () => {
        expect(view.getByTestId("url").textContent).toBe("blob:preview-2");
      },
      { timeout: 3000 },
    );
  });
});
