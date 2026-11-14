// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, test, expect, vi } from "vitest";
import type { ProcessResult } from "../process-launcher/index.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../process-launcher/index.js", () => ({ processLauncher: () => ({ run }) }));

beforeEach(() => {
  run.mockReset();
});
import { TesseractOcr, tesseractAvailable } from "./tesseract-ocr.js";

const enc = (s: string) => new TextEncoder().encode(s);

function fakeModule(text = "recognized text") {
  return { recognize: vi.fn(async () => text) };
}

describe("TesseractOcr", () => {
  test("runs the installed binary with literal argv and unchanged binary stdin", async () => {
    const bytes = Uint8Array.from([0, 255, 13, 10, 128]);
    const signal = new AbortController().signal;
    run.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: enc("  printed text\n"),
      stderr: "",
    });
    const ocr = new TesseractOcr({ oem: 2, psm: 6, timeoutMs: 4321 });
    expect(await ocr.recognize(bytes, "image/png", { language: "fr", signal })).toEqual({
      text: "printed text",
      language: "fr",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "tesseract",
      ["stdin", "stdout", "-l", "fra", "--oem", "2", "--psm", "6"],
      { input: bytes, timeoutMs: 4321, signal },
    );
  });

  test.each(["en; injected command", "constructor", "__proto__", "toString"])(
    "unknown language hint %s cannot add executable arguments",
    async (language) => {
      run.mockResolvedValue({ exitCode: 0, signal: null, stdout: enc("ok"), stderr: "" });
      await new TesseractOcr().recognize(enc("img"), "image/png", {
        language,
      });
      expect(run.mock.calls[0]![1]).toEqual([
        "stdin",
        "stdout",
        "-l",
        "eng",
        "--oem",
        "1",
        "--psm",
        "3",
      ]);
      expect(run.mock.calls[0]![2].timeoutMs).toBe(120_000);
    },
  );

  test.each<[Partial<ProcessResult>, string]>([
    [{ failure: "timeout" }, "timed out"],
    [{ failure: "aborted" }, "caller stopped waiting"],
    [{ failure: "spawn", failureMessage: "private upstream detail" }, "failed to start"],
    [{ exitCode: 2 }, "exited 2"],
  ])(
    "reports failed execution without exposing input or engine stderr: %j",
    async (result, message) => {
      run.mockResolvedValue({
        exitCode: null,
        signal: null,
        stdout: enc("private upstream detail"),
        stderr: "private upstream detail",
        ...result,
      });
      const error = await new TesseractOcr()
        .recognize(enc("private image bytes"), "image/png")
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain("private upstream detail");
      expect((error as Error).message).not.toContain("private image bytes");
    },
  );

  test("binary availability needs no npm wrapper and refuses nonzero exits", async () => {
    run
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 1 })
      .mockResolvedValueOnce({ exitCode: 0, failure: "timeout" });
    expect(await tesseractAvailable()).toBe(true);
    expect(await tesseractAvailable()).toBe(false);
    expect(await tesseractAvailable()).toBe(false);
    expect(run).toHaveBeenNthCalledWith(1, "tesseract", ["--version"], {
      timeoutMs: 5000,
      captureStdout: false,
    });
  });

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
