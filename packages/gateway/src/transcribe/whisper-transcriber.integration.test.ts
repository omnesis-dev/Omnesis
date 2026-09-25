// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Real-Whisper integration test for `WhisperTranscriber` — drives the actual
 * worker subprocess (which loads the smart-whisper native binding) + the
 * in-process ffmpeg decode against a real model file and audio clip, asserting
 * the produced transcript. It is SKIPPED unless pointed at a model/audio via
 * env, so CI (which has neither the heavy native deps nor the model) stays
 * green while the real path is still exercisable locally:
 *
 *   OMNESIS_WHISPER_TEST_MODEL=/path/ggml-tiny.bin \
 *   OMNESIS_WHISPER_TEST_AUDIO=/path/jfk.wav \
 *   OMNESIS_WHISPER_TEST_FFMPEG=/abs/node_modules/ffmpeg-static/ffmpeg \
 *   npx vitest run packages/gateway/src/transcribe/whisper-transcriber.integration.test.ts
 *
 * The worker subprocess imports `smart-whisper` from this package's
 * node_modules; install the optional dep there to run the real path. The
 * FFMPEG override is only needed when ffmpeg-static isn't installed here.
 */

import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import { WhisperTranscriber } from "./whisper-transcriber.js";
import { decodeToPcm16kMono } from "./audio-decode.js";

const MODEL = process.env.OMNESIS_WHISPER_TEST_MODEL;
const AUDIO = process.env.OMNESIS_WHISPER_TEST_AUDIO;
const FFMPEG = process.env.OMNESIS_WHISPER_TEST_FFMPEG;
const RUN = !!MODEL && !!AUDIO;

(RUN ? describe : describe.skip)("WhisperTranscriber (real model, real subprocess)", () => {
  test("transcribes a real audio clip end-to-end via the worker subprocess", async () => {
    const t = new WhisperTranscriber({
      modelPath: MODEL!,
      modelId: "whisper-test",
      gpu: false,
      decodeAudio: FFMPEG
        ? (bytes) => decodeToPcm16kMono(bytes, { ffmpegPath: FFMPEG })
        : undefined,
    });
    const result = await t.transcribe(readFileSync(AUDIO!), "audio/wav");
    await t.dispose();

    // Non-empty transcript with real words — exact text varies by model size.
    expect(result.text.length).toBeGreaterThan(10);
    expect(result.text).toMatch(/[a-z]{3,}/i);
    expect(result.durationSec).toBeGreaterThan(0);
  }, 120_000);
});
