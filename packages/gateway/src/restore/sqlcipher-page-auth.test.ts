// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { authenticateSqlCipherPages } from "./sqlcipher-page-auth.js";

let directory: string;
let key: Buffer;
let original: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-page-auth-"));
  key = randomBytes(32);
  const path = join(directory, "fixture.db");
  const database = openEncryptedSqlite(path, { key });
  try {
    database.pragma("journal_mode=DELETE");
    database.exec("CREATE TABLE sample(value TEXT)");
    database.prepare("INSERT INTO sample VALUES (?)").run("invented corpus content\n".repeat(2000));
  } finally {
    database.close();
  }
  original = await readFile(path);
  expect(original.length).toBeGreaterThan(4096 * 3);
});
afterAll(async () => {
  key?.fill(0);
  await rm(directory, { recursive: true, force: true });
});

async function* chunks(bytes: Buffer, size = 1317) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
async function read(bytes: Buffer, storageKey = key) {
  const pages: Buffer[] = [];
  for await (const page of authenticateSqlCipherPages(
    chunks(bytes),
    storageKey,
    new AbortController().signal,
  ))
    pages.push(page);
  return Buffer.concat(pages);
}

test("authenticates real keyed SQLite output without modifying its bytes across irregular chunk boundaries", async () => {
  expect(await read(original)).toEqual(original);
});

test.each([
  ["salt", 0],
  ["first ciphertext", 16],
  ["IV", 4016],
  ["tag", 4032],
] as const)("rejects a changed first-page %s before yielding any byte", async (_label, offset) => {
  const corrupted = Buffer.from(original);
  corrupted[offset] ^= 1;
  let yielded = 0;
  await expect(
    (async () => {
      for await (const _page of authenticateSqlCipherPages(
        chunks(corrupted),
        key,
        new AbortController().signal,
      ))
        yielded++;
    })(),
  ).rejects.toThrow("authentication failed");
  expect(yielded).toBe(0);
});

test("never yields a corrupted later page and binds ciphertext to its page number", async () => {
  const changed = Buffer.from(original);
  changed[4096 + 100] ^= 1;
  const reordered = Buffer.concat([
    original.subarray(0, 4096),
    original.subarray(8192, 12288),
    original.subarray(4096, 8192),
    original.subarray(12288),
  ]);
  for (const bytes of [changed, reordered]) {
    const yielded: Buffer[] = [];
    await expect(
      (async () => {
        for await (const page of authenticateSqlCipherPages(
          chunks(bytes),
          key,
          new AbortController().signal,
        ))
          yielded.push(page);
      })(),
    ).rejects.toThrow("authentication failed");
    expect(yielded).toEqual([original.subarray(0, 4096)]);
  }
});

test("wrong keys, arbitrary plaintext, trailing data and truncation cannot complete", async () => {
  await expect(read(original, randomBytes(32))).rejects.toThrow("authentication failed");
  await expect(read(Buffer.alloc(4096, 0x51))).rejects.toThrow("authentication failed");
  for (const bytes of [
    Buffer.alloc(0),
    original.subarray(0, 4095),
    original.subarray(0, original.length - 1),
    Buffer.concat([original, Buffer.from([1])]),
  ])
    await expect(read(bytes)).rejects.toThrow("truncated");
});

test("cancellation before reading and between pages refuses completion without mutating yielded ciphertext", async () => {
  const controller = new AbortController();
  controller.abort();
  let consumed = false;
  async function* source() {
    consumed = true;
    yield original;
  }
  await expect(
    authenticateSqlCipherPages(source(), key, controller.signal).next(),
  ).rejects.toThrow();
  expect(consumed).toBe(false);
  const later = new AbortController();
  const iterator = authenticateSqlCipherPages(chunks(original, 8192), key, later.signal);
  const first = (await iterator.next()).value;
  later.abort();
  await expect(iterator.next()).rejects.toThrow();
  expect(first).toEqual(original.subarray(0, 4096));
});
