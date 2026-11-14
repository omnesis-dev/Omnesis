// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, test, expect, vi } from "vitest";
import { createPrivateScratchAsync } from "@omnesis/core";

vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  return { ...actual, createPrivateScratchAsync: vi.fn(actual.createPrivateScratchAsync) };
});
afterEach(() => {
  vi.mocked(createPrivateScratchAsync).mockReset();
});
import { GgufOcr, mtmdAvailable, type MtmdRunArgs } from "./gguf-ocr.js";
import { OCR_PROMPT } from "./http-vlm-ocr.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("GgufOcr", () => {
  test("spills the image to a temp file and runs llama-mtmd-cli with the configured paths", async () => {
    let seen: MtmdRunArgs | null = null;
    let imageExistedDuringRun = false;
    const runMtmd = vi.fn(async (args: MtmdRunArgs) => {
      seen = args;
      imageExistedDuringRun = existsSync(args.imagePath);
      expect(readFileSync(args.imagePath)).toEqual(Buffer.from("PNG"));
      if (process.platform !== "win32") {
        expect(statSync(args.imagePath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(args.imagePath)).mode & 0o777).toBe(0o700);
      }
      return "OCR OUTPUT TEXT";
    });
    const ocr = new GgufOcr({
      modelPath: "/models/paddleocr-vl.gguf",
      mmprojPath: "/models/paddleocr-vl.mmproj.gguf",
      binPath: "/usr/bin/llama-mtmd-cli",
      runMtmd,
    });
    const result = await ocr.recognize(enc("PNG"), "image/png");

    expect(result.text).toBe("OCR OUTPUT TEXT");
    expect(seen!.modelPath).toBe("/models/paddleocr-vl.gguf");
    expect(seen!.mmprojPath).toBe("/models/paddleocr-vl.mmproj.gguf");
    expect(seen!.binPath).toBe("/usr/bin/llama-mtmd-cli");
    expect(seen!.prompt).toBe(OCR_PROMPT);
    expect(imageExistedDuringRun).toBe(true);
    // The temp file is removed after the call.
    expect(existsSync(seen!.imagePath)).toBe(false);
    expect(existsSync(dirname(seen!.imagePath))).toBe(false);
  });

  test("surfaces the model filename as the modelId", () => {
    const ocr = new GgufOcr({
      modelPath: "/models/dots.ocr.Q8_0.gguf",
      mmprojPath: "/m.gguf",
      runMtmd: async () => "",
    });
    expect(ocr.modelId).toBe("dots.ocr.Q8_0.gguf");
  });

  test("uses the native model basename without exposing parent directories", () => {
    const modelPath = join("models", "nested folder", "ocr.gguf");
    expect(
      new GgufOcr({ modelPath, mmprojPath: "projector", runMtmd: async () => "" }).modelId,
    ).toBe(basename(modelPath));
  });

  test("removes owned private scratch after failure and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    let imagePath = "";
    const ocr = new GgufOcr({
      modelPath: "m.gguf",
      mmprojPath: "p.gguf",
      runMtmd: async (args) => {
        imagePath = args.imagePath;
        expect(args.signal).toBe(signal);
        throw new Error("synthetic runner failure");
      },
    });
    await expect(ocr.recognize(enc("img"), "image/png", { signal })).rejects.toThrow(
      "synthetic runner failure",
    );
    expect(imagePath).not.toBe("");
    expect(existsSync(dirname(imagePath))).toBe(false);
  });

  test("never writes image bytes before the async private boundary is ready", async () => {
    const core = await vi.importActual<typeof import("@omnesis/core")>("@omnesis/core");
    const scratch = await core.createPrivateScratchAsync("ocr-test");
    let ready!: (value: typeof scratch) => void;
    vi.mocked(createPrivateScratchAsync).mockReturnValueOnce(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    const runMtmd = vi.fn(async () => "recognized");
    const run = new GgufOcr({ modelPath: "m.gguf", mmprojPath: "p.gguf", runMtmd }).recognize(
      enc("private image"),
      "image/png",
    );
    try {
      await Promise.resolve();
      expect(existsSync(join(scratch.path, "image"))).toBe(false);
      expect(runMtmd).not.toHaveBeenCalled();
      ready(scratch);
      expect(await run).toEqual({ text: "recognized" });
      expect(existsSync(scratch.path)).toBe(false);
    } finally {
      ready(scratch);
      await scratch.cleanup();
    }
  });

  test("refuses OCR when the private scratch boundary fails", async () => {
    vi.mocked(createPrivateScratchAsync).mockRejectedValueOnce(new Error("unsafe scratch"));
    const runMtmd = vi.fn(async () => "");
    await expect(
      new GgufOcr({ modelPath: "m", mmprojPath: "p", runMtmd }).recognize(enc("img"), "image/png"),
    ).rejects.toThrow("unsafe scratch");
    expect(runMtmd).not.toHaveBeenCalled();
  });

  test.each([new Error("synthetic cleanup failure"), undefined])(
    "preserves runner and cleanup failures together: %s",
    async (cleanupError) => {
      const core = await vi.importActual<typeof import("@omnesis/core")>("@omnesis/core");
      const scratch = await core.createPrivateScratchAsync("ocr-test");
      const runnerError = new Error("synthetic OCR failure");
      vi.mocked(createPrivateScratchAsync).mockResolvedValueOnce({
        ...scratch,
        cleanup: async () => {
          await scratch.cleanup();
          throw cleanupError;
        },
      });
      const ocr = new GgufOcr({
        modelPath: "m",
        mmprojPath: "p",
        runMtmd: async () => {
          throw runnerError;
        },
      });
      const error = await ocr
        .recognize(enc("img"), "image/png")
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([runnerError, cleanupError]);
      expect((error as AggregateError).cause).toBe(runnerError);
      expect(existsSync(scratch.path)).toBe(false);
    },
  );

  test("mtmdAvailable is true when a runner is injected (skips disk checks)", async () => {
    expect(await mtmdAvailable({ modelPath: "/nope", mmprojPath: "/nope" }, async () => "")).toBe(
      true,
    );
  });

  test("mtmdAvailable is false when model files are missing", async () => {
    expect(await mtmdAvailable({ modelPath: "/nope-model", mmprojPath: "/nope-mmproj" })).toBe(
      false,
    );
  });
});
