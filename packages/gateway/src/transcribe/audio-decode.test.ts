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

  test("throws AudioDecodeError on a non-zero ffmpeg exit (with stderr)", async () => {
    const ffmpeg = makeStub(
      "fail-ffmpeg",
      `process.stderr.write("Invalid data found"); process.exit(1);`,
    );
    await expect(decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg })).rejects.toThrow(
      AudioDecodeError,
    );
  });

  test("throws AudioDecodeError when ffmpeg produces no samples", async () => {
    const ffmpeg = makeStub("empty-ffmpeg", `process.exit(0);`);
    await expect(decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: ffmpeg })).rejects.toThrow(
      /no audio samples/,
    );
  });

  test("throws AudioDecodeError when the ffmpeg binary is missing", async () => {
    await expect(
      decodeToPcm16kMono(new Uint8Array([1]), { ffmpegPath: join(dir, "does-not-exist") }),
    ).rejects.toThrow(AudioDecodeError);
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
