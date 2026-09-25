// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Turn a resolved `ocr` assignment into a concrete OCR capability — the OCR
 * analog of the transcriber loader.
 *
 * Backends:
 *   - `replay`                         → SyntheticOcr (tests/demos).
 *   - `codex`                         → CodexOcr (vision model).
 *   - `http` (a declared backend)      → HttpVlmOcr (vLLM / llama-server).
 *   - `local` + `nativeRuntime`        → Apple Vision (macOS), Tesseract, or a
 *                                        llama.cpp vision GGUF subprocess.
 *
 * Anthropic and any non-native `local` (a catalog GGUF — Omnesis ships none for
 * OCR) resolve to null with a log. Every "backend unavailable" path returns
 * null so the route reports `available: false` and the collector falls back to
 * treating the attachment as unextractable binary.
 */

import { createLogger, assertNever } from "@omnesis/core";
import { CodexOcr } from "./codex-ocr.js";
import { SyntheticOcr } from "./synthetic-ocr.js";
import { HttpVlmOcr, type FetchFn } from "./http-vlm-ocr.js";
import { TesseractOcr, tesseractAvailable, type TesseractModuleLoader } from "./tesseract-ocr.js";
import {
  AppleVisionOcr,
  appleVisionAvailable,
  type VisionHelperRunner,
} from "./apple-vision-ocr.js";
import { GgufOcr, mtmdAvailable, type MtmdRunner } from "./gguf-ocr.js";
import type { CodexRuntimeService } from "../models/codex-runtime-service.js";
import type { ResolvedAssignment, OcrCapability } from "@omnesis/core";

const log = createLogger("gateway:ocr:loader");

/** File paths for the built-in `gguf` OCR runtime (`llama-mtmd-cli`). */
export interface OcrGgufRuntimeConfig {
  modelPath: string;
  mmprojPath: string;
  /** `llama-mtmd-cli` binary; falls back to one on PATH when omitted. */
  binPath?: string;
}

export interface LoadOcrDeps {
  /** Create a vision backend on the independent Codex completion lane. */
  codexRuntimeService?: Pick<CodexRuntimeService, "createBackend"> &
    Partial<Pick<CodexRuntimeService, "snapshot">>;
  /** Resolve the bearer token for an HTTP backend (registry owns the keys). */
  getBackendApiKey?: (backendKey: string) => string | undefined;
  /** Paths for the `gguf` runtime, from `inference.ocr.gguf`. */
  getGgufConfig?: () => OcrGgufRuntimeConfig | undefined;
  /** Injectable `fetch` for the HTTP backend (tests). */
  fetchFn?: FetchFn;
  /** Injectable Tesseract module loader (tests / non-default install). */
  loadTesseract?: TesseractModuleLoader;
  /** Injectable Apple Vision subprocess runner (tests). */
  runVisionHelper?: VisionHelperRunner;
  /** Injectable `llama-mtmd-cli` subprocess runner (tests). */
  runMtmd?: MtmdRunner;
}

export async function loadOcrFromResolved(
  resolved: ResolvedAssignment,
  deps: LoadOcrDeps = {},
): Promise<OcrCapability | null> {
  switch (resolved.kind) {
    case "local": {
      if (!resolved.available) {
        log.warn(
          `OCR backend ${resolved.catalogId} not available: ${resolved.reason ?? "unknown"}`,
        );
        return null;
      }
      switch (resolved.nativeRuntime) {
        case "apple-vision": {
          if (!(await appleVisionAvailable(deps.runVisionHelper))) {
            log.warn("Apple Vision OCR needs macOS with the Swift toolchain (swiftc) available.");
            return null;
          }
          return new AppleVisionOcr({ runHelper: deps.runVisionHelper });
        }
        case "tesseract": {
          if (!(await tesseractAvailable(deps.loadTesseract))) {
            log.warn(
              "Tesseract OCR needs the optional `node-tesseract-ocr` dependency and the `tesseract` binary — install them to enable it.",
            );
            return null;
          }
          return new TesseractOcr({ loadModule: deps.loadTesseract });
        }
        case "gguf": {
          const cfg = deps.getGgufConfig?.();
          if (!cfg) {
            log.warn(
              "gguf OCR runtime selected but inference.ocr.gguf.modelPath / mmprojPath are not set.",
            );
            return null;
          }
          if (!(await mtmdAvailable(cfg, deps.runMtmd))) {
            log.warn(
              `gguf OCR runtime unavailable — llama-mtmd-cli or the model/mmproj files were not found (${cfg.binPath ?? "llama-mtmd-cli"}).`,
            );
            return null;
          }
          return new GgufOcr({ ...cfg, runMtmd: deps.runMtmd });
        }
        default:
          log.warn(
            `Local OCR assignment "${resolved.catalogId}" is not a built-in runtime — assign "apple-vision", "tesseract", "gguf", or an HTTP vision backend.`,
          );
          return null;
      }
    }
    case "replay":
      return new SyntheticOcr();
    case "http": {
      if (!resolved.model) {
        log.warn(
          `OCR HTTP backend "${resolved.backendKey}" has no model — set one in the assignment.`,
        );
        return null;
      }
      return new HttpVlmOcr({
        url: resolved.url,
        model: resolved.model,
        apiKey: deps.getBackendApiKey?.(resolved.backendKey),
        fetchFn: deps.fetchFn,
        allowRemoteInference: resolved.allowRemoteInference,
      });
    }
    case "anthropic":
      log.warn(
        "Anthropic is not wired as an OCR backend — assign a local runtime, HTTP vision backend, or Codex.",
      );
      return null;
    case "codex":
      if (
        !resolved.available ||
        !resolved.allowRemoteInference ||
        !resolved.model ||
        !deps.codexRuntimeService
      )
        return null;
      if (
        deps.codexRuntimeService
          .snapshot?.()
          .modelDetails?.find((model) => model.id === resolved.model)
          ?.inputModalities?.includes("image") === false
      )
        return null;
      return new CodexOcr({
        backend: deps.codexRuntimeService.createBackend({
          model: resolved.model,
          lane: "inference",
        }),
      });
    case "disabled":
    case "unresolved":
      return null;
    default:
      return assertNever(resolved);
  }
}
