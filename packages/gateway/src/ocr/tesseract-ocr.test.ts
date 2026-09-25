// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { TesseractOcr, tesseractAvailable } from "./tesseract-ocr.js";

const enc = (s: string) => new TextEncoder().encode(s);

function fakeModule(text = "recognized text") {
  return { recognize: vi.fn(async () => text) };
}

describe("TesseractOcr", () => {
  test("recognizes text via the tesseract module", async () => {
    const mod = fakeModule("receipt total $42");
    const ocr = new TesseractOcr({ loadModule: async () => mod });
    expect((await ocr.recognize(enc("img"), "image/png")).text).toBe("receipt total $42");
    expect(mod.recognize).toHaveBeenCalledOnce();
  });

  test("maps an ISO-639-1 hint to a tesseract language code, defaulting to eng", async () => {
    const mod = fakeModule();
    const ocr = new TesseractOcr({ loadModule: async () => mod });
    await ocr.recognize(enc("i"), "image/png", { language: "fr" });
    expect(mod.recognize.mock.calls[0][1]).toMatchObject({ lang: "fra" });
    await ocr.recognize(enc("i"), "image/png");
    expect(mod.recognize.mock.calls[1][1]).toMatchObject({ lang: "eng" });
  });

  test("loads the module once across multiple recognitions", async () => {
    const loadModule = vi.fn(async () => fakeModule());
    const ocr = new TesseractOcr({ loadModule });
    await ocr.recognize(enc("a"), "image/png");
    await ocr.recognize(enc("b"), "image/png");
    expect(loadModule).toHaveBeenCalledOnce();
  });

  test("dispose drops the cached module", async () => {
    const ocr = new TesseractOcr({ loadModule: async () => fakeModule() });
    await ocr.recognize(enc("a"), "image/png");
    await expect(ocr.dispose()).resolves.toBeUndefined();
  });

  test("tesseractAvailable: true when an injected loader yields a module", async () => {
    expect(await tesseractAvailable(async () => fakeModule())).toBe(true);
  });

  test("tesseractAvailable: false when the module import throws", async () => {
    expect(
      await tesseractAvailable(async () => {
        throw new Error("not installed");
      }),
    ).toBe(false);
  });
});
