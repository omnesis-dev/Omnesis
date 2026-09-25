// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { parseAttributedBody } from "./imessage-attributed-body.js";

/**
 * Build a minimal typedstream-style blob with the NSString marker and a text payload.
 */
function buildBlob(text: string): Buffer {
  const prefix = Buffer.from([
    0x04,
    0x0b, // typedstream header bytes
    ...Buffer.from("streamtype"),
  ]);
  const nsString = Buffer.from("NSString");
  const classMarker = Buffer.from([0x01, 0x94, 0x84, 0x01]); // typical bytes before 0x2b
  const textBuf = Buffer.from(text, "utf-8");

  let lengthBytes: Buffer;
  if (textBuf.length < 0x80) {
    lengthBytes = Buffer.from([textBuf.length]);
  } else {
    // 0x81 + 2-byte big-endian length
    lengthBytes = Buffer.from([0x81, (textBuf.length >> 8) & 0xff, textBuf.length & 0xff]);
  }

  const marker = Buffer.from([0x2b]);
  const suffix = Buffer.from([0x86, 0x84, 0x02]); // trailing bytes (attributes etc.)

  return Buffer.concat([prefix, nsString, classMarker, marker, lengthBytes, textBuf, suffix]);
}

describe("parseAttributedBody", () => {
  test("returns null for empty buffer", () => {
    expect(parseAttributedBody(Buffer.alloc(0))).toBeNull();
  });

  test("returns null for buffer without NSString marker", () => {
    expect(parseAttributedBody(Buffer.from("no marker here"))).toBeNull();
  });

  test("extracts short text (single-byte length)", () => {
    const blob = buildBlob("Hello world");
    expect(parseAttributedBody(blob)).toBe("Hello world");
  });

  test("extracts text with unicode characters", () => {
    const blob = buildBlob("C'est fait 😀");
    expect(parseAttributedBody(blob)).toBe("C'est fait 😀");
  });

  test("extracts long text (2-byte length)", () => {
    const longText = "A".repeat(200);
    const blob = buildBlob(longText);
    expect(parseAttributedBody(blob)).toBe(longText);
  });

  test("extracts text > 256 bytes", () => {
    const longText = "B".repeat(500);
    const blob = buildBlob(longText);
    expect(parseAttributedBody(blob)).toBe(longText);
  });

  test("returns null for truncated blob", () => {
    const blob = buildBlob("Hello");
    // Truncate the blob before the text ends
    expect(parseAttributedBody(blob.subarray(0, 20))).toBeNull();
  });

  test("returns null for null-like input", () => {
    expect(parseAttributedBody(null as unknown as Buffer)).toBeNull();
  });

  test("trims whitespace from extracted text", () => {
    const blob = buildBlob("  spaced out  ");
    expect(parseAttributedBody(blob)).toBe("spaced out");
  });

  test("returns null for whitespace-only text", () => {
    const blob = buildBlob("   ");
    expect(parseAttributedBody(blob)).toBeNull();
  });
});
