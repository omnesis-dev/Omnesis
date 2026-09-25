// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { describe, test, expect, vi } from "vitest";
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
  });

  test("surfaces the model filename as the modelId", () => {
    const ocr = new GgufOcr({
      modelPath: "/models/dots.ocr.Q8_0.gguf",
      mmprojPath: "/m.gguf",
      runMtmd: async () => "",
    });
    expect(ocr.modelId).toBe("dots.ocr.Q8_0.gguf");
  });

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
