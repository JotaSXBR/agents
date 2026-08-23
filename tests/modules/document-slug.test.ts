import { describe, expect, test } from "bun:test";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  availableSlug,
  documentToolName,
  SLUG_MAX,
  slugifyTemplateName,
  slugProblem,
} from "@/modules/documents/templates";

// The slug is a TOOL NAME, and the operator never types it: it is derived from the template's name.
// So every way the derivation can fail is a wall in front of a name that was perfectly reasonable,
// about an identifier the operator did not choose and cannot see. Three of those walls were
// reachable by typing an ordinary name:
//
//   "Orçamento" twice  → the second create was refused, one template per name, forever
//   "2026 Orçamento"   → "2026_orcamento", refused for not starting with a letter
//   "Image"            → "image", refused for colliding with the built-in send_image
//
// The rule below replaces all three: a DERIVED slug is the system's problem, so it keeps looking
// until it finds one that is both valid and free. An EXPLICIT slug is still refused, because there
// the caller asked for that tool name and silently giving them another one is worse.

describe("slugifyTemplateName", () => {
  test("derives a usable slug from names that used to produce an invalid one", () => {
    // The leading digit is the case that matters: a year in the name is ordinary, and the slug it
    // produced could never pass `slugProblem`.
    for (const name of ["2026 Orçamento", "9", "1º recibo"]) {
      const slug = slugifyTemplateName(name);
      expect(slugProblem(slug)).toBeNull();
    }
  });

  test("still derives the obvious slug when the name already gives one", () => {
    expect(slugifyTemplateName("Orçamento")).toBe("orcamento");
    expect(slugifyTemplateName("Proposta comercial")).toBe(
      "proposta_comercial",
    );
    expect(slugifyTemplateName("Ação!!")).toBe("acao");
  });

  test("never returns an empty slug", () => {
    for (const name of ["___", "!!!", " "]) {
      expect(slugifyTemplateName(name).length).toBeGreaterThan(0);
      expect(slugProblem(slugifyTemplateName(name))).toBeNull();
    }
  });
});

describe("availableSlug", () => {
  const cases: Array<{
    name: string;
    base: string;
    taken: string[];
    expected: string | null;
  }> = [
    {
      name: "hands back the base when nothing is in the way",
      base: "orcamento",
      taken: [],
      expected: "orcamento",
    },
    {
      name: "steps past a slug this tenant already uses",
      base: "orcamento",
      taken: ["orcamento"],
      expected: "orcamento_2",
    },
    {
      name: "keeps stepping while the suffixed ones are taken too",
      base: "orcamento",
      taken: ["orcamento", "orcamento_2", "orcamento_3"],
      expected: "orcamento_4",
    },
    {
      name: "ignores a gap rather than filling it, so the numbering never reuses a freed name",
      base: "orcamento",
      taken: ["orcamento", "orcamento_3"],
      expected: "orcamento_2",
    },
    {
      // The built-in is not in `taken` — it is not a row. It is refused by `slugProblem`, and the
      // search has to honour that or it hands back a slug the create will reject anyway.
      name: "steps past a slug whose tool name is a built-in",
      base: "image",
      taken: [],
      expected: "image_2",
    },
    {
      name: "truncates the base so the suffix fits inside the tool-name bound",
      base: "a".repeat(SLUG_MAX),
      taken: ["a".repeat(SLUG_MAX)],
      expected: `${"a".repeat(SLUG_MAX - 2)}_2`,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(availableSlug(c.base, new Set(c.taken))).toBe(c.expected);
    });
  }

  test("every slug it returns is one the create would accept", () => {
    const taken = new Set(["orcamento", "orcamento_2"]);
    for (const base of ["orcamento", "image", "a".repeat(SLUG_MAX), "recibo"]) {
      const slug = availableSlug(base, taken);
      expect(slug).not.toBeNull();
      expect(slugProblem(slug as string)).toBeNull();
      expect((slug as string).length).toBeLessThanOrEqual(SLUG_MAX);
    }
  });

  test("gives up rather than searching forever, and the caller answers a conflict", () => {
    const taken = new Set<string>(["orcamento"]);
    for (let n = 2; n <= 500; n++) taken.add(`orcamento_${n}`);
    expect(availableSlug("orcamento", taken)).toBeNull();
  });

  // The bound is on the SEARCH, not on the tenant: a base with hundreds of neighbours must not make
  // an unrelated one unavailable.
  test("a crowded base does not affect a different one", () => {
    const taken = new Set<string>(["orcamento"]);
    for (let n = 2; n <= 500; n++) taken.add(`orcamento_${n}`);
    expect(availableSlug("recibo", taken)).toBe("recibo");
  });

  test("no built-in tool is reachable through it", () => {
    const natives = new Set(NATIVE_TOOL_NAMES as readonly string[]);
    for (const base of ["image", "orcamento", "recibo"]) {
      const slug = availableSlug(base, new Set());
      expect(natives.has(documentToolName(slug as string))).toBe(false);
    }
  });
});
