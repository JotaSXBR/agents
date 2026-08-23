import { describe, expect, test } from "bun:test";
import {
  LOGO_EXT_BY_TYPE,
  LOGO_MAX_BYTES,
  logoBytesLookLike,
  setCompanyLogo,
} from "@/modules/documents/company";

// The letterhead logo is decoded on the SERVER, by @react-pdf/renderer, not by a browser. That is
// what makes the label on an upload untrustworthy in a way it usually is not: a mislabelled file
// does not render badly, it fails the render — every preview and every issuance of a template whose
// header shows a logo, until someone thinks to remove it.

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
// The markers each format ends in. A signature alone accepts a file that was cut short, and a
// truncated logo fails every render of a template that shows it.
const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const JPEG_END = [0xff, 0xd9];

const png = (...body: number[]) => bytes(...PNG_MAGIC, ...body, ...PNG_END);
const jpeg = (...body: number[]) => bytes(...JPEG_MAGIC, ...body, ...JPEG_END);

describe("logoBytesLookLike", () => {
  test("accepts a complete file of each format", () => {
    expect(logoBytesLookLike(png(0x00, 0x01), "png")).toBe(true);
    expect(logoBytesLookLike(jpeg(0xe0, 0x00), "jpg")).toBe(true);
  });

  // The failure a signature check cannot see: the first bytes are genuine and the rest never
  // arrived. The renderer then fails on every preview and every issuance until someone removes it.
  test("refuses a file that was cut short", () => {
    expect(logoBytesLookLike(bytes(...PNG_MAGIC, 0x00, 0x01), "png")).toBe(
      false,
    );
    expect(logoBytesLookLike(bytes(...JPEG_MAGIC, 0xe0, 0x00), "jpg")).toBe(
      false,
    );
    // …and a file that is nothing BUT its markers is not an image either.
    expect(logoBytesLookLike(bytes(...PNG_MAGIC, ...PNG_END), "png")).toBe(
      true,
    );
    expect(logoBytesLookLike(bytes(...JPEG_END), "jpg")).toBe(false);
  });

  // The case the check exists for: `file.type` is whatever the caller wrote in the multipart part,
  // and Bun derives it from the file NAME's extension — which a REST caller controls outright.
  test("refuses bytes of the other format, and bytes of no format", () => {
    expect(logoBytesLookLike(jpeg(0xe0), "png")).toBe(false);
    expect(logoBytesLookLike(png(0x00), "jpg")).toBe(false);
    // A WebP: a RIFF container, which the renderer does not decode at all.
    expect(
      logoBytesLookLike(bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00), "png"),
    ).toBe(false);
    // An SVG announced as a PNG — the shape that would otherwise reach an XML parser.
    expect(
      logoBytesLookLike(new TextEncoder().encode("<svg xmlns="), "png"),
    ).toBe(false);
  });

  test("a file too short to carry a signature is not a maybe", () => {
    expect(logoBytesLookLike(bytes(0x89, 0x50), "png")).toBe(false);
    expect(logoBytesLookLike(new Uint8Array(), "jpg")).toBe(false);
  });
});

describe("setCompanyLogo", () => {
  const ctx = { tenantId: 1n, userId: null, role: "TENANT_ADMIN" as const };

  function upload(type: string, body: number[]) {
    return {
      type,
      size: body.length,
      arrayBuffer: async () => new Uint8Array(body).buffer as ArrayBuffer,
    };
  }

  // Refused BEFORE anything is written, which is why this needs no storage directory: a mislabelled
  // upload must not leave bytes on disk under a name that says they are something else.
  test("refuses a JPEG announced as a PNG", async () => {
    await expect(
      setCompanyLogo(
        ctx,
        upload("image/png", [...JPEG_MAGIC, 0xe0, ...JPEG_END]),
      ),
    ).rejects.toThrow(/PNG or JPEG/);
  });

  test("still refuses a type outside the allowlist, and an oversized file", async () => {
    expect(LOGO_EXT_BY_TYPE["image/webp"]).toBeUndefined();
    await expect(
      setCompanyLogo(ctx, upload("image/webp", [...PNG_MAGIC, ...PNG_END])),
    ).rejects.toThrow(/PNG or JPEG/);
    await expect(
      setCompanyLogo(ctx, {
        type: "image/png",
        size: LOGO_MAX_BYTES + 1,
        arrayBuffer: async () =>
          new Uint8Array(PNG_MAGIC).buffer as ArrayBuffer,
      }),
    ).rejects.toThrow(/too large/);
  });
});
