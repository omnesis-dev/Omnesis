// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { decodeVoicemailTranscript } from "./voicemail-transcript.js";

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function field(number: number, payload: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]);
}

function transcript(...captions: string[]): Buffer {
  return Buffer.concat(captions.map((text) => field(1, field(2, Buffer.from(text)))));
}

describe("decodeVoicemailTranscript", () => {
  test("decodes ordered caption text from Phone.app's protobuf", () => {
    const blob = transcript(
      "The project review moved to Tuesday.",
      "Please send the revised notes.",
    );
    expect(decodeVoicemailTranscript(blob)).toBe(
      "The project review moved to Tuesday. Please send the revised notes.",
    );
  });

  test("ignores unknown top-level and caption fields", () => {
    const caption = Buffer.concat([
      varint(4 * 8),
      varint(7),
      field(2, Buffer.from("Meet at the example workshop.")),
    ]);
    const blob = Buffer.concat([field(9, Buffer.from("unused")), field(1, caption)]);
    expect(decodeVoicemailTranscript(blob)).toBe("Meet at the example workshop.");
  });

  test("returns undefined for absent or text-free transcripts", () => {
    expect(decodeVoicemailTranscript(null)).toBeUndefined();
    expect(decodeVoicemailTranscript(field(1, field(3, Buffer.from("unused"))))).toBeUndefined();
  });

  test("rejects malformed length fields", () => {
    expect(() => decodeVoicemailTranscript(Buffer.from([0x0a, 0x80]))).toThrow(/varint/i);
    expect(() => decodeVoicemailTranscript(Buffer.from([0x0a, 0x05, 0x12]))).toThrow(/truncated/i);
  });
});
