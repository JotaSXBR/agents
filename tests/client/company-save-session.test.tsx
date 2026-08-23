/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The letterhead form used to live on the page, where a save that finished was simply a save. It is
// a modal now, and the parent CLOSES the modal on `onSaved` — which turns two ordinary bits of
// timing into lost work:
//
//   the operator keeps typing while the request is out. `afterCompanySave` deliberately keeps those
//   keystrokes and marks them unsaved; announcing the save anyway closes the editor and throws them
//   away, which is exactly what the preservation exists to prevent.
//
//   the operator closes the editor and reopens it while the request is out. The older response then
//   closes the modal they are typing into NOW.

const { CompanyProfileCard } = await import(
  "@/client/pages/resources/documents/CompanyProfileCard"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");

const realFetch = globalThis.fetch;
const COMPANY = {
  name: "ACME Ltda",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
};

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function mount(opts: { session?: number; onSaved: () => void }) {
  return render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard
            company={COMPANY as never}
            onChanged={() => undefined}
            onSaved={opts.onSaved}
            session={opts.session ?? 1}
          />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
}

function nameField(): HTMLInputElement {
  return screen.getAllByRole("textbox")[0] as HTMLInputElement;
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));
}

// Holds the PUT open until released, so the window between click and response is a real one.
function heldFetch() {
  let release: ((body: unknown) => void) | undefined;
  const held = new Promise<unknown>((r) => {
    release = r;
  });
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "PUT") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    calls++;
    await held;
    return new Response(JSON.stringify({ company: COMPANY }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { release: () => release?.(null), calls: () => calls };
}

test("a save does not announce itself over edits made while it was in flight", async () => {
  const held = heldFetch();
  let saved = 0;
  mount({ onSaved: () => saved++ });

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  save();
  await waitFor(() => {
    expect(held.calls()).toBe(1);
  });

  // The operator keeps typing into the still-open form.
  fireEvent.change(nameField(), { target: { value: "ACME Novíssima" } });
  held.release();
  await new Promise((r) => setTimeout(r, 50));

  // Not announced, so the modal stays open — and the newer text is still on screen, unsaved.
  expect(saved).toBe(0);
  expect(nameField().value).toBe("ACME Novíssima");
});

test("a save with nothing typed after it does announce itself", async () => {
  const held = heldFetch();
  let saved = 0;
  mount({ onSaved: () => saved++ });

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  save();
  await waitFor(() => {
    expect(held.calls()).toBe(1);
  });
  held.release();

  // The other direction, and it has to be asserted: a guard that never lets the modal close is the
  // same bug wearing the opposite sign.
  await waitFor(() => {
    expect(saved).toBe(1);
  });
});

test("a save that lands after the editor was reopened does not close it", async () => {
  const held = heldFetch();
  let saved = 0;
  const view = mount({ session: 1, onSaved: () => saved++ });

  fireEvent.change(nameField(), { target: { value: "ACME Nova" } });
  save();
  await waitFor(() => {
    expect(held.calls()).toBe(1);
  });

  // Closed and reopened: same card, new opening. The panel counts those, and this save belongs to
  // the previous one.
  view.rerender(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard
            company={COMPANY as never}
            onChanged={() => undefined}
            onSaved={() => saved++}
            session={2}
          />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
  held.release();
  await new Promise((r) => setTimeout(r, 50));

  expect(saved).toBe(0);
});
