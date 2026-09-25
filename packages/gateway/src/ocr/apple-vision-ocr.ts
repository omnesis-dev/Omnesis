// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple Vision OCR backend — uses the macOS Vision framework
 * (`VNRecognizeTextRequest`) via a tiny Swift helper run as a subprocess, the
 * same isolation pattern the auth subprocess uses. Free, on-device, fast, and
 * multi-language; the recommended backend when the gateway runs on macOS.
 *
 * The helper Swift source is bundled here and compiled once with `swiftc` to a
 * cached binary on first use (any Mac with the Command Line Tools has swiftc),
 * so there's no build step and no npm/native dependency. When the gateway runs
 * off macOS, or swiftc is absent, the backend reports unavailable and OCR falls
 * back to another assignment.
 *
 * The subprocess runner is injectable so unit tests run without macOS.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import type { OcrCapability, OcrResult } from "@omnesis/core";

const log = createLogger("gateway:ocr:apple-vision");

/** Headless Vision OCR: read an image path (argv[1]), print recognized lines. */
const HELPER_SWIFT_SOURCE = `import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else { exit(2) }
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(3) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if CommandLine.arguments.count > 2 { request.recognitionLanguages = [CommandLine.arguments[2]] }
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  print(lines.joined(separator: "\\n"))
} catch {
  FileHandle.standardError.write("vision error: \\(error)".data(using: .utf8)!)
  exit(4)
}
`;

const CACHE_DIR = join(tmpdir(), "omnesis-ocr");
const HELPER_BIN = join(CACHE_DIR, "apple-vision-ocr");

/** Run the helper on `imagePath` and return its stdout (recognized text). */
export type VisionHelperRunner = (
  imagePath: string,
  opts: { language?: string; timeoutMs: number },
) => Promise<string>;

function commandPresent(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "ignore" });
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

/** Whether Apple Vision is usable: macOS with swiftc. Injected runner ⇒ true. */
export async function appleVisionAvailable(runner?: VisionHelperRunner): Promise<boolean> {
  if (runner) return true;
  if (process.platform !== "darwin") return false;
  return commandPresent("swiftc", ["--version"]);
}

let compilePromise: Promise<string> | null = null;

/** Compile the helper once (cached on disk + in-process) and return its path. */
function ensureHelperCompiled(): Promise<string> {
  if (existsSync(HELPER_BIN)) return Promise.resolve(HELPER_BIN);
  if (compilePromise) return compilePromise;
  compilePromise = (async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    const src = join(CACHE_DIR, "apple-vision-ocr.swift");
    await writeFile(src, HELPER_SWIFT_SOURCE);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("swiftc", ["-O", "-o", HELPER_BIN, src], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      proc.stderr.on("data", (c: Buffer) => {
        err += c.toString();
      });
      proc.on("error", (e) => reject(new Error(`swiftc failed to start: ${e.message}`)));
      proc.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`swiftc exited ${code}: ${err.trim().slice(0, 500)}`)),
      );
    });
    log.info("Compiled the Apple Vision OCR helper");
    return HELPER_BIN;
  })().catch((e) => {
    // Allow a later retry rather than caching the failure forever.
    compilePromise = null;
    throw e;
  });
  return compilePromise;
}

const defaultRunner: VisionHelperRunner = async (imagePath, opts) => {
  const bin = await ensureHelperCompiled();
  return new Promise<string>((resolve, reject) => {
    const args = [imagePath];
    if (opts.language) args.push(opts.language);
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`apple-vision helper timed out after ${opts.timeoutMs}ms`));
      }
    }, opts.timeoutMs);
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`apple-vision helper failed to start: ${e.message}`));
      }
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`apple-vision helper exited ${code}: ${err.trim().slice(0, 300)}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf-8"));
    });
  });
};

export interface AppleVisionOcrOptions {
  /** Injectable for tests; defaults to compiling + spawning the Swift helper. */
  runHelper?: VisionHelperRunner;
  timeoutMs?: number;
}

export class AppleVisionOcr implements OcrCapability {
  readonly name = "apple-vision-ocr";
  readonly modelId = "apple-vision";
  private readonly runHelper: VisionHelperRunner;
  private readonly timeoutMs: number;

  constructor(opts: AppleVisionOcrOptions = {}) {
    this.runHelper = opts.runHelper ?? defaultRunner;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async recognize(
    image: Uint8Array,
    _mimeType: string,
    opts?: { language?: string },
  ): Promise<OcrResult> {
    // The helper reads the image from a path, so spill the bytes to a temp file
    // for the call and remove it afterwards.
    const imagePath = join(tmpdir(), `omnesis-ocr-${randomUUID()}`);
    await writeFile(imagePath, image);
    try {
      const text = (
        await this.runHelper(imagePath, { language: opts?.language, timeoutMs: this.timeoutMs })
      ).trim();
      log.debug(`Apple Vision OCR: ${image.byteLength} bytes → ${text.length} chars`);
      return { text, language: opts?.language };
    } finally {
      await rm(imagePath, { force: true }).catch(() => {});
    }
  }

  async dispose(): Promise<void> {}
}
