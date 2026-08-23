import { describe, expect, test } from "bun:test";
import {
  LOGO_EXT_BY_TYPE,
  LOGO_MAX_BYTES,
  logoBytesLookLike,
  logoPixels,
  logoRollbackAction,
  setCompanyLogo,
} from "@/modules/documents/company";
import type { CompanySettings } from "@/modules/tenant-settings/service";

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

const be32 = (n: number) => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

// A PNG header the way the format requires it: signature, then IHDR (length, type, width, height).
const png = (w = 100, h = 100) =>
  bytes(
    ...PNG_MAGIC,
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(w),
    ...be32(h),
    ...PNG_END,
  );
// A JPEG with one APP0 segment before the SOF0 frame header, so the marker walk has to skip one.
const jpeg = (w = 100, h = 100) =>
  bytes(
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(4),
    0x00,
    0x00,
    0xff,
    0xc0,
    ...be16(11),
    0x08,
    ...be16(h),
    ...be16(w),
    0x00,
    0x00,
    0x00,
    ...JPEG_END,
  );

describe("logoBytesLookLike", () => {
  test("accepts a complete file of each format", () => {
    expect(logoBytesLookLike(png(), "png")).toBe(true);
    expect(logoBytesLookLike(jpeg(), "jpg")).toBe(true);
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
    expect(logoBytesLookLike(jpeg(), "png")).toBe(false);
    expect(logoBytesLookLike(png(), "jpg")).toBe(false);
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

// The byte cap does not bound the DECODE. Both formats compress flat colour enormously, so a file
// well under 512 KB can declare dimensions whose pixel buffer is gigabytes — allocated server-side,
// on every preview and every issuance, in a process every tenant shares.
describe("logoPixels", () => {
  test("reads the declared dimensions of each format", () => {
    expect(logoPixels(png(640, 480), "png")).toBe(640 * 480);
    // Past an APP0 segment: the frame header is not the first marker in a real file.
    expect(logoPixels(jpeg(640, 480), "jpg")).toBe(640 * 480);
  });

  test("returns null when the header cannot be read", () => {
    expect(logoPixels(bytes(...PNG_MAGIC), "png")).toBeNull();
    expect(logoPixels(bytes(0xff, 0xd8), "jpg")).toBeNull();
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
      setCompanyLogo(ctx, upload("image/png", [...jpeg()])),
    ).rejects.toThrow(/PNG or JPEG/);
  });

  // The one the size cap cannot catch: a small file that decodes into gigabytes.
  test("refuses an image whose declared dimensions are past the pixel budget", async () => {
    const huge = png(20_000, 20_000);
    expect(huge.length).toBeLessThan(LOGO_MAX_BYTES);
    await expect(
      setCompanyLogo(ctx, upload("image/png", [...huge])),
    ).rejects.toThrow(/pixels/);
    // …and one we cannot measure at all is refused too: unmeasurable is unbounded.
    await expect(
      setCompanyLogo(
        ctx,
        upload("image/png", [...PNG_MAGIC, 0x00, ...PNG_END]),
      ),
    ).rejects.toThrow();
  });

  test("still refuses a type outside the allowlist, and an oversized file", async () => {
    expect(LOGO_EXT_BY_TYPE["image/webp"]).toBeUndefined();
    await expect(
      setCompanyLogo(ctx, upload("image/webp", [...png()])),
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

// The rollback of a failed upload runs AFTER its own transaction ended, so the lock it published
// under is gone and the state it means to undo may not be the state on disk any more. That makes
// "should I undo?" a decision with three answers rather than a cleanup with two.
describe("logoRollbackAction", () => {
  const block = (over: Partial<CompanySettings> = {}): CompanySettings =>
    ({
      name: "",
      document: "",
      address: "",
      phone: "",
      email: "",
      website: "",
      logoKey: "1-logo.png",
      logoVersion: 100,
      ...over,
    }) as CompanySettings;

  test("puts the previous letterhead back when nothing else has written", () => {
    expect(logoRollbackAction(block(), block(), true)).toBe("restore");
  });

  // No previous file means the bytes we wrote belong to a row that never committed: leaving them
  // keeps an unreferenced letterhead on disk forever.
  test("removes its own bytes when there was nothing to put back", () => {
    expect(logoRollbackAction(block(), block(), false)).toBe("remove");
  });

  // The case the lock exists for: an upload that was waiting on it published and committed while
  // this one was failing. Restoring over that leaves the committed logoKey/logoVersion describing
  // the wrong image, and the remove branch deletes the letterhead that just won.
  test("does nothing once another upload has committed", () => {
    const after = block({ logoVersion: 101 });
    expect(logoRollbackAction(block(), after, true)).toBe("none");
    expect(logoRollbackAction(block(), after, false)).toBe("none");
  });

  // And when the publish never ran — a failure in the lock or in the read that precedes it — there
  // is nothing of ours on disk at all. The remove branch would then delete a live logo this request
  // never touched, over a database hiccup.
  test("does nothing when nothing was ever published", () => {
    expect(logoRollbackAction(null, block(), false)).toBe("none");
    expect(logoRollbackAction(null, block(), true)).toBe("none");
  });
});
