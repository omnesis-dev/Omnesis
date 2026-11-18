// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, writeFileSync, statSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectWindowsPrivatePaths } from "@omnesis/core";
import { describe, test, expect } from "vitest";
import { processLauncher, setProcessLauncher } from "../process-launcher/index.js";
import {
  sniffImageKind,
  isDecodableRasterImage,
  rasterizePdfToImages,
  transcodeHeicToPng,
} from "./image-prep.js";

test.each(["pdf", "heic"] as const)(
  "%s inputs stay private and survive unconfirmed process cleanup",
  async (kind) => {
    const previous = processLauncher();
    const cleanupFailure = new Error("Synthetic process join unconfirmed");
    let input = "";
    setProcessLauncher({
      run: async (_command, args) => {
        input = kind === "pdf" ? args.at(-2)! : args[0]!;
        expect(existsSync(join(dirname(input), ".process-join-required"))).toBe(true);
        expect(readFileSync(input, "utf8")).toBe("invented document bytes");
        if (process.platform === "win32") {
          const states = await inspectWindowsPrivatePaths(
            [
              { path: input, kind: "file" },
              { path: dirname(input), kind: "directory" },
            ],
            { protect: false },
          );
          expect(states.every((state) => state.private)).toBe(true);
        } else {
          expect(statSync(dirname(input)).mode & 0o777).toBe(0o700);
          expect(statSync(input).mode & 0o777).toBe(0o600);
        }
        return { exitCode: 0, signal: null, stdout: new Uint8Array(), stderr: "", cleanupFailure };
      },
    });
    try {
      const operation = kind === "pdf" ? rasterizePdfToImages : transcodeHeicToPng;
      await expect(
        operation(new TextEncoder().encode("invented document bytes")),
      ).rejects.toMatchObject({ cleanupFailure });
      expect(readFileSync(input, "utf8")).toBe("invented document bytes");
    } finally {
      setProcessLauncher(previous);
      if (input) rmSync(dirname(input), { recursive: true, force: true });
    }
  },
);

test.each(["pdf", "heic"] as const)(
  "%s conversion still returns output and removes joined scratch",
  async (kind) => {
    const previous = processLauncher();
    let input = "";
    setProcessLauncher({
      run: (_command, args) => {
        input = kind === "pdf" ? args.at(-2)! : args[0]!;
        writeFileSync(kind === "pdf" ? `${args.at(-1)}-1.png` : args[1]!, "invented image output");
        return Promise.resolve({ exitCode: 0, signal: null, stdout: new Uint8Array(), stderr: "" });
      },
    });
    try {
      const output =
        kind === "pdf"
          ? (await rasterizePdfToImages(new Uint8Array([1])))?.[0]
          : await transcodeHeicToPng(new Uint8Array([1]));
      expect(Buffer.from(output!).toString()).toBe("invented image output");
      expect(existsSync(dirname(input))).toBe(false);
    } finally {
      setProcessLauncher(previous);
      if (input) rmSync(dirname(input), { recursive: true, force: true });
    }
  },
);

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)),
  );

// Trailing zero bytes pad each fixture past the sniffer's 12-byte minimum.
const pad = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

describe("sniffImageKind", () => {
  test("identifies decodable raster formats by magic bytes", () => {
    expect(sniffImageKind(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad))).toBe(
      "png",
    );
    expect(sniffImageKind(bytes([0xff, 0xd8, 0xff, 0xe0], pad))).toBe("jpeg");
    expect(sniffImageKind(bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], pad))).toBe("gif");
    expect(sniffImageKind(bytes([0x42, 0x4d], pad))).toBe("bmp");
    expect(
      sniffImageKind(bytes([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("webp");
    expect(sniffImageKind(bytes([0x49, 0x49, 0x2a, 0x00], pad))).toBe("tiff");
    expect(sniffImageKind(bytes([0x4d, 0x4d, 0x00, 0x2a], pad))).toBe("tiff");
  });

  test("identifies HEIC via the ftyp brand", () => {
    // size(4) + 'ftyp' + 'heic'
    expect(sniffImageKind(bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]))).toBe("heic");
    expect(sniffImageKind(bytes([0, 0, 0, 0x18], "ftypmif1", [0, 0, 0, 0]))).toBe("heic");
  });

  test("identifies SVG (the OneDrive culprit) as a non-raster", () => {
    expect(sniffImageKind(bytes('<?xml version="1.0"?><svg></svg>'))).toBe("svg");
    expect(sniffImageKind(bytes("<svg xmlns='...'></svg>   "))).toBe("svg");
    expect(sniffImageKind(bytes("   \n  <svg/>"))).toBe("svg");
  });

  test("returns unknown for undersized or unrecognized bytes", () => {
    expect(sniffImageKind(bytes("tiny"))).toBe("unknown");
    expect(sniffImageKind(bytes("not an image at all really"))).toBe("unknown");
  });

  test("isDecodableRasterImage admits rasters, rejects svg/heic/unknown", () => {
    expect(
      isDecodableRasterImage(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad)),
    ).toBe(true);
    expect(isDecodableRasterImage(bytes("<?xml?><svg></svg>"))).toBe(false);
    expect(isDecodableRasterImage(bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]))).toBe(false);
    expect(isDecodableRasterImage(bytes("garbage bytes here"))).toBe(false);
  });
});
