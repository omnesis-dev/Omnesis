// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  decodeToPcm16kMono,
  AudioDecodeError,
  resolveFfmpegPath,
  needsSeekableInput,
  PCM_SAMPLE_RATE,
} from "./audio-decode.js";
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

/** The start of an ISO base media file: an 8-byte `ftyp` box, then filler. */
function isoBmffHeader(brand: string, rest: Uint8Array = new Uint8Array(8)): Uint8Array {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16, 0);
  head.write("ftyp", 4, "ascii");
  head.write(brand, 8, "ascii");
  return Buffer.concat([head, rest]);
}

describe("needsSeekableInput", () => {
  test.each(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"])(
    "an ISO base media file opening with %s needs seeking",
    (box) => {
      const bytes = Buffer.alloc(16);
      bytes.writeUInt32BE(16, 0);
      bytes.write(box, 4, "ascii");
      expect(needsSeekableInput(bytes)).toBe(true);
    },
  );

  test.each([
    ["Ogg", Buffer.from("OggS\0\x02\0\0\0\0\0\0", "binary")],
    ["CAF", Buffer.from("6361666600010000646573630000", "hex")],
    ["WAV", Buffer.from("RIFF\x24\0\0\0WAVEfmt ", "binary")],
    ["too short", Buffer.from("\0\0\0\x10fty", "binary")],
  ])("%s streams from stdin", (_name, bytes) => {
    expect(needsSeekableInput(bytes)).toBe(false);
  });
});

describe("decodeToPcm16kMono with an MP4-family input", () => {
  // The stub records the input argument it was given and, when that names a
  // file, the file's mode and size while it is being decoded.
  const recordInput = (record: string, tail: string) => `
const fs = require("node:fs");
const arg = process.argv[process.argv.indexOf("-i") + 1];
const path = arg.startsWith("file:") ? arg.slice(5) : null;
const stat = path ? fs.statSync(path) : null;
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  arg,
  nostdin: process.argv.includes("-nostdin"),
  mode: stat ? stat.mode & 0o777 : null,
  size: stat ? stat.size : null,
}));
${tail}`;

  test("decodes from an owner-only copy that is removed afterwards", async () => {
    const tempDir = mkdtempSync(join(dir, "seekable-ok-"));
    const record = join(dir, "seekable-ok.json");
    const ffmpeg = makeStub(
      "seekable-ok-ffmpeg",
      recordInput(
        record,
        `const b = Buffer.alloc(4); b.writeFloatLE(0.5, 0); process.stdout.write(b, () => process.exit(0));`,
      ),
    );
    const bytes = isoBmffHeader("M4A ");
    const pcm = await decodeToPcm16kMono(bytes, { ffmpegPath: ffmpeg, tempDir });
    expect(Array.from(pcm)).toEqual([0.5]);
    const seen = JSON.parse(readFileSync(record, "utf8")) as {
      arg: string;
      nostdin: boolean;
      mode: number;
      size: number;
    };
    expect(seen.arg.startsWith(`file:${tempDir}`)).toBe(true);
    expect(seen.nostdin).toBe(true);
    expect(seen.mode).toBe(0o600);
    expect(seen.size).toBe(bytes.byteLength);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  test.each([
    ["fails", `process.stderr.write("Cannot allocate memory"); process.exit(1);`, false],
    ["finds no audio", `process.exit(0);`, true],
    ["is killed", `process.stderr.write("x", () => process.kill(process.pid, "SIGKILL"));`, false],
  ])("removes the copy when the decoder %s", async (name, tail, unreadable) => {
    const slug = name.replace(/\W/g, "-");
    const tempDir = mkdtempSync(join(dir, `seekable-${slug}-`));
    const record = join(dir, `seekable-${slug}.json`);
    const ffmpeg = makeStub(`seekable-${slug}-ffmpeg`, recordInput(record, tail));
    await expect(
      decodeToPcm16kMono(isoBmffHeader("M4A "), { ffmpegPath: ffmpeg, tempDir }),
    ).rejects.toMatchObject({ name: "AudioDecodeError", unreadable });
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ mode: 0o600 });
    expect(readdirSync(tempDir)).toEqual([]);
  });

  test("removes the copy when the decoder times out", async () => {
    const tempDir = mkdtempSync(join(dir, "seekable-slow-"));
    const ffmpeg = makeStub("seekable-slow-ffmpeg", `setTimeout(() => process.exit(0), 10_000);`);
    await expect(
      decodeToPcm16kMono(isoBmffHeader("M4A "), { ffmpegPath: ffmpeg, tempDir, timeoutMs: 100 }),
    ).rejects.toMatchObject({ unreadable: false, message: expect.stringMatching(/timed out/) });
    expect(readdirSync(tempDir)).toEqual([]);
  });

  test("a temporary folder that cannot be made is not unreadable audio", async () => {
    const ffmpeg = makeStub("never-run-ffmpeg", `process.exit(0);`);
    await expect(
      decodeToPcm16kMono(isoBmffHeader("M4A "), {
        ffmpegPath: ffmpeg,
        tempDir: join(dir, "missing", "parent"),
      }),
    ).rejects.toMatchObject({ name: "AudioDecodeError", unreadable: false });
  });

  test("other inputs stream from stdin without a copy", async () => {
    const tempDir = mkdtempSync(join(dir, "streamed-"));
    const record = join(dir, "streamed.json");
    const ffmpeg = makeStub(
      "streamed-ffmpeg",
      recordInput(
        record,
        `const b = Buffer.alloc(4); process.stdout.write(b, () => process.exit(0));`,
      ),
    );
    await decodeToPcm16kMono(Buffer.from("OggS\0\x02\0\0\0\0\0\0", "binary"), {
      ffmpegPath: ffmpeg,
      tempDir,
    });
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
      arg: "pipe:0",
      nostdin: false,
    });
    expect(readdirSync(tempDir)).toEqual([]);
  });
});

