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
  const key = logoKeyFor(ctx.tenantId, ext);
  // Bytes first, then the row: a crash between the two leaves an unreferenced file, which costs
  // disk. The other order leaves a row pointing at nothing, which costs every render after it.
  await Bun.write(logoPath(key), new Uint8Array(await file.arrayBuffer()));
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
