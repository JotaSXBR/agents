/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// Switching language while the panel is loading starts a second load, and the two answer the SAME
// question differently: the starter list is the one thing here whose content is locale-specific. If
// the older request resolves last, its list replaces the current one — and the operator then creates
// a template in the language they just switched away from, permanently, with nothing on screen
// saying anything went wrong.
//
// NOTE: react-i18next is mocked so the language can change between renders; restored in afterAll,
// because `mock.module` is global to the process and leaks into whatever runs next in this worker.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

let language = "pt-BR";
mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language, changeLanguage: () => {} },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const { DocumentsPanel } = await import(
  "@/client/pages/resources/documents/DocumentsPanel"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
// Gates per locale, so the test decides which response lands last.
const gates: Record<string, { release: () => void; wait: Promise<void> }> = {};
function gate(locale: string) {
  if (!gates[locale]) {
    let release = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    gates[locale] = { release, wait };
  }
  return gates[locale] as { release: () => void; wait: Promise<void> };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  if (url.pathname.endsWith("/document-templates/starters")) {
    const locale = url.searchParams.get("locale") ?? "";
    await gate(locale).wait;
    return json({
      starters: [
        { key: "quote", name: `modelo-${locale}`, description: "", blocks: 3 },
      ],
    });
  }
  if (url.pathname.endsWith("/document-templates")) {
    return json({ templates: [] });
  }
  if (url.pathname.endsWith("/tenant-settings")) {
    return json({
      company: {
        name: "",
        document: "",
        address: "",
        phone: "",
        email: "",
        website: "",
        logoKey: null,
        logoVersion: 0,
      },
    });
  }
  return json({ documents: [] });
}) as unknown as typeof fetch;

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("the starter list belongs to the current language", () => {
  test("an older response landing last does not replace the newer one", async () => {
    language = "pt-BR";
    const view = render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    // The pt-BR load is in flight, held. The operator switches to English.
    language = "en";
    view.rerender(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );

    // The starter list lives in a modal, so it has to be opened to be read.
    const open = async () => {
      const button = (await screen.findAllByText("New template"))[0];
      if (!button) throw new Error("no new-template button");
      fireEvent.click(button);
    };

    // The NEWER answer lands first, the older one after it — the ordering that loses the race.
    gate("en-US").release();
    await open();
    await waitFor(
      () => {
        expect(document.body.textContent?.includes("modelo-en-US")).toBe(true);
      },
      { timeout: 3000 },
    );
    // …and now the stale one lands.
    gate("pt-BR").release();
    await new Promise((r) => setTimeout(r, 50));

    expect(document.body.textContent?.includes("modelo-en-US")).toBe(true);
    expect(document.body.textContent?.includes("modelo-pt-BR")).toBe(false);
  });
});
