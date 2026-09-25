// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { describe, test, expect, vi } from "vitest";
import { AppleVisionOcr, appleVisionAvailable } from "./apple-vision-ocr.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("AppleVisionOcr", () => {
  test("spills the image to a temp file and runs the Vision helper", async () => {
    let seenPath = "";
    let existedDuringRun = false;
    const runHelper = vi.fn(async (imagePath: string) => {
      seenPath = imagePath;
      existedDuringRun = existsSync(imagePath);
      return "Whiteboard notes\nQ3 launch";
    });
    const ocr = new AppleVisionOcr({ runHelper });
    const result = await ocr.recognize(enc("HEICDATA"), "image/heic", { language: "en" });

    expect(result.text).toBe("Whiteboard notes\nQ3 launch");
    expect(result.language).toBe("en");
    expect(runHelper).toHaveBeenCalledOnce();
    expect(existedDuringRun).toBe(true);
    expect(existsSync(seenPath)).toBe(false); // cleaned up afterwards
  });

  test("forwards the language hint to the helper", async () => {
    const runHelper = vi.fn(async () => "x");
    const ocr = new AppleVisionOcr({ runHelper });
    await ocr.recognize(enc("i"), "image/png", { language: "fr" });
    expect(runHelper.mock.calls[0][1]).toMatchObject({ language: "fr" });
  });

  test("appleVisionAvailable is true when a runner is injected", async () => {
    expect(await appleVisionAvailable(async () => "x")).toBe(true);
  });

  test("appleVisionAvailable is false off macOS (no injected runner)", async () => {
    if (process.platform === "darwin") return; // can't assert the negative on a Mac
    expect(await appleVisionAvailable()).toBe(false);
  });
});
