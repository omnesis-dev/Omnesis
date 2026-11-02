// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { decodeToPcm16kMono, AudioDecodeError, resolveFfmpegPath } from "./audio-decode.js";
import { streamableCaf } from "./caf-stream.js";

// A stub "ffmpeg" is a tiny executable script (shebanged to this Node binary,
// so it doesn't depend on `node` being on PATH) that ignores its args/stdin and
// emits a scripted result — letting us exercise the spawn + PCM-parse path
// without ffmpeg-static installed.
let dir: string;
function makeStub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-decode-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("decodeToPcm16kMono", () => {
  test("parses ffmpeg's little-endian float32 stdout into a Float32Array", async () => {
    const ffmpeg = makeStub(
      "ok-ffmpeg",
      `const b = Buffer.alloc(8); b.writeFloatLE(0.5, 0); b.writeFloatLE(-0.25, 4); process.stdout.write(b, () => process.exit(0));`,
    );
    const pcm = await decodeToPcm16kMono(new Uint8Array([1, 2, 3]), { ffmpegPath: ffmpeg });
    expect(Array.from(pcm)).toEqual([0.5, -0.25]);
  });

  test("an exit naming the input as invalid data is unreadable audio", async () => {
    const ffmpeg = makeStub(
      "invalid-ffmpeg",
      `process.stderr.write("Error opening input files: Invalid data found when processing input"); process.exit(183);`,
    );
    const err = await decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AudioDecodeError);
    expect((err as AudioDecodeError).unreadable).toBe(true);
  });

  test("an input with no stream to decode is unreadable audio", async () => {
    const ffmpeg = makeStub(
      "no-stream-ffmpeg",
      `process.stderr.write("Output file does not contain any stream"); process.exit(234);`,
    );
    await expect(
      decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg }),
    ).rejects.toMatchObject({ unreadable: true });
  });

  test("any other non-zero exit is the decoder's failure, not the audio's", async () => {
    const ffmpeg = makeStub(
      "fail-ffmpeg",
      `process.stderr.write("Cannot allocate memory"); process.exit(1);`,
    );
    const err = await decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AudioDecodeError);
    expect((err as AudioDecodeError).unreadable).toBe(false);
  });

  test("a killed decoder is not unreadable audio, whatever it printed", async () => {
    const ffmpeg = makeStub(
      "killed-ffmpeg",
      `process.stderr.write("Invalid data found when processing input", () => process.kill(process.pid, "SIGKILL"));`,
    );
    await expect(
      decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg }),
    ).rejects.toMatchObject({ unreadable: false });
  });

  test("no samples from a clean exit is unreadable audio", async () => {
    const ffmpeg = makeStub("empty-ffmpeg", `process.exit(0);`);
    const err = await decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AudioDecodeError);
    expect((err as AudioDecodeError).message).toMatch(/no audio samples/);
    expect((err as AudioDecodeError).unreadable).toBe(true);
  });

  test("a timed-out decoder is not unreadable audio", async () => {
    const ffmpeg = makeStub("slow-ffmpeg", `setTimeout(() => process.exit(0), 10_000);`);
    await expect(
      decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg, timeoutMs: 100 }),
    ).rejects.toMatchObject({ unreadable: false, message: expect.stringMatching(/timed out/) });
  });

  test("a missing ffmpeg binary is not unreadable audio", async () => {
    await expect(
      decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: join(dir, "does-not-exist") }),
    ).rejects.toMatchObject({ name: "AudioDecodeError", unreadable: false });
  });
});

// Real ffmpeg on bytes that are not audio, so the matched messages track the
// bundled binary's wording.
test("real ffmpeg reports random bytes as unreadable audio", async (context) => {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return context.skip();
  const bytes = new Uint8Array(2048).map((_, i) => (i * 7919) % 251);
  await expect(decodeToPcm16kMono(bytes, { ffmpegPath })).rejects.toMatchObject({
    unreadable: true,
  });
});

// A synthetic tone exercises the real demuxer without retaining anyone's audio.
test("decodes CAF with a trailing packet table through stdin", async (context) => {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return context.skip();
  const path = join(dir, "tone.caf");
  const generated = spawnSync(
    ffmpegPath,
    ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "alac", path],
    { timeout: 10_000 },
  );
  expect(generated.status, generated.stderr?.toString()).toBe(0);
  const bytes = readFileSync(path);
  expect(streamableCaf(bytes)).not.toEqual(bytes);
  const pcm = await decodeToPcm16kMono(bytes, { ffmpegPath });
  expect(pcm.length).toBeGreaterThan(1000);
  expect(pcm.some((sample) => Math.abs(sample) > 0.01)).toBe(true);
});
