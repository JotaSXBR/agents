import { describe, expect, test } from "bun:test";
import type { CompanyProfile } from "@/client/pages/resources/documents/CompanyProfileCard";
import {
  blankCompanyDraft,
  companyToDraft,
  emptyCompanyForm,
  nextCompanyDraft,
  seedCompanyDraft,
} from "@/client/pages/resources/documents/companyDraft";

// Decision table for the one rule this form owns: what happens to the operator's unsaved text when a
// `company` arrives from the server. The panel refetches for reasons that have nothing to do with
// this card (a template was deleted, a logo was uploaded), so "the prop changed" is not the question.

const stored = (over: Partial<CompanyProfile> = {}): CompanyProfile =>
  ({
    name: "ACME Ltda",
    document: "12.345.678/0001-90",
    address: "Rua das Flores, 100",
    phone: "+55 11 90000-0000",
    email: "contato@acme.example",
    website: "https://acme.example",
    logoKey: null,
    logoVersion: 0,
    ...over,
  }) as CompanyProfile;

describe("nextCompanyDraft", () => {
  // The first arrival, at a form nobody has opened. Nothing has been typed, so there is nothing to
  // protect — and this is the case a bare "does the draft differ?" check gets wrong, because an
  // untouched blank form differs from every stored value. Getting it wrong shows a configured
  // letterhead as blank after a reload, and Save then writes those blanks over it.
  test("seeds from the server when nothing has been typed yet", () => {
    const next = nextCompanyDraft(emptyCompanyForm(), stored());
    expect(next.draft).toEqual(companyToDraft(stored()));
    expect(next.draft.name).toBe("ACME Ltda");
  });

  // …and it is still a seed when the stored profile is EMPTY. "All blank" is a value an operator can
  // legitimately have typed, so it cannot double as "never filled in".
  test("an empty stored profile seeds too, rather than reading as typed-in", () => {
    const empty = stored({
      name: "",
      document: "",
      address: "",
      phone: "",
      email: "",
      website: "",
    });
    expect(nextCompanyDraft(emptyCompanyForm(), empty).draft).toEqual(
      blankCompanyDraft(),
    );
  });

  test("unsaved text survives a reload it had nothing to do with", () => {
    const seeded = seedCompanyDraft(stored());
    const typed = {
      ...seeded,
      draft: { ...seeded.draft, name: "ACME Ltda ME" },
    };
    expect(nextCompanyDraft(typed, stored())).toBe(typed);
    // Including text that CLEARS a field: emptying one is an edit like any other.
    const cleared = { ...seeded, draft: { ...seeded.draft, phone: "" } };
    expect(nextCompanyDraft(cleared, stored())).toBe(cleared);
  });

  // A form nobody is editing adopts whatever the server now says — which is how a change made
  // elsewhere (another tab, the REST API, MCP) reaches this card at all.
  test("an untouched form adopts the server's copy", () => {
    const untouched = seedCompanyDraft(stored());
    const moved = stored({ address: "Av. Paulista, 1000" });
    expect(nextCompanyDraft(untouched, moved).draft).toEqual(
      companyToDraft(moved),
    );
  });

  // The distinction the baseline exists for. Both of these hand the rule a draft that differs from
  // the INCOMING copy, and they must come out opposite: one is an edit, the other is someone else's
  // write landing on a form nobody touched. Comparing against the arriving copy answers "keep the
  // draft" to both, and the next Save then overwrites the other writer silently.
  test("tells an edit apart from a change made elsewhere", () => {
    const moved = stored({ address: "Av. Paulista, 1000" });
    const untouched = seedCompanyDraft(stored());
    const edited = {
      ...untouched,
      draft: { ...untouched.draft, address: "Rua das Flores, 200" },
    };
    expect(nextCompanyDraft(untouched, moved).draft.address).toBe(
      "Av. Paulista, 1000",
    );
    expect(nextCompanyDraft(edited, moved).draft.address).toBe(
      "Rua das Flores, 200",
    );
  });

  // Undoing the edit hands the form back: it is untouched again, so the newest server copy lands.
  test("a draft typed back to its baseline is untouched again", () => {
    const untouched = seedCompanyDraft(stored());
    const moved = stored({ address: "Av. Paulista, 1000" });
    const retyped = { ...untouched, draft: { ...untouched.draft } };
    expect(nextCompanyDraft(retyped, moved).draft).toEqual(
      companyToDraft(moved),
    );
  });

  // Typing before the server has answered: the baseline is blank, so the keystroke IS the edit and
  // the copy that arrives afterwards does not wipe it.
  test("text typed before the first load survives that load", () => {
    const early = emptyCompanyForm();
    const typed = { ...early, draft: { ...early.draft, name: "ACME" } };
    expect(nextCompanyDraft(typed, stored())).toBe(typed);
  });

  // A field the server never set is blank in the draft, not missing: a missing key would read as
  // different from "" and make the form permanently look typed-in.
  test("a field the server never set is blank, not absent", () => {
    const partial = stored({ website: undefined as unknown as string });
    const seeded = nextCompanyDraft(emptyCompanyForm(), partial);
    expect(seeded.draft.website).toBe("");
    expect(nextCompanyDraft(seeded, partial).draft).toEqual(seeded.draft);
  });
});
