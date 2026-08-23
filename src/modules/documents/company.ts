import { copyFile, rename, rm } from "node:fs/promises";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type CompanySettings,
  readCompanySettings,
  setCompanyLogoKey,
  withCompanyLock,
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
  // bytes on disk and the row that records them have to move TOGETHER. Two things go wrong when they
  // do not: a failed row write leaves every document rendering the new letterhead while every cached
  // client still shows the old one, and two overlapping uploads interleave — one moves the current
  // file aside, the other sees the path free and installs its bytes, and whichever row commits last
  // describes the other one's image.
  //
  // Both are the same fix: the swap happens INSIDE the per-tenant settings lock, as part of the same
  // transaction, so uploads serialise and a row that does not commit takes its bytes back with it.
  // The reader-facing swap is still a rename, so nobody ever sees a partial file.
  let hadPrevious = false;
  // The block as it stood UNDER the lock, and whether the publish below actually ran. Both are read
  // by the rollback: what to put back, and whether there is anything of ours to put back at all.
  const published: { before: CompanySettings | null } = { before: null };
  try {
    const saved = await setCompanyLogoKey(
      ctx,
      key,
      base,
      Date.now(),
      async (current) => {
        published.before = current;
        // COPIED aside, not moved. Renaming the live file away leaves the configured path EMPTY for
        // the length of the swap, and a preview or an issuance landing in that gap renders a document
        // with no letterhead at all — permanently, because the document it produces is frozen. A copy
        // keeps the live name populated the whole time, and the rename below replaces it atomically:
        // a reader sees the old logo or the new one, never neither.
        //
        // NOT COVERED BY A TEST: the gap is between two adjacent statements inside this callback, so
        // observing it needs a reader scheduled between them — which no test can arrange without a
        // hook that exists only for the test. The property is structural instead: nothing here ever
        // unlinks the live name.
        hadPrevious = await Bun.file(path).exists();
        if (hadPrevious) await copyFile(path, previous);
        // No restore here: a throw from inside the lock aborts the transaction and lands in the catch
        // below, which restores for BOTH reasons a write can fail. Two restores for one condition is
        // one that never runs.
        await rename(temp, path);
      },
    );
    // AFTER the row commits: the old key is no longer referenced, so its file is disk nobody will
    // ever read again. Only when the FORMAT changed — a same-format replacement wrote over the one
    // path, and removing it here would delete the letterhead that was just installed. Read from
    // under the lock, so it names the file this write actually superseded.
    const previousKey = published.before?.logoKey;
    if (previousKey && previousKey !== key) await removeLogoFile(previousKey);
    return saved;
  } catch (e) {
    // The transaction rolled back (the publish itself failed, or the row write did), so the file
    // goes back to whatever the stored version still describes. When there was no previous file,
    // that is NO file: leaving the new one behind would keep an unreferenced letterhead on disk for
    // a row that never committed. (Round 24 folded two restore branches into one and dropped this
    // half with them.)
    //
    // Under the lock again, and conditional, because this runs AFTER our transaction ended: an
    // upload that was waiting on the lock can have published its own bytes and committed in
    // between, and restoring over those would leave a committed logoKey/logoVersion describing the
    // wrong image — or, in the no-previous branch, delete the letterhead that just won. The version
    // is strictly increasing, so "unchanged" is the whole test. And when the publish never ran (a
    // failure before it: the lock, the read) there is nothing of ours on disk to undo — the rm
    // branch would then delete a live logo this request never touched.
    //
    // NO LOCAL FAILURE MEASURED for the lock itself: reaching the interleaving needs a second
    // upload that takes the lock between our transaction ending and this one starting, and a
    // single-process test cannot schedule that — removing the lock here leaves the suite green
    // (measured). What IS covered is the decision it protects, as a table, plus the reachable half
    // of it: a failure before anything is published leaves the live letterhead alone.
    await withCompanyLock(ctx, base, async (current) => {
      const action = logoRollbackAction(published.before, current, hadPrevious);
      if (action === "restore") {
        await rename(previous, path).catch(() => undefined);
      } else if (action === "remove") {
        await rm(path, { force: true });
      }
    }).catch(() => undefined);
    throw e;
  } finally {
    await rm(temp, { force: true });
    await rm(previous, { force: true });
  }
}

export async function clearCompanyLogo(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<CompanySettings> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const before = await runScopedOn(base, ctx, (db) =>
    readCompanySettings(db, tenantId),
  );
  const cleared = await setCompanyLogoKey(ctx, null, base);
  // AFTER the row commits, never before: removing first and failing the write would leave the
  // settings pointing at a file that is gone, which is the one state every render has to handle and
  // none of them should have to. Clearing the key alone left the image on disk and in every backup
  // taken after it — an operator asking for it to be gone means gone.
  await removeLogoFile(before.logoKey);
  return cleared;
}

// What a failed upload should do about the bytes it put on disk, decided against the block as it
// stands under the lock — because by the time this runs, our own transaction is over.
//
// One question decides it: is the committed version still the one we published under?
//
//   none    — it is not. Either something else committed in between (restoring over that would
//             leave the committed logoKey/logoVersion describing the wrong image, and the remove
//             branch would delete the letterhead that just won), or the publish never ran at all —
//             a failure in the lock or in the read that precedes it — in which case there is
//             nothing of ours on disk and removing "the new file" would delete a live logo this
//             request never touched, over a database hiccup. A never-published upload has no
//             version, so the same comparison answers both; the null case needed its own clause
//             only until this was written as a comparison, and mutation testing is what showed the
//             clause was doing nothing.
//   restore — it is, and we moved a letterhead aside, so it goes back.
//   remove  — it is, and there was none: the file we wrote belongs to a row that never committed.
//
// logoVersion is strictly increasing (see setCompanyLogoKey), which is what makes "unchanged" a
// usable test rather than a coincidence.
export function logoRollbackAction(
  before: CompanySettings | null,
  current: CompanySettings,
  hadPrevious: boolean,
): "restore" | "remove" | "none" {
  if (current.logoVersion !== before?.logoVersion) return "none";
  return hadPrevious ? "restore" : "remove";
}

// The file a key names, if it names one. Best-effort by design: the row no longer references it, so
// a failure here costs disk and nothing else — refusing the operation over it would be worse.
async function removeLogoFile(key: string | null): Promise<void> {
  if (!key || !logoExtOf(key)) return;
  await rm(logoPath(key), { force: true }).catch(() => undefined);
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
