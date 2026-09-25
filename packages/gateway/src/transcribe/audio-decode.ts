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

import { spawn } from "node:child_process";

const FFMPEG_STATIC_SPECIFIER = "ffmpeg-static";

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
  constructor(message: string) {
    super(message);
    this.name = "AudioDecodeError";
  }
}

/**
 * Decode `bytes` to a mono 16 kHz float32 PCM buffer via ffmpeg.
 *
 * `ffmpegPath` is injectable for tests; when omitted it resolves the
 * ffmpeg-static binary. Throws `AudioDecodeError` when ffmpeg is missing,
 * exits non-zero, or produces no samples.
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

  return new Promise<Float32Array>((resolve, reject) => {
    const ff = spawn(
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
        "16000",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const out: Buffer[] = [];
    let errText = "";
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const timer = setTimeout(() => {
      ff.kill("SIGKILL");
      fail(new AudioDecodeError(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.stderr.on("data", (c: Buffer) => {
      errText += c.toString();
    });
    ff.on("error", (err) => {
      clearTimeout(timer);
      fail(new AudioDecodeError(`ffmpeg failed to start: ${err.message}`));
    });
    ff.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        fail(new AudioDecodeError(`ffmpeg exited ${code}: ${errText.trim().slice(0, 500)}`));
        return;
      }
      const buf = Buffer.concat(out);
      if (buf.byteLength < 4) {
        fail(new AudioDecodeError("ffmpeg produced no audio samples"));
        return;
      }
      // ffmpeg's stdout is a stream of little-endian float32 samples. Copy into
      // an aligned ArrayBuffer so the Float32Array view is valid regardless of
      // how Buffer.concat aligned the underlying bytes.
      const aligned = new ArrayBuffer(buf.byteLength - (buf.byteLength % 4));
      Buffer.from(buf.buffer, buf.byteOffset, aligned.byteLength).copy(Buffer.from(aligned));
      settled = true;
      resolve(new Float32Array(aligned));
    });

    ff.stdin.on("error", () => {
      /* EPIPE if ffmpeg rejects the input before we finish writing — the
         non-zero exit is reported by the close handler. */
    });
    ff.stdin.end(Buffer.from(bytes));
  });
}
