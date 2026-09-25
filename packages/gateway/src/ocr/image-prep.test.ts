// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { sniffImageKind, isDecodableRasterImage } from "./image-prep.js";

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
