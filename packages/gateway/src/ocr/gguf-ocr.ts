// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-process GGUF OCR backend — runs a llama.cpp vision model (e.g.
 * PaddleOCR-VL, dots.ocr, a Qwen-VL GGUF) locally on the gateway host via the
 * `llama-mtmd-cli` multimodal CLI, with no separate server. node-llama-cpp does
 * not expose llama.cpp's multimodal (mtmd) API, so we shell out to the CLI the
 * same way the transcriber shells out to ffmpeg — the binary, model, and
 * companion projector (mmproj) paths come from `inference.ocr.gguf`.
 *
 * The CLI binary and the subprocess runner are injectable so unit tests run
 * without llama.cpp or a model on disk.
 */

import { existsSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { processLauncher } from "../process-launcher/index.js";
import { OCR_PROMPT, layoutReplyText } from "./http-vlm-ocr.js";
import type { OcrCapability, OcrResult } from "@omnesis/core";

const log = createLogger("gateway:ocr:gguf");

const DEFAULT_BIN = "llama-mtmd-cli";

export interface MtmdRunArgs {
  binPath: string;
  modelPath: string;
  mmprojPath: string;
  /** Path to the image file to recognize. */
  imagePath: string;
  prompt: string;
  timeoutMs: number;
  /** Kills the process when the caller stops waiting. */
  signal?: AbortSignal;
}

/** Run `llama-mtmd-cli` for one image and return its stdout (the generated text). */
export type MtmdRunner = (args: MtmdRunArgs) => Promise<string>;

/** Whether a binary resolves: an explicit path that exists, or one on PATH. */
function binaryResolvable(binPath: string): Promise<boolean> {
  if (binPath !== DEFAULT_BIN && binPath.includes("/")) {
    return Promise.resolve(existsSync(binPath));
  }
  return processLauncher()
    .run(binPath, ["--version"], { timeoutMs: 5_000, captureStdout: false })
    .then((run) => run.failure === undefined);
}

/**
 * Whether the gguf runtime is usable: the model + mmproj files exist and the
 * `llama-mtmd-cli` binary resolves. When a runner is injected (tests) the
 * checks are skipped.
 */
export async function mtmdAvailable(
  cfg: { modelPath: string; mmprojPath: string; binPath?: string },
  runner?: MtmdRunner,
): Promise<boolean> {
  if (runner) return true;
  if (!existsSync(cfg.modelPath) || !existsSync(cfg.mmprojPath)) return false;
  return binaryResolvable(cfg.binPath ?? DEFAULT_BIN);
}

const defaultMtmdRunner: MtmdRunner = async (args) => {
  const run = await processLauncher().run(
    args.binPath,
    [
      "-m",
      args.modelPath,
      "--mmproj",
      args.mmprojPath,
      "--image",
      args.imagePath,
      "-p",
      args.prompt,
      "--temp",
      "0",
      "-n",
      "4096",
      "-ngl",
      "99",
    ],
    { timeoutMs: args.timeoutMs, ...(args.signal ? { signal: args.signal } : {}) },
  );
  if (run.failure === "timeout")
    throw new Error(`llama-mtmd-cli timed out after ${args.timeoutMs}ms`);
  if (run.failure === "aborted")
    throw new Error("llama-mtmd-cli stopped: the caller stopped waiting");
  if (run.failure) throw new Error(`llama-mtmd-cli failed to start: ${run.failureMessage}`);
  if (run.exitCode !== 0)
    throw new Error(`llama-mtmd-cli exited ${run.exitCode}: ${run.stderr.trim().slice(0, 500)}`);
  return Buffer.from(run.stdout).toString("utf-8");
};

export interface GgufOcrOptions {
  modelPath: string;
  mmprojPath: string;
  binPath?: string;
  /** Injectable for tests; defaults to spawning `llama-mtmd-cli`. */
  runMtmd?: MtmdRunner;
  timeoutMs?: number;
}

export class GgufOcr implements OcrCapability {
  readonly name = "gguf-ocr";
  readonly modelId: string;
  private readonly modelPath: string;
  private readonly mmprojPath: string;
  private readonly binPath: string;
  private readonly runMtmd: MtmdRunner;
  private readonly timeoutMs: number;

  constructor(opts: GgufOcrOptions) {
    this.modelPath = opts.modelPath;
    this.mmprojPath = opts.mmprojPath;
    this.binPath = opts.binPath ?? DEFAULT_BIN;
    this.runMtmd = opts.runMtmd ?? defaultMtmdRunner;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    // Surface the model filename as the id, so the portal/CLI shows which GGUF.
    this.modelId = opts.modelPath.split("/").pop() ?? "gguf";
  }

  async recognize(
    image: Uint8Array,
    _mimeType: string,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<OcrResult> {
    // llama-mtmd-cli reads the image from a path, so spill the bytes to a temp
    // file for the duration of the call and remove it afterwards.
    const imagePath = join(tmpdir(), `omnesis-ocr-${randomUUID()}`);
    await writeFile(imagePath, image);
    try {
      const raw = await this.runMtmd({
        binPath: this.binPath,
        modelPath: this.modelPath,
        mmprojPath: this.mmprojPath,
        imagePath,
        prompt: OCR_PROMPT,
        timeoutMs: this.timeoutMs,
        signal: opts?.signal,
      });
      const text = layoutReplyText(raw.trim());
      log.debug(`GGUF OCR (${this.modelId}): ${image.byteLength} bytes → ${text.length} chars`);
      return { text };
    } finally {
      await rm(imagePath, { force: true }).catch(() => {});
    }
  }

  async dispose(): Promise<void> {}
}
