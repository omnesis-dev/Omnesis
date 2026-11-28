// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, writeFile, readFile, rm, readdir, symlink, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureInstallRootKey, readInstallRootKey } from "./secret-store.js";
import { encryptArtifactFileInPlace } from "./encrypted-artifact.js";
import {
  readEncryptedArtifactStream,
  decryptEncryptedArtifactStream,
} from "./artifact-stream-reader.js";

let dir: string;
let rootKey: string;
const signal = new AbortController().signal;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-artifact-stream-"));
  await ensureInstallRootKey({ backend: "file", configDir: dir });
  rootKey = (await readInstallRootKey({ backend: "file", configDir: dir }))!;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function fixture(body = Buffer.alloc(256 * 1024, 0x67)) {
  const path = join(dir, "input");
  await writeFile(path, body, { mode: 0o600 });
  return (
    await encryptArtifactFileInPlace(path, {
      backend: "file",
      configDir: dir,
      scope: "restore:invented",
    })
  ).path;
}
async function consume(path: string, expectedScope = "restore:invented") {
  const blocks: Buffer[] = [];
  const reading = readEncryptedArtifactStream(path, { rootKey, expectedScope, signal });
  for await (const block of reading) blocks.push(block);
  return Buffer.concat(blocks);
}
test("streams existing authenticated envelopes with bounded memory and writes no plaintext output", async () => {
  const path = await fixture();
  const before = await readdir(dir);
  const reader = readEncryptedArtifactStream(path, {
    rootKey,
    expectedScope: "restore:invented",
    signal,
  });
  let bytes = 0;
  while (true) {
    const result = await reader.next();
    if (result.done) {
      expect(reader.authentication()).toEqual({ bytes: 256 * 1024, scope: "restore:invented" });
      break;
    }
    expect(result.value.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.value.every((byte) => byte === 0x67)).toBe(true);
    bytes += result.value.length;
  }
  expect(bytes).toBe(256 * 1024);
  expect(await readdir(dir)).toEqual(before);
});
test("authenticates an empty stream and rejects wrong roots, scopes and terminal tags", async () => {
  const path = await fixture(Buffer.alloc(0));
  expect(await consume(path)).toEqual(Buffer.alloc(0));
  await expect(consume(path, "restore:other")).rejects.toThrow("could not be authenticated");
  const other = join(dir, "other");
  await ensureInstallRootKey({ backend: "file", configDir: other });
  const wrong = (await readInstallRootKey({ backend: "file", configDir: other }))!;
  await expect(
    (async () => {
      for await (const _block of readEncryptedArtifactStream(path, { rootKey: wrong, signal })) {
        /* drain */
      }
    })(),
  ).rejects.toThrow("could not be authenticated");
  const bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(path, bytes);
  await expect(consume(path)).rejects.toThrow("could not be authenticated");
});
test("never produces terminal authentication for tampering or unlink during iteration", async () => {
  const path = await fixture();
  const reader = readEncryptedArtifactStream(path, { rootKey, signal });
  expect((await reader.next()).done).toBe(false);
  await unlink(path);
  await expect(
    (async () => {
      for await (const _block of reader) {
        /* drain */
      }
    })(),
  ).rejects.toThrow("could not be authenticated");
});
test("cancellation and an early consumer return close the owned file without publishing", async () => {
  const path = await fixture();
  const controller = new AbortController();
  const reader = readEncryptedArtifactStream(path, { rootKey, signal: controller.signal });
  await reader.next();
  controller.abort();
  await expect(reader.next()).rejects.toThrow();
  const early = readEncryptedArtifactStream(path, { rootKey, signal });
  await early.next();
  await early.return();
  expect(() => early.authentication()).toThrow("has not been authenticated");
  expect(await consume(path)).toHaveLength(256 * 1024);
});
test("rejects links, malformed huge headers and resource bounds before yielding plaintext", async () => {
  const path = await fixture();
  const linked = join(dir, "linked");
  await symlink(path, linked);
  await expect(consume(linked)).rejects.toThrow("could not be authenticated");
  const hard = join(dir, "hard");
  await link(path, hard);
  await expect(consume(path)).rejects.toThrow("could not be authenticated");
  await unlink(hard);
  await expect(
    (async () => {
      for await (const _block of readEncryptedArtifactStream(path, {
        rootKey,
        signal,
        maxBytes: 64,
      })) {
        /* drain */
      }
    })(),
  ).rejects.toThrow("could not be authenticated");
  const bytes = await readFile(path);
  bytes.writeUInt32BE(0xffffffff, Buffer.byteLength("omnesis.encrypted-artifact.v1\n"));
  await writeFile(path, bytes);
  await expect(consume(path)).rejects.toThrow("could not be authenticated");
});

test("nested and byte-fragmented encrypted streams authenticate without any plaintext intermediate file", async () => {
  const path = await fixture(Buffer.from("invented nested payload"));
  const raw = await readFile(path);
  const fragmented = (async function* () {
    for (let i = 0; i < raw.length; i++) yield raw.subarray(i, i + 1);
  })();
  const reading = decryptEncryptedArtifactStream(fragmented, {
    rootKey,
    expectedScope: "restore:invented",
    signal,
  });
  const blocks: Buffer[] = [];
  for await (const block of reading) blocks.push(block);
  expect(Buffer.concat(blocks).toString()).toBe("invented nested payload");
  expect(reading.authentication()).toEqual({ bytes: 23, scope: "restore:invented" });
  const truncated = decryptEncryptedArtifactStream(
    (async function* () {
      yield raw.subarray(0, raw.length - 1);
    })(),
    { rootKey, signal },
  );
  await expect(
    (async () => {
      for await (const _block of truncated) {
        /* drain */
      }
    })(),
  ).rejects.toThrow("could not be authenticated");
  expect(() => truncated.authentication()).toThrow("has not been authenticated");
});
