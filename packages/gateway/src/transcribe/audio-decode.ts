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
 * Most containers decode from stdin. An MP4-family file (m4a, mp4, mov, 3gp)
 * may keep its sample index (`moov`) after the audio it describes, which is
 * how ffmpeg's own muxer and most phone recorders write it; ffmpeg cannot
 * seek back to the audio on a pipe and ends cleanly with no samples. Those
 * files are decoded from a short-lived copy in an owner-only temporary
 * folder instead. A CAF file's trailing packet table is moved in memory (see
 * `caf-stream.ts`), so CAF stays on stdin.
 *
 * ffmpeg-static is an optional dependency: it's imported through a
 * non-literal specifier so a build that didn't install it still type-checks
 * and runs (transcription just reports unavailable). See `whisper-transcriber.ts`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@omnesis/core";
import { processLauncher } from "../process-launcher/index.js";
import { streamableCaf } from "./caf-stream.js";

const log = createLogger("gateway:transcribe");

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
 * Box types that can open an ISO base media file: `ftyp` for MP4, M4A and
 * 3GP, and the atoms a QuickTime file without one starts with.
 */
const ISO_BMFF_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);

/**
 * Whether ffmpeg needs to seek in `bytes` to decode them: an ISO base media
 * file, whose first box type sits at offset 4. ffmpeg decodes any container
 * from a file, so a false match only costs a temporary copy.
 */
export function needsSeekableInput(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  return ISO_BMFF_FIRST_BOXES.has(type);
}

/**
 * Decode `bytes` to a mono 16 kHz float32 PCM buffer via ffmpeg.
 *
 * `ffmpegPath` is injectable for tests; when omitted it resolves the
 * ffmpeg-static binary. `tempDir` is where the private folder for a seekable
 * copy is made (the system temporary directory by default); the folder is
 * removed however decoding ends. Throws `AudioDecodeError` when ffmpeg is
 * missing, exits non-zero, or produces no samples; the error is `unreadable`
 * when the input is at fault (see {@link AudioDecodeError.unreadable}).
 */
export async function decodeToPcm16kMono(
  bytes: Uint8Array,
  opts: { ffmpegPath?: string; timeoutMs?: number; tempDir?: string } = {},
): Promise<Float32Array> {
  const ffmpegPath = opts.ffmpegPath ?? (await resolveFfmpegPath());
  if (!ffmpegPath) {
    throw new AudioDecodeError("ffmpeg-static is not installed");
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  if (!needsSeekableInput(bytes)) {
    return runFfmpeg(ffmpegPath, ["-i", "pipe:0"], { input: streamableCaf(bytes), timeoutMs });
  }

  let dir: string;
  try {
    // mkdtemp makes the folder owner-only (0700); the copy is 0600 within it.
    dir = await mkdtemp(join(opts.tempDir ?? tmpdir(), "omnesis-audio-"));
  } catch (err) {
    throw new AudioDecodeError(
      `could not create a temporary folder for decoding: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const path = join(dir, "input");
    try {
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    } catch (err) {
      throw new AudioDecodeError(
        `could not write the audio for decoding: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // `file:` keeps ffmpeg from reading a protocol into the path; -nostdin
    // keeps it off the stdin it is not reading from.
    return await runFfmpeg(ffmpegPath, ["-nostdin", "-i", `file:${path}`], { timeoutMs });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn(
        `Could not remove the temporary audio folder ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

/** Run ffmpeg on the input that `inputArgs` names and parse its PCM output. */
async function runFfmpeg(
  ffmpegPath: string,
  inputArgs: string[],
  opts: { input?: Uint8Array; timeoutMs: number },
): Promise<Float32Array> {
  const { timeoutMs } = opts;
  const run = await processLauncher().run(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputArgs,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      String(PCM_SAMPLE_RATE),
      "pipe:1",
    ],
    { ...(opts.input ? { input: opts.input } : {}), timeoutMs },
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
