// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Rasterize a scanned / image-only PDF to per-page PNG images so the OCR
 * backends (which take images, not PDFs) can read them. Uses Poppler's
 * `pdftoppm`, shelled out the same way audio decoding shells out to ffmpeg —
 * it's prebuilt, ubiquitous on Linux (`poppler-utils`) and macOS (Homebrew),
 * and codec-free.
 *
 * `pdftoppm` is an optional system tool: when it's absent the rasterizer
 * returns null and scanned-PDF OCR is simply unavailable (images still OCR).
 * The binary path is overridable for tests via `OMNESIS_PDFTOPPM_BIN`.
 */

import { spawn } from "node:child_process";
import { readdir, readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@omnesis/core";

const log = createLogger("gateway:ocr:pdf");

/** Rasterize a PDF to a list of page images, or null when rasterization can't run. */
export type PdfRasterizer = (pdf: Uint8Array) => Promise<Uint8Array[] | null>;

/** Render at 200 DPI — enough for OCR without ballooning image size. */
const RENDER_DPI = 200;
/** Cap pages per PDF so a 500-page scan can't stall a sync. */
const MAX_PAGES = 50;
const TIMEOUT_MS = 120_000;

function pdftoppmBin(): string {
  return process.env.OMNESIS_PDFTOPPM_BIN || "pdftoppm";
}

export const rasterizePdfToImages: PdfRasterizer = async (pdf) => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-pdf-"));
  const inputPath = join(dir, "in.pdf");
  try {
    await writeFile(inputPath, pdf);
    const ok = await runPdftoppm(inputPath, join(dir, "page"));
    if (!ok) return null;
    // pdftoppm names outputs `page-<n>.png`. Sort by the numeric page index
    // (not lexically) so page order is correct regardless of zero-padding width.
    const pageNum = (f: string): number => Number.parseInt(f.replace(/^page-?/, ""), 10) || 0;
    const files = (await readdir(dir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort((a, b) => pageNum(a) - pageNum(b));
    if (files.length === 0) return null;
    const pages: Uint8Array[] = [];
    for (const f of files) pages.push(new Uint8Array(await readFile(join(dir, f))));
    log.debug(`Rasterized PDF to ${pages.length} page image(s)`);
    return pages;
  } catch (err) {
    log.debug(`PDF rasterization failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * Transcode a HEIC/HEIF image to PNG so OCR backends whose image decoder
 * (Pillow on the vLLM side, Tesseract's loader) can't read HEIC still work —
 * iPhone photos are HEIC by default. Uses libheif's `heif-convert`, shelled out
 * like `pdftoppm`. Optional: returns null when the tool is absent or fails, and
 * the caller proceeds with the original bytes (which a HEIC-capable backend
 * like Apple Vision can still read).
 */
export type ImageTranscoder = (heic: Uint8Array) => Promise<Uint8Array | null>;

function heifConvertBin(): string {
  return process.env.OMNESIS_HEIF_CONVERT_BIN || "heif-convert";
}

export const transcodeHeicToPng: ImageTranscoder = async (heic) => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-heic-"));
  const inPath = join(dir, "in.heic");
  const outPath = join(dir, "out.png");
  try {
    await writeFile(inPath, heic);
    const { ok, stderr } = await runProcessCapturing(heifConvertBin(), [inPath, outPath]);
    // heif-convert writes `out.png` for a single-image file, but `out-1.png`,
    // `out-2.png`, … when the HEIC holds MULTIPLE top-level images (common in
    // iPhone photos — an HDR gain map or aux image alongside the main one). So
    // read whichever PNG it actually produced rather than assuming `out.png`
    // (the bare-name assumption silently dropped every multi-image HEIC).
    const produced = (await readdir(dir))
      .filter((f) => f.startsWith("out") && f.endsWith(".png"))
      .sort((a, b) => a.length - b.length || a.localeCompare(b)); // prefer "out.png", else out-1.png …
    if (produced.length === 0) {
      log.warn(
        `HEIC transcode produced no PNG (heif-convert exit ${ok ? "0" : "non-zero"}): ${stderr.slice(0, 300)}`,
      );
      return null;
    }
    return new Uint8Array(await readFile(join(dir, produced[0])));
  } catch (err) {
    log.warn(`HEIC transcode failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * The image container an OCR backend's loader (Pillow on vLLM, Tesseract's
 * loader) can decode by CONTENT — the MIME label is unreliable, especially for
 * a file imported across services (e.g. a Google Drawing landing in OneDrive as
 * SVG, or an iPhone photo kept as HEIC). `"svg"`/`"unknown"` are NOT decodable
 * rasters: handing them to the vLLM image loader raises an unhandled
 * `UnidentifiedImageError` that resets the HTTP connection — which the collector
 * sees as a transient "fetch failed" and retries forever, stalling the whole
 * source on one bad file. The OCR service sniffs and skips them instead.
 */
export type ImageKind =
  | "png"
  | "jpeg"
  | "gif"
  | "bmp"
  | "webp"
  | "tiff"
  | "heic"
  | "svg"
  | "unknown";

export function sniffImageKind(bytes: Uint8Array): ImageKind {
  const b = bytes;
  if (b.length < 12) return "unknown";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif"; // GIF8
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp"; // BM
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // RIFF
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // WEBP
  ) {
    return "webp";
  }
  if (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || // II*\0
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) // MM\0*
  ) {
    return "tiff";
  }
  // ISO-BMFF `ftyp` box at offset 4 with a HEIF/HEIC brand.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (
      brand.startsWith("hei") ||
      brand.startsWith("hev") ||
      brand.startsWith("mif") ||
      brand.startsWith("msf")
    ) {
      return "heic";
    }
  }
  // SVG and other XML-rooted vector formats: text, not a raster.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(0, 256))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")) return "svg";
  return "unknown";
}

/** Whether the bytes are a raster format the OCR image loaders decode directly. */
export function isDecodableRasterImage(bytes: Uint8Array): boolean {
  switch (sniffImageKind(bytes)) {
    case "png":
    case "jpeg":
    case "gif":
    case "bmp":
    case "webp":
    case "tiff":
      return true;
    default:
      return false;
  }
}

/**
 * Spawn a binary with args, capturing stderr; resolve `{ ok, stderr }` (ok =
 * exit 0). Used where the failure reason matters for diagnosis (HEIC transcode).
 */
function runProcessCapturing(
  bin: string,
  args: string[],
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      resolve({ ok: false, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, stderr });
    };
    proc.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done(false);
    }, TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      stderr += err instanceof Error ? err.message : String(err);
      done(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

function runPdftoppm(inputPath: string, outPrefix: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      pdftoppmBin(),
      ["-png", "-r", String(RENDER_DPI), "-l", String(MAX_PAGES), inputPath, outPrefix],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done(false);
    }, TIMEOUT_MS);
    proc.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}
