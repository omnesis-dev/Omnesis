// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tesseract OCR backend — the CPU-only fallback for hosts without Apple Vision,
 * a GPU vision model, or a configured vision server. Quality is below the VLM
 * backends (clean printed text is fine; handwriting / dense tables are not),
 * so it's the last resort, not the recommended path.
 *
 * `node-tesseract-ocr` shells out to the system `tesseract` binary, so both the
 * npm package AND the binary must be present. The package is an OPTIONAL
 * dependency loaded through a non-literal specifier, so a build that didn't
 * install it still type-checks and boots; the loader probes for it and reports
 * the backend unavailable when it (or the binary) is missing. The module is
 * injectable so unit tests run without it.
 */

import { spawn } from "node:child_process";
import { createLogger } from "@omnesis/core";
import type { OcrCapability, OcrResult } from "@omnesis/core";

const log = createLogger("gateway:ocr:tesseract");

const TESSERACT_SPECIFIER = "node-tesseract-ocr";

/** The slice of `node-tesseract-ocr` we use. */
interface TesseractModule {
  recognize(input: Buffer | string, config?: Record<string, unknown>): Promise<string>;
}

export type TesseractModuleLoader = () => Promise<TesseractModule>;

/** Default loader: import the optional `node-tesseract-ocr` module. */
const defaultTesseractLoader: TesseractModuleLoader = () =>
  import(TESSERACT_SPECIFIER) as Promise<TesseractModule>;

/** Whether the `tesseract` binary is on PATH (resolves quickly via `--version`). */
function tesseractBinaryPresent(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("tesseract", ["--version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, 5_000);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Whether Tesseract is usable: the optional module resolves AND the binary is
 * on PATH. When a loader is injected (tests) the binary check is skipped —
 * the fake module stands in for the whole path.
 */
export async function tesseractAvailable(loader?: TesseractModuleLoader): Promise<boolean> {
  try {
    const mod = await (loader ?? defaultTesseractLoader)();
    if (typeof mod?.recognize !== "function") return false;
    if (loader) return true;
    return await tesseractBinaryPresent();
  } catch {
    return false;
  }
}

export interface TesseractOcrOptions {
  /** Injectable for tests; defaults to importing `node-tesseract-ocr`. */
  loadModule?: TesseractModuleLoader;
  /** Tesseract OCR engine mode / page-seg mode overrides. */
  oem?: number;
  psm?: number;
}

export class TesseractOcr implements OcrCapability {
  readonly name = "tesseract-ocr";
  readonly modelId = "tesseract";
  private readonly loadModule: TesseractModuleLoader;
  private readonly oem: number;
  private readonly psm: number;
  private module: TesseractModule | null = null;

  constructor(opts: TesseractOcrOptions = {}) {
    this.loadModule = opts.loadModule ?? defaultTesseractLoader;
    this.oem = opts.oem ?? 1;
    this.psm = opts.psm ?? 3;
  }

  private async getModule(): Promise<TesseractModule> {
    if (!this.module) this.module = await this.loadModule();
    return this.module;
  }

  async recognize(
    image: Uint8Array,
    _mimeType: string,
    opts?: { language?: string },
  ): Promise<OcrResult> {
    const mod = await this.getModule();
    // ISO-639-1 hint → tesseract's 3-letter code for the common cases; default
    // to English. Unknown hints fall back to English rather than failing.
    const lang = TESSERACT_LANG[opts?.language ?? ""] ?? "eng";
    const text = (
      await mod.recognize(Buffer.from(image), { lang, oem: this.oem, psm: this.psm })
    ).trim();
    log.debug(`Tesseract OCR (${lang}): ${image.byteLength} bytes → ${text.length} chars`);
    return { text, language: opts?.language };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async dispose(): Promise<void> {
    this.module = null;
  }
}

/** ISO-639-1 → Tesseract traineddata code, for the languages users hit most. */
const TESSERACT_LANG: Record<string, string> = {
  en: "eng",
  fr: "fra",
  de: "deu",
  es: "spa",
  it: "ita",
  pt: "por",
  nl: "nld",
  ru: "rus",
  zh: "chi_sim",
  ja: "jpn",
  ko: "kor",
};