/** Generate a synthetic 440 Hz tone with the real ffmpeg; returns its bytes. */
function generateTone(ffmpegPath: string, name: string, seconds: number, args: string[]): Buffer {
  const path = join(dir, name);
  const generated = spawnSync(
    ffmpegPath,
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      "-ar",
      "48000",
      ...args,
      path,
    ],
    { timeout: 30_000 },
  );
  expect(generated.status, generated.stderr?.toString()).toBe(0);
  return readFileSync(path);
}

// Synthetic tones exercise the real MP4 demuxer. ffmpeg's muxer writes the
// sample index after the audio unless asked for `+faststart`; past a few
// seconds that layout cannot be decoded from stdin at all.
describe("real ffmpeg on MP4-family audio", () => {
  const seconds = 20;

  test("decodes an m4a whose index follows its audio", async (context) => {
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return context.skip();
    const tempDir = mkdtempSync(join(dir, "real-moov-end-"));
    const bytes = generateTone(ffmpegPath, "tone-moov-end.m4a", seconds, ["-c:a", "aac"]);
    expect(bytes.indexOf("moov")).toBeGreaterThan(bytes.indexOf("mdat"));
    // The same bytes on stdin decode to nothing, which is what this layout needs a file for.
    const piped = spawnSync(
      ffmpegPath,
      ["-v", "quiet", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
      { input: bytes, timeout: 30_000 },
    );
    expect(piped.stdout.byteLength).toBe(0);

    const pcm = await decodeToPcm16kMono(bytes, { ffmpegPath, tempDir });
    expect(pcm.length / PCM_SAMPLE_RATE).toBeCloseTo(seconds, 1);
    expect(pcm.some((sample) => Math.abs(sample) > 0.01)).toBe(true);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  test("decodes an m4a written with +faststart", async (context) => {
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return context.skip();
    const tempDir = mkdtempSync(join(dir, "real-faststart-"));
    const bytes = generateTone(ffmpegPath, "tone-faststart.m4a", seconds, [
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
    ]);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
    const pcm = await decodeToPcm16kMono(bytes, { ffmpegPath, tempDir });
    expect(pcm.length / PCM_SAMPLE_RATE).toBeCloseTo(seconds, 1);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  test("an MP4 header with no index is still unreadable audio", async (context) => {
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return context.skip();
    const tempDir = mkdtempSync(join(dir, "real-junk-"));
    const junk = isoBmffHeader(
      "M4A ",
      new Uint8Array(2048).map((_, i) => (i * 7919) % 251),
    );
    await expect(decodeToPcm16kMono(junk, { ffmpegPath, tempDir })).rejects.toMatchObject({
      unreadable: true,
    });
    expect(readdirSync(tempDir)).toEqual([]);
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
