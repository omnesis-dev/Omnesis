// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Decode arbitrary audio bytes to the 16 kHz mono float32 PCM that
 * whisper.cpp expects, using the bundled ffmpeg-static binary.
 *
 * ffmpeg is codec-agnostic — WhatsApp's `audio/ogg; codecs=opus`, iOS m4a,
 * mp3, wav all decode through the same path — so the transcriber never has
 * to care what container the source used. ffmpeg-static ships prebuilt
 * binaries (incl. linux-arm64 / darwin-arm64), so there's nothing to compile.
 *
 * ffmpeg-static is an optional dependency: it's imported through a
 * non-literal specifier so a build that didn't install it still type-checks
 * and runs (transcription just reports unavailable). See `whisper-transcriber.ts`.
 */

import { processLauncher } from "../process-launcher/index.js";
import { streamableCaf } from "./caf-stream.js";

const FFMPEG_STATIC_SPECIFIER = "ffmpeg-static";

/** Sample rate of the decoded PCM; samples ÷ rate = seconds. */
export const PCM_SAMPLE_RATE = 16_000;

/** Decode audio bytes to 16 kHz mono float PCM. Injectable so tests skip ffmpeg. */
export type AudioDecoder = (bytes: Uint8Array, mimeType: string) => Promise<Float32Array>;

/** Resolve the bundled ffmpeg binary path, or null if ffmpeg-static is absent. */
export async function resolveFfmpegPath(): Promise<string | null> {
  try {
    const mod = (await import(FFMPEG_STATIC_SPECIFIER)) as { default?: string } | string;
    const path = typeof mod === "string" ? mod : mod.default;
    return path && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export class AudioDecodeError extends Error {
  /**
   * Whether the bytes themselves are not decodable audio, so decoding them
   * again gives the same answer. False for a failure of the decoder rather
   * than of its input: ffmpeg missing, failing to start, timing out or being
   * killed, or exiting with an error that does not name the input as invalid.
   */
  readonly unreadable: boolean;

  constructor(message: string, opts: { unreadable?: boolean } = {}) {
    super(message);
    this.name = "AudioDecodeError";
    this.unreadable = opts.unreadable ?? false;
  }
}

/** Whether `error` says the recording's bytes, not the decoder, are at fault. */
export function isUnreadableAudio(error: unknown): boolean {
  return error instanceof AudioDecodeError && error.unreadable;
}

/**
 * ffmpeg's messages for an input that holds no decodable audio: the demuxer
 * rejected the bytes, or found no stream to decode in them. Any other non-zero
 * exit is read as the decoder's own failure, so it is retried.
 */
const UNREADABLE_INPUT_MESSAGES = [
  "Invalid data found when processing input",
  "does not contain any stream",
];

/**
 * Decode `bytes` to a mono 16 kHz float32 PCM buffer via ffmpeg.
 *
 * `ffmpegPath` is injectable for tests; when omitted it resolves the
 * ffmpeg-static binary. Throws `AudioDecodeError` when ffmpeg is missing,
 * exits non-zero, or produces no samples; the error is `unreadable` when the
 * input is at fault (see {@link AudioDecodeError.unreadable}).
 */
export async function decodeToPcm16kMono(
  bytes: Uint8Array,
  opts: { ffmpegPath?: string; timeoutMs?: number } = {},
): Promise<Float32Array> {
  const ffmpegPath = opts.ffmpegPath ?? (await resolveFfmpegPath());
  if (!ffmpegPath) {
    throw new AudioDecodeError("ffmpeg-static is not installed");
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const run = await processLauncher().run(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      String(PCM_SAMPLE_RATE),
      "pipe:1",
    ],
    { input: streamableCaf(bytes), timeoutMs },
  );
  if (run.failure === "timeout")
    throw new AudioDecodeError(`ffmpeg timed out after ${timeoutMs}ms`);
  if (run.failure)
    throw new AudioDecodeError(`ffmpeg failed to start: ${run.failureMessage ?? run.failure}`);
  if (run.exitCode !== 0) {
    // A null code is a signal (the process was killed), whatever it printed.
    const unreadable =
      run.exitCode !== null && UNREADABLE_INPUT_MESSAGES.some((m) => run.stderr.includes(m));
    throw new AudioDecodeError(
      `ffmpeg exited ${run.exitCode}: ${run.stderr.trim().slice(0, 500)}`,
      { unreadable },
    );
  }
  const buf = run.stdout;
  if (buf.byteLength < 4) {
    throw new AudioDecodeError("ffmpeg produced no audio samples", { unreadable: true });
  }
  // ffmpeg's stdout is a stream of little-endian float32 samples. Copy into an
  // aligned ArrayBuffer so the Float32Array view is valid whatever the
  // alignment of the bytes it arrived in.
  const aligned = new ArrayBuffer(buf.byteLength - (buf.byteLength % 4));
  new Uint8Array(aligned).set(buf.subarray(0, aligned.byteLength));
  return new Float32Array(aligned);
}
