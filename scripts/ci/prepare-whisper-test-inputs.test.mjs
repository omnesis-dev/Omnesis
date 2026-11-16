// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { downloadWhisperTestAsset } from "./prepare-whisper-test-inputs.mjs";

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
