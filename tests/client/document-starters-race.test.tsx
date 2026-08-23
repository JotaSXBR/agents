/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  act,
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
// NOTE: the language is switched on the REAL i18n instance rather than by mocking react-i18next.
// `mock.module` is global to the process, and so is the `mock.restore()` that would undo it: an
// earlier version of this file mocked the module and restored it in afterAll, which tore down the
// module mocks another test file had installed and failed a test in it. Nothing here needs the
// module replaced — the panel reads `i18n.language`, and changing it for real is both simpler and
// what the operator actually does.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const { default: i18n } = await import("@/client/lib/i18n");
const { DocumentsPanel } = await import(
  "@/client/pages/resources/documents/DocumentsPanel"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
// Gates per locale, so the test decides which response lands last.
let gates: Record<string, { release: () => void; wait: Promise<void> }> = {};
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

const posts: string[] = [];
let holdPost = false;
let releasePost = () => {};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  if ((init?.method ?? "GET").toUpperCase() !== "GET") {
    posts.push(`${init?.method} ${url.pathname}`);
    if (holdPost) {
      await new Promise<void>((r) => {
        releasePost = r;
      });
    }
    return json({ template: { id: "9" } });
  }
  if (url.pathname.endsWith("/document-templates/starters")) {
    const locale = url.searchParams.get("locale") ?? "";
    await gate(locale).wait;
    return json({
      starters: [
        { key: "quote", name: `modelo-${locale}`, description: "", blocks: 3 },
        {
          key: "receipt",
          name: `recibo-${locale}`,
          description: "",
          blocks: 2,
        },
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

// Fresh gates per test. They are one-shot promises, so a test that releases one leaves the next
// test with a request that never blocks — which is how a race test quietly stops racing.
beforeEach(() => {
  gates = {};
  posts.length = 0;
  holdPost = false;
});
afterEach(cleanup);
const startingLanguage = i18n.language;
afterAll(async () => {
  globalThis.fetch = realFetch;
  // Put the shared instance back: it is module state, not test state.
  await i18n.changeLanguage(startingLanguage);
});

// Creating from a starter is one request at a time, and it stays visible until it answers. Two
// picks in quick succession are two templates; a dismissed dialog leaves a request whose result
// nobody sees, and the template it creates then appears in the list with no explanation.
describe("creating from a starter is one request", () => {
  async function openStarters() {
    const view = render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    gate("pt-BR").release();
    gate("en-US").release();
    const button = (await screen.findAllByText("New template"))[0];
    if (!button) throw new Error("no new-template button");
    fireEvent.click(button);
    await screen.findAllByText("Use");
    return view;
  }

  test("a second pick while one is in flight does nothing", async () => {
    // English, because these assertions read the button labels and the real catalog is loaded.
    await i18n.changeLanguage("en");
    posts.length = 0;
    holdPost = true;
    await openStarters();
    const buttons = await screen.findAllByText("Use");
    expect(buttons.length).toBeGreaterThan(1);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => {
      expect(posts.length).toBe(1);
    });
    // EVERY row, not just the one that was picked: a second starter chosen while the first request
    // is out is a second template, and its response also clears the first one's spinner.
    const rows = await screen.findAllByText("Use");
    const disabled = rows.map(
      (b) =>
        (b.closest("button") as HTMLButtonElement | null)?.disabled === true,
    );
    expect(disabled.every(Boolean)).toBe(true);
    for (const row of rows) fireEvent.click(row);
    await new Promise((r) => setTimeout(r, 30));
    expect(posts.length).toBe(1);
    releasePost();
  });

  test("the dialog cannot be dismissed while a request is out", async () => {
    await i18n.changeLanguage("en");
    posts.length = 0;
    holdPost = true;
    await openStarters();
    const buttons = await screen.findAllByText("Use");
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => {
      expect(posts.length).toBe(1);
    });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await new Promise((r) => setTimeout(r, 30));
    // Still there: the starter list is what the operator has to keep seeing until this answers.
    expect(screen.queryAllByText("Use").length).toBeGreaterThan(0);
    releasePost();
  });
});

describe("the starter list belongs to the current language", () => {
  test("an older response landing last does not replace the newer one", async () => {
    await i18n.changeLanguage("pt-BR");
    const view = render(
      <MemoryRouter initialEntries={["/recursos/documentos"]}>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    // The pt-BR load is in flight, held. The operator switches to English.
    await act(async () => {
      await i18n.changeLanguage("en");
    });
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
