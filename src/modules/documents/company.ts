import { rename, rm } from "node:fs/promises";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  type CompanySettings,
  setCompanyLogoKey,
} from "@/modules/tenant-settings/service";

// The tenant's letterhead logo: bytes on disk, file name in the settings block. Same split as
// branding, and the same write order (bytes first, row second) so the stored name never points at a
// file that is not there.
//
// The allowlist is NARROWER than branding's, and deliberately so. Branding assets are decoded by a
// browser; this one is decoded by @react-pdf/renderer, which handles fewer formats — a WebP simply
// does not draw, and an SVG is fed to an XML parser inside the renderer, which is a tenant upload
// reaching a parser on the server for no benefit a raster logo does not already give.
export const LOGO_EXT_BY_TYPE: Record<string, "png" | "jpg"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
export const LOGO_MAX_BYTES = 524_288; // 512 KB

// The BYTES decide the format, not the label on them. `file.type` is whatever the caller put in the
// multipart part (and Bun derives it from the file NAME's extension, which a REST caller controls
// outright), so a JPEG announced as image/png would be stored under a .png key and handed to
// @react-pdf/renderer as a PNG — which then fails every preview and every issuance of a template
// showing the logo, until someone thinks to remove it. Two signatures, matching the allowlist above.
const LOGO_SIGNATURES: Record<"png" | "jpg", number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
};

// The END of the file as well as its start. A signature check alone accepts a TRUNCATED upload —
// the first bytes are genuine, the rest never arrived — and the renderer then fails on every preview
// and every issuance of a template showing the logo, until somebody thinks to remove it. Both
// formats end in a fixed marker, so the cheap test for "the whole file is here" is that the marker
// is.
//
// This is a structural check, not a decode: it catches a file that was cut short, which is the
// failure that actually happens on an upload. A file that is complete and still undecodable
// (corrupt pixel data) reaches the renderer, and the render is where it is caught.
const LOGO_TERMINATORS: Record<"png" | "jpg", number[]> = {
  png: [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], // IEND + its CRC
  jpg: [0xff, 0xd9], // EOI
};

// A LOGO, not a poster. The byte cap does not bound this: PNG and JPEG both compress flat colour
// enormously, so a 40 KB file can declare 20000×20000 — and @react-pdf/renderer decodes server-side,
// allocating width × height × 4 bytes, which is 1.6 GB for that one. Every tenant shares the process.
//
// Four megapixels is roughly 2000×2000, which is far beyond what a letterhead needs (it prints
// around 150pt wide) and still bounded at ~16 MB decoded.
export const LOGO_MAX_PIXELS = 4_000_000;

function beUint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)
  );
}

// Declared dimensions, read from the header rather than by decoding. PNG puts them in the IHDR
// chunk, which the format requires to come first: 8 bytes of signature, 4 of length, 4 of type, then
// width and height. JPEG carries them in whichever SOFn frame header comes first, so the marker
// segments are walked until one turns up.
export function logoPixels(
  bytes: Uint8Array,
  ext: "png" | "jpg",
): number | null {
  if (ext === "png") {
    if (bytes.length < 24) return null;
    return beUint32(bytes, 16) * beUint32(bytes, 20);
  }
  let at = 2; // past SOI
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // SOF0..SOF15 carry the frame header; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0);
      const width = ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0);
      return width * height;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

export function logoBytesLookLike(
  bytes: Uint8Array,
  ext: "png" | "jpg",
): boolean {
  // No length guard on the signature: `every` walks the SIGNATURE, so a file shorter than it
  // compares a byte against `undefined` and fails. Measured — the guard survived removal against the
  // whole table, which is the definition of a clause that decides nothing.
  if (!LOGO_SIGNATURES[ext].every((byte, i) => bytes[i] === byte)) return false;
  const end = LOGO_TERMINATORS[ext];
  const at = bytes.length - end.length;
  // `at > 0` and not `>= 0`: a file that is ONLY its terminator has no image in it.
  return at > 0 && end.every((byte, i) => bytes[at + i] === byte);
}

export const LOGO_CONTENT_TYPE: Record<"png" | "jpg", string> = {
  png: "image/png",
  jpg: "image/jpeg",
};

// Derived from a numeric id and an extension out of the allowlist above — never from anything a
// caller wrote, so no input reaches the path.
function logoPath(key: string): string {
  return `${config.documentsStorageDir}/company/${key}`;
}

