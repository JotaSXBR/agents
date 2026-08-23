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
  const key = logoKeyFor(ctx.tenantId, ext);
  // Bytes first, then the row: a crash between the two leaves an unreferenced file, which costs
  // disk. The other order leaves a row pointing at nothing, which costs every render after it.
  //
  // And the bytes go down through a RENAME, like an issued PDF. A same-format replacement reuses one
  // filename by design (that is what logoVersion exists for), so a plain write truncates the file a
  // preview or an issuance may be reading at that moment — the reader gets empty or partial bytes
  // and the render fails.
  const path = logoPath(key);
  const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.part`;
  await Bun.write(temp, bytes);
  try {
    await rename(temp, path);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
  return setCompanyLogoKey(ctx, key, base);
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
