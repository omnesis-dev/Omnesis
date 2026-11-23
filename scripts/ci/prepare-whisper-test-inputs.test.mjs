// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  downloadWhisperTestAsset,
  downloadWhisperTestAssetWithRetry,
} from "./prepare-whisper-test-inputs.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "whisper assets-"));
  directories.push(directory);
  const bytes = Buffer.from("fictional download fixture");
  return {
    directory,
    path: join(directory, "input with spaces.bin"),
    bytes,
    asset: {
      url: "https://example.com/public-model.bin",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
test("accepts only the complete checksum-verified input", async () => {
  const { path, bytes, asset } = await fixture();
  expect(
    await downloadWhisperTestAsset(asset, path, { fetchImpl: async () => new Response(bytes) }),
  ).toBe(path);
  expect(await readFile(path)).toEqual(bytes);
});
for (const fault of ["short", "oversize", "digest", "http", "stream"]) {
  test(`removes owned partial input after ${fault} failure`, async () => {
    const { directory, path, bytes, asset } = await fixture();
    const fetchImpl = async () => {
      if (fault === "http") return new Response(null, { status: 404 });
      if (fault === "stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 3));
              controller.error(new Error("fixture stream failed"));
            },
          }),
        );
      if (fault === "short") return new Response(bytes.subarray(0, bytes.length - 1));
      if (fault === "oversize") return new Response(Buffer.concat([bytes, Buffer.from("extra")]));
      return new Response(Buffer.alloc(bytes.length));
    };
    await expect(downloadWhisperTestAsset(asset, path, { fetchImpl })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
}
test("refuses an existing path without deleting or replacing its contents", async () => {
  const { path, bytes, asset } = await fixture();
  await writeFile(path, "pre-existing fixture input");
  await expect(
    downloadWhisperTestAsset(asset, path, { fetchImpl: async () => new Response(bytes) }),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("pre-existing fixture input");
});

/** Answers each fetch with the next scripted reply, recording the waits between attempts. */
function scripted(replies) {
  const waits = [];
  let calls = 0;
  return {
    waits,
    calls: () => calls,
    options: {
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: async () => {
        const reply = replies[Math.min(calls++, replies.length - 1)];
        if (reply instanceof Error) throw reply;
        return reply();
      },
    },
  };
}
const brokenBody = (bytes) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 3));
        controller.error(new Error("fixture connection reset"));
      },
    }),
  );

for (const [name, first] of [
  ["a 502 answer", () => new Response(null, { status: 502 })],
  ["a 429 answer", () => new Response(null, { status: 429 })],
  ["a refused connection", new TypeError("fetch failed")],
]) {
  test(`tries again after ${name} and keeps the verified input`, async () => {
    const { directory, path, bytes, asset } = await fixture();
    const run = scripted([first, () => new Response(bytes)]);
    expect(await downloadWhisperTestAssetWithRetry(asset, path, run.options)).toBe(path);
    expect(run.calls()).toBe(2);
    expect(run.waits).toEqual([5_000]);
    expect(await readdir(directory)).toEqual(["input with spaces.bin"]);
    expect(await readFile(path)).toEqual(bytes);
  });
}

test("tries again after the connection breaks mid-body, leaving no partial input behind", async () => {
  const { path, bytes, asset } = await fixture();
  const run = scripted([brokenBody(bytes), () => new Response(bytes)]);
  expect(await downloadWhisperTestAssetWithRetry(asset, path, run.options)).toBe(path);
  expect(run.calls()).toBe(2);
  expect(await readFile(path)).toEqual(bytes);
});

test("gives up after its bounded attempts when the host keeps failing, naming the host", async () => {
  const { directory, path, asset } = await fixture();
  const run = scripted([() => new Response(null, { status: 503 })]);
  await expect(downloadWhisperTestAssetWithRetry(asset, path, run.options)).rejects.toThrow(
    "ASR asset HTTP 503 from example.com",
  );
  expect(run.calls()).toBe(5);
  expect(run.waits).toEqual([5_000, 10_000, 20_000, 40_000]);
  expect(await readdir(directory)).toEqual([]);
});

for (const [name, reply] of [
  ["a missing asset (404)", () => () => new Response(null, { status: 404 })],
  ["a checksum mismatch", (bytes) => () => new Response(Buffer.alloc(bytes.length))],
  ["an oversize body", (bytes) => () => new Response(Buffer.concat([bytes, Buffer.from("extra")]))],
]) {
  test(`fails at once on ${name}`, async () => {
    const { directory, path, bytes, asset } = await fixture();
    const run = scripted([reply(bytes), () => new Response(bytes)]);
    await expect(downloadWhisperTestAssetWithRetry(asset, path, run.options)).rejects.toThrow();
    expect(run.calls()).toBe(1);
    expect(run.waits).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
}

test("fails at once on an existing path, keeping its contents", async () => {
  const { path, bytes, asset } = await fixture();
  await writeFile(path, "pre-existing fixture input");
  const run = scripted([() => new Response(bytes)]);
  await expect(downloadWhisperTestAssetWithRetry(asset, path, run.options)).rejects.toThrow();
  expect(run.calls()).toBe(1);
  expect(await readFile(path, "utf8")).toBe("pre-existing fixture input");
});