export function logoKeyFor(tenantId: bigint, ext: "png" | "jpg"): string {
  return `${tenantId}-logo.${ext}`;
}

export function logoExtOf(key: string): "png" | "jpg" | null {
  if (key.endsWith(".png")) return "png";
  if (key.endsWith(".jpg")) return "jpg";
  return null;
}

export interface UploadedFile {
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export async function setCompanyLogo(
  ctx: TenantContext,
  file: UploadedFile,
  base: PrismaClient = basePrisma,
): Promise<CompanySettings> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const ext = LOGO_EXT_BY_TYPE[file.type];
  if (!ext) {
    throw new AppError(
      "the logo must be a PNG or JPEG",
      400,
      "errors.unsupportedImageType",
    );
  }
  if (file.size > LOGO_MAX_BYTES) {
    throw new AppError("image too large", 400, "errors.imageTooLarge");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!logoBytesLookLike(bytes, ext)) {
    throw new AppError(
      "the logo must be a PNG or JPEG",
      400,
      "errors.unsupportedImageType",
    );
  }
  // Dimensions decide, not bytes. A file well under the size cap can declare enough pixels to
  // exhaust the process when the renderer decodes it, and the renderer runs on every preview and
  // every issuance of a template that shows the logo — for every tenant on the instance.
  // Unreadable dimensions are refused too: an image we cannot measure is one we cannot bound.
  const pixels = logoPixels(bytes, ext);
  if (pixels === null || pixels <= 0 || pixels > LOGO_MAX_PIXELS) {
    throw new AppError(
      `the logo must be at most ${LOGO_MAX_PIXELS} pixels (about 2000×2000)`,
      400,
      "errors.imageTooLarge",
    );
  }
  const key = logoKeyFor(ctx.tenantId, ext);
  // Bytes first, then the row: a crash between the two leaves an unreferenced file, which costs
  // disk. The other order leaves a row pointing at nothing, which costs every render after it.
  //
  // And the bytes go down through a RENAME, like an issued PDF. A same-format replacement reuses one
  // filename by design (that is what logoVersion exists for), so a plain write truncates the file a
  // preview or an issuance may be reading at that moment — the reader gets empty or partial bytes
  // and the render fails.
  const path = logoPath(key);
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const temp = `${path}.${suffix}.part`;
  const previous = `${path}.${suffix}.prev`;
  await Bun.write(temp, bytes);

  // A same-format replacement reuses the SAME path (that is what logoVersion exists for), so the
  // bytes on disk change before the row that records the change does. If that write then fails, the
  // endpoint reports a failure while every document already renders the new letterhead and every
  // cached client still shows the old one — the exact mismatch the version was added to prevent.
  //
  // So the old file is set aside first and put back if the row does not commit. The reader-facing
  // swap is still a rename, so nobody ever sees a partial file.
  const hadPrevious = await Bun.file(path).exists();
  if (hadPrevious) await rename(path, previous);
  try {
    await rename(temp, path);
  } catch (e) {
    if (hadPrevious) await rename(previous, path).catch(() => undefined);
    await rm(temp, { force: true });
    throw e;
  }
  try {
    const saved = await setCompanyLogoKey(ctx, key, base);
    if (hadPrevious) await rm(previous, { force: true });
    return saved;
  } catch (e) {
    // The row did not commit, so the letterhead has to go back to the one it still describes.
    if (hadPrevious) await rename(previous, path).catch(() => undefined);
    else await rm(path, { force: true });
    throw e;
  }
}

export async function clearCompanyLogo(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<CompanySettings> {
  return setCompanyLogoKey(ctx, null, base);
}

export interface CompanyLogo {
  data: Buffer;
  format: "png" | "jpg";
}

// Returns null for every "there is no usable logo" case — not configured, wrong extension, file
// gone. A missing logo must never fail a render: the document still has to reach the customer, and
// it reads fine with a typographic header.
export async function readCompanyLogo(
  company: CompanySettings,
): Promise<CompanyLogo | null> {
  if (!company.logoKey) return null;
  const format = logoExtOf(company.logoKey);
  if (!format) return null;
  const file = Bun.file(logoPath(company.logoKey));
  if (!(await file.exists())) return null;
  return { data: Buffer.from(await file.arrayBuffer()), format };
}
