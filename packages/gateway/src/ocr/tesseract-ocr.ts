// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tesseract OCR backend — the CPU-only fallback for hosts without Apple Vision,
 * a GPU vision model, or a configured vision server. Quality is below the VLM
 * backends (clean printed text is fine; handwriting / dense tables are not),
 * so it's the last resort, not the recommended path.
 *
 * The system binary receives image bytes on stdin through the shared process
 * launcher, with literal arguments and owned timeout/cancellation cleanup.
 * The module loader remains injectable for deterministic callers and tests.
 */

import { createLogger } from "@omnesis/core";
import { processLauncher } from "../process-launcher/index.js";
import type { OcrCapability, OcrResult } from "@omnesis/core";

const log = createLogger("gateway:ocr:tesseract");

/** Compatibility seam for injected OCR engines; no external wrapper is loaded. */
interface TesseractModule {
  recognize(input: Buffer | string, config?: Record<string, unknown>): Promise<string>;
}

export type TesseractModuleLoader = () => Promise<TesseractModule>;

export interface TesseractRunArgs {
  image: Uint8Array;
  language: string;
  oem: number;
  psm: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type TesseractRunner = (args: TesseractRunArgs) => Promise<string>;

const defaultTesseractRunner: TesseractRunner = async (args) => {
  const result = await processLauncher().run(
    "tesseract",
    ["stdin", "stdout", "-l", args.language, "--oem", String(args.oem), "--psm", String(args.psm)],
    {
      input: args.image,
      timeoutMs: args.timeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
    },
  );
  if (result.failure === "timeout")
    throw new Error(`Tesseract OCR timed out after ${args.timeoutMs}ms`);
  if (result.failure === "aborted")
    throw new Error("Tesseract OCR stopped: the caller stopped waiting");
  if (result.failure) throw new Error("Tesseract OCR failed to start");
  if (result.exitCode !== 0) throw new Error(`Tesseract OCR exited ${result.exitCode}`);
  return Buffer.from(result.stdout).toString("utf8");
};

/** Whether the `tesseract` binary is on PATH (resolves quickly via `--version`). */
async function tesseractBinaryPresent(): Promise<boolean> {
  const run = await processLauncher().run("tesseract", ["--version"], {
    timeoutMs: 5_000,
    captureStdout: false,
  });
  return !run.failure && run.exitCode === 0;
}

/**
 * Whether Tesseract is usable: the system binary is on PATH. An injected
 * loader stands in for the engine and skips the binary check.
 */
export async function tesseractAvailable(loader?: TesseractModuleLoader): Promise<boolean> {
  try {
    if (loader) return typeof (await loader())?.recognize === "function";
    return await tesseractBinaryPresent();
  } catch {
    return false;
  }
}

export interface TesseractOcrOptions {
  /** Optional injected engine; defaults to the owned system binary runner. */
  loadModule?: TesseractModuleLoader;
  runTesseract?: TesseractRunner;
  timeoutMs?: number;
  /** Tesseract OCR engine mode / page-seg mode overrides. */
  oem?: number;
  psm?: number;
}

export class TesseractOcr implements OcrCapability {
  readonly name = "tesseract-ocr";
  readonly modelId = "tesseract";
  private readonly loadModule?: TesseractModuleLoader;
  private readonly runTesseract: TesseractRunner;
  private readonly timeoutMs: number;
  private readonly oem: number;
  private readonly psm: number;
  private module: TesseractModule | null = null;

  constructor(opts: TesseractOcrOptions = {}) {
    this.loadModule = opts.loadModule;
    this.runTesseract = opts.runTesseract ?? defaultTesseractRunner;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.oem = opts.oem ?? 1;
    this.psm = opts.psm ?? 3;
  }

  private async getModule(): Promise<TesseractModule> {
    if (!this.loadModule) throw new Error("No injected Tesseract engine");
    if (!this.module) this.module = await this.loadModule();
    return this.module;
  }

  async recognize(
    image: Uint8Array,
    _mimeType: string,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<OcrResult> {
    // ISO-639-1 hint → tesseract's 3-letter code for the common cases; default
    // to English. Unknown hints fall back to English rather than failing.
    const hint = opts?.language ?? "";
    const lang = Object.hasOwn(TESSERACT_LANG, hint) ? TESSERACT_LANG[hint]! : "eng";
    const text = (
      this.loadModule
        ? await (
            await this.getModule()
          ).recognize(Buffer.from(image), { lang, oem: this.oem, psm: this.psm })
        : await this.runTesseract({
            image,
            language: lang,
            oem: this.oem,
            psm: this.psm,
            timeoutMs: this.timeoutMs,
            signal: opts?.signal,
          })
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
