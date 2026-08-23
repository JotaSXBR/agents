import { describe, expect, test } from "bun:test";
import { MAX_DB_ID, parseDbId, requireDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";
import { parseMcpId } from "@/modules/mcp/write";

// `BigInt` is arbitrary precision and a database id is not. A value past 2^63-1 passes a digits-only
// check, converts happily, and is then refused by POSTGRES when the query binds it — so a plainly
// malformed field answers 500 on a path whose whole job was to say 400 or 404.
//
// A SWEEP rather than one example per route, because the defect is in the spelling people reach for
// (`BigInt(params.id)`) and the next route added will reach for it too. The per-route behaviour is
// pinned below it, so the sweep cannot pass by measuring nothing.

describe("requireDbId", () => {
  test("takes the largest id a column can hold, and refuses the next one", () => {
    expect(requireDbId(MAX_DB_ID.toString())).toBe(MAX_DB_ID);
    expect(() => requireDbId((MAX_DB_ID + 1n).toString())).toThrow(AppError);
  });

  test("refuses the spellings BigInt would accept", () => {
    for (const raw of ["", " 7 ", "+7", "0x7", "1e3", "abc"]) {
      expect(() => requireDbId(raw)).toThrow(AppError);
    }
  });

  test("answers 400, not 500", () => {
    try {
      requireDbId("9223372036854775808");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AppError).statusCode).toBe(400);
    }
  });
});

// The MCP tools take ids as strings too, and they reach the same columns.
describe("parseMcpId", () => {
  test("refuses an id no column can hold", () => {
    expect(parseMcpId(MAX_DB_ID.toString(), "template id")).toBe(MAX_DB_ID);
    const past = parseMcpId((MAX_DB_ID + 1n).toString(), "template id");
    expect(typeof past === "bigint").toBe(false);
  });
});

// Every caller-supplied id in the document surfaces goes through the bounded parse. Written as a
// read of the source because that is where the mistake is visible: a `BigInt(...)` wrapped around a
// request field is the defect, whatever the route around it does.
describe("no document route converts a caller's id with bare BigInt", () => {
  const FILES = [
    "src/api/v1/documents.controller.ts",
    "src/api/v1/document-templates.controller.ts",
  ];

  test("params, body and query ids use the bounded parse", async () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = await Bun.file(file).text();
      for (const m of src.matchAll(
        /BigInt\(\s*(?:params|body|query)\.[A-Za-z0-9_.]+/g,
      )) {
        offenders.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // …and the sweep is looking at something: the pattern it hunts is one it can find.
  test("the sweep would catch the spelling it exists for", () => {
    const sample = "const id = BigInt(params.id);";
    expect(
      [...sample.matchAll(/BigInt\(\s*(?:params|body|query)\.[A-Za-z0-9_.]+/g)]
        .length,
    ).toBe(1);
  });
});

// The parse the routes now share is the one the rest of the repo already had.
test("requireDbId and parseDbId answer the same question", () => {
  expect(parseDbId("17")).toBe(17n);
  expect(requireDbId("17")).toBe(17n);
});
