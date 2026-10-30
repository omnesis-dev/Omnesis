// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { MAX_TRANSCRIPTION_MS } from "@omnesis/core";
import { MAX_CHUNK_SAMPLES, splitPcm, transcribeInChunks } from "./chunks.js";
import { MAX_CHUNK_TIMEOUT_MS } from "./deadline.js";

describe("splitPcm", () => {
  test("keeps a recording within the limit whole", () => {
    const pcm = new Float32Array(MAX_CHUNK_SAMPLES);
    expect(splitPcm(pcm)).toHaveLength(1);
  });

  test("splits at the quietest moment near each limit, losing no samples", () => {
    const pcm = new Float32Array(MAX_CHUNK_SAMPLES + 32_000).fill(0.5);
    const silenceAt = MAX_CHUNK_SAMPLES - 5 * 16_000;
    pcm.fill(0, silenceAt, silenceAt + 640);
    const chunks = splitPcm(pcm);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBeGreaterThanOrEqual(silenceAt);
    expect(chunks[0]!.length).toBeLessThanOrEqual(silenceAt + 640);
    expect(chunks[0]!.length + chunks[1]!.length).toBe(pcm.length);
  });
});

describe("transcribeInChunks", () => {
  test("joins each chunk's text and keeps the first language reported", async () => {
    const pcm = new Float32Array(MAX_CHUNK_SAMPLES * 2 + 16_000);
    let n = 0;
    const result = await transcribeInChunks(pcm, {}, () => {
      n += 1;
      return Promise.resolve(
        n === 2 ? { text: "" } : { text: `part ${n}`, language: n === 1 ? undefined : "fr" },
      );
    });
    expect(result).toEqual({ text: "part 1 part 3", language: "fr" });
  });

  test("raises every chunk's deadline to the caller's minimum", async () => {
    const pcm = new Float32Array(MAX_CHUNK_SAMPLES + 16_000 * 30);
    const timeouts: number[] = [];
    await transcribeInChunks(pcm, { minTimeoutMs: 25 * 60_000 }, (_chunk, timeoutMs) => {
      timeouts.push(timeoutMs);
      return Promise.resolve({ text: "" });
    });
    expect(timeouts).toEqual([MAX_CHUNK_TIMEOUT_MS, 25 * 60_000]);
  });

  test("holds a recording's chunks together within the overall ceiling", async () => {
    vi.useFakeTimers();
    try {
      const pcm = new Float32Array(MAX_CHUNK_SAMPLES * 2 + 16_000);
      const elapsedPerChunk = [MAX_TRANSCRIPTION_MS - 60_000, 60_000];
      const timeouts: number[] = [];
      const pending = transcribeInChunks(pcm, {}, (_chunk, timeoutMs) => {
        timeouts.push(timeoutMs);
        vi.advanceTimersByTime(elapsedPerChunk[timeouts.length - 1]!);
        return Promise.resolve({ text: "part" });
      });
      await expect(pending).rejects.toThrow(/ran out of time/);
      expect(timeouts).toEqual([MAX_CHUNK_TIMEOUT_MS, 60_000]);
    } finally {
      vi.useRealTimers();
    }
  });
});
