// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";

describe("whisper-worker-protocol framing", () => {
  test("round-trips a request frame with its PCM tail", () => {
    const pcm = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    const header: WhisperRequestHeader = {
      type: "request",
      id: 7,
      pcmBytes: pcm.byteLength,
      language: "fr",
    };
    const frame = encodeFrame(header, pcm);

    const seen: { header: WhisperRequestHeader; pcm: Float32Array }[] = [];
    const decoder = new FrameDecoder((h, tail) => {
      const aligned = new ArrayBuffer(tail.byteLength);
      Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength).copy(Buffer.from(aligned));
      seen.push({ header: h as WhisperRequestHeader, pcm: new Float32Array(aligned) });
    });
    decoder.push(frame);

    expect(seen).toHaveLength(1);
    expect(seen[0].header).toEqual(header);
    expect(Array.from(seen[0].pcm)).toEqual(Array.from(pcm));
  });

  test("a header-only frame (no tail) decodes with an empty tail", () => {
    const msg: WhisperWorkerMessage = { type: "result", id: 3, text: "hi", durationSec: 1 };
    const frame = encodeFrame(msg);
    const seen: unknown[] = [];
    const decoder = new FrameDecoder((h, tail) => {
      expect(tail.byteLength).toBe(0);
      seen.push(h);
    });
    decoder.push(frame);
    expect(seen).toEqual([msg]);
  });

  test("reassembles frames split across arbitrary chunk boundaries", () => {
    const pcm = new Float32Array([1, 2, 3, 4, 5, 6]);
    const frame = encodeFrame(
      { type: "request", id: 1, pcmBytes: pcm.byteLength, language: "auto" },
      pcm,
    );
    const seen: number[] = [];
    const decoder = new FrameDecoder(() => seen.push(1));
    // Feed one byte at a time — the decoder must buffer until each frame is whole.
    for (const byte of frame) decoder.push(Buffer.from([byte]));
    expect(seen).toEqual([1]);
  });

  test("decodes multiple frames concatenated in one chunk", () => {
    const a = encodeFrame({ type: "result", id: 1, text: "a" });
    const b = encodeFrame({ type: "result", id: 2, text: "b" });
    const ids: number[] = [];
    const decoder = new FrameDecoder((h) => ids.push((h as { id: number }).id));
    decoder.push(Buffer.concat([a, b]));
    expect(ids).toEqual([1, 2]);
  });
});
