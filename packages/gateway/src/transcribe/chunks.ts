// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A long recording is transcribed a chunk at a time, whichever engine runs
 * it: ten minutes for Whisper and the transcription API, about a minute for an
 * audio language model. Each chunk gets its own deadline sized from its own
 * duration (`deadline.ts`), so the time a recording may take grows with its
 * length and a slow host still finishes a long one, while a chunk that hangs
 * is given up within its own budget. All chunks together stay within
 * `MAX_TRANSCRIPTION_MS`, the bound a client waiting on the gateway relies on.
 */

import { MAX_TRANSCRIPTION_MS } from "@omnesis/core";
import { PCM_SAMPLE_RATE } from "./audio-decode.js";
import { computeTranscriptionTimeoutMs } from "./deadline.js";

/**
 * Longest audio in one request. Ten minutes of 16 kHz 16-bit WAV is 19.2 MB,
 * under the 25 MB upload limit OpenAI and vLLM apply.
 */
export const MAX_CHUNK_SAMPLES = 600 * PCM_SAMPLE_RATE;

/** Samples per request for a chunk length in seconds, the ten-minute limit when unset. */
export function chunkSamples(maxChunkSeconds: number | undefined): number {
  if (maxChunkSeconds === undefined || !(maxChunkSeconds > 0)) return MAX_CHUNK_SAMPLES;
  return Math.min(MAX_CHUNK_SAMPLES, Math.round(maxChunkSeconds * PCM_SAMPLE_RATE));
}
/** How far back from a chunk's limit to look for a quiet place to split. */
const SPLIT_SEARCH_SAMPLES = 10 * PCM_SAMPLE_RATE;
/** 20 ms frames: short enough to land in the gap between two words. */
const SPLIT_FRAME_SAMPLES = 320;

/**
 * Split PCM into chunks of at most `maxSamples`, each ending at the quietest
 * 20 ms frame in its last ten seconds so a split rarely cuts a word.
 */
export function splitPcm(
  pcm: Float32Array,
  maxSamples: number = MAX_CHUNK_SAMPLES,
): Float32Array[] {
  const chunks: Float32Array[] = [];
  let start = 0;
  while (pcm.length - start > maxSamples) {
    const limit = start + maxSamples;
    let split = limit;
    let quietest = Infinity;
    // Look for the quiet moment in the last ten seconds of the chunk, or its
    // second half when the window is shorter than that, so a short window
    // never splits at its own start. The latest quietest frame wins a tie,
    // which keeps chunks close to the window over steady audio.
    const search = Math.min(SPLIT_SEARCH_SAMPLES, Math.floor(maxSamples / 2));
    for (
      let frame = limit - search;
      frame + SPLIT_FRAME_SAMPLES <= limit;
      frame += SPLIT_FRAME_SAMPLES
    ) {
      let energy = 0;
      for (let i = frame; i < frame + SPLIT_FRAME_SAMPLES; i += 1) energy += pcm[i]! * pcm[i]!;
      if (energy <= quietest) {
        quietest = energy;
        split = frame + SPLIT_FRAME_SAMPLES / 2;
      }
    }
    chunks.push(pcm.subarray(start, split));
    start = split;
  }
  chunks.push(pcm.subarray(start));
  return chunks;
}

/** What one chunk's transcription yields. */
export interface ChunkTranscript {
  text: string;
  language?: string;
}

/**
 * Transcribe `pcm` chunk by chunk, in order, handing each chunk its deadline
 * (ms) — `minTimeoutMs` raises it — and joining the text. The first language a
 * chunk reports stands for the recording.
 */
export async function transcribeInChunks(
  pcm: Float32Array,
  opts: { maxChunkSamples?: number; minTimeoutMs?: number },
  transcribeChunk: (chunk: Float32Array, timeoutMs: number) => Promise<ChunkTranscript>,
): Promise<ChunkTranscript> {
  const giveUpAt = Date.now() + MAX_TRANSCRIPTION_MS;
  const texts: string[] = [];
  let language: string | undefined;
  for (const chunk of splitPcm(pcm, opts.maxChunkSamples)) {
    const timeoutMs = Math.min(
      computeTranscriptionTimeoutMs(chunk.length / PCM_SAMPLE_RATE, opts.minTimeoutMs),
      giveUpAt - Date.now(),
    );
    if (timeoutMs <= 0) {
      throw new Error(`Transcription ran out of time after ${MAX_TRANSCRIPTION_MS}ms`);
    }
    const part = await transcribeChunk(chunk, timeoutMs);
    if (part.text) texts.push(part.text);
    language ??= part.language;
  }
  return { text: texts.join(" "), ...(language ? { language } : {}) };
}
