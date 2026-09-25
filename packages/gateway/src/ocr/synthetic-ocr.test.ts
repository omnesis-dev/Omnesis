// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { SyntheticOcr } from "./synthetic-ocr.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("SyntheticOcr", () => {
  test("decodes image bytes as UTF-8 text", async () => {
    const ocr = new SyntheticOcr();
    const result = await ocr.recognize(enc("Q3 goals\n- ship it"), "image/png");
    expect(result.text).toBe("Q3 goals\n- ship it");
    expect(ocr.modelId).toBe("replay");
  });

  test("trims surrounding whitespace", async () => {
    const ocr = new SyntheticOcr();
    expect((await ocr.recognize(enc("  receipt total  "), "image/jpeg")).text).toBe(
      "receipt total",
    );
  });

  test("echoes the language hint, defaulting to English", async () => {
    const ocr = new SyntheticOcr();
    expect((await ocr.recognize(enc("x"), "image/png")).language).toBe("en");
    expect((await ocr.recognize(enc("x"), "image/png", { language: "fr" })).language).toBe("fr");
  });

  test("empty bytes → empty text", async () => {
    const ocr = new SyntheticOcr();
    expect((await ocr.recognize(new Uint8Array(0), "image/png")).text).toBe("");
  });

  test("dispose is a no-op", async () => {
    await expect(new SyntheticOcr().dispose()).resolves.toBeUndefined();
  });
});
