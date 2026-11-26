// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

const HEADER_BYTES = 4096;
const PAYLOAD_OFFSET = 32;

/**
 * Verify DuckDB's SHA256/GCM storage profiles before any imported database bytes reach disk.
 * Header/nonce layout and salt-then-base64-decoded-key KDF follow DuckDB v1.5.6:
 * src/storage/single_file_block_manager.cpp and src/common/encryption_key_manager.cpp.
 * https://github.com/duckdb/duckdb/tree/v1.5.6/src
 * This is an authentication boundary, not a database parser. Unknown profiles refuse.
 */
export async function* authenticateDuckDbBlocks(
  input: AsyncIterable<Uint8Array>,
  storageKey: Buffer,
  signal: AbortSignal,
): AsyncGenerator<Buffer, void, void> {
  if (!Buffer.isBuffer(storageKey) || storageKey.length !== 32)
    throw new Error("Unsupported analytics encryption key");
  const iterator = input[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  let offset = 0;
  async function take(length: number, allowEof = false): Promise<Buffer | null> {
    const result = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      signal.throwIfAborted();
      if (offset === pending.length) {
        const next = await iterator.next();
        if (next.done) {
          if (allowEof && written === 0) return null;
          throw new Error("The encrypted analytics stream is truncated");
        }
        if (!(next.value instanceof Uint8Array)) throw new Error("Invalid analytics stream");
        pending = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        offset = 0;
        if (!pending.length) continue;
      }
      const bytes = Math.min(length - written, pending.length - offset);
      result.set(pending.subarray(offset, offset + bytes), written);
      offset += bytes;
      written += bytes;
    }
    return result;
  }
  let key: Buffer | undefined;
  try {
    const header = (await take(HEADER_BYTES))!;
    const version = header[119];
    const storageVersion = header.readBigUInt64LE(12);
    if (
      header.subarray(8, 12).toString("ascii") !== "DUCK" ||
      storageVersion < 64n ||
      storageVersion > 999n ||
      header.readBigUInt64LE(20) !== 1n ||
      !header.subarray(28, 52).every((value) => value === 0) ||
      ![0, 1].includes(header[116]!) ||
      header[117] !== 0 ||
      header[118] !== 1 ||
      ![0, 1].includes(version!) ||
      header.readUInt32LE(120) !== 32 ||
      !header.subarray(176).every((value) => value === 0)
    )
      throw new Error("Unsupported encrypted analytics format");
    const description = header.subarray(52, 84).toString("ascii").replace(/\0+$/, "");
    const revision = header.subarray(84, 116).toString("ascii").replace(/\0+$/, "");
    if (!/^v\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(description) || !/^[a-f0-9]{7,32}$/.test(revision))
      throw new Error("Invalid public analytics header");
    // Omnesis passes the storage key as its 64-character hex SQL string. DuckDB decodes that
    // valid Base64 string before deriving SHA256(salt || decoded user key).
    const password = Buffer.from(storageKey.toString("hex"), "base64");
    try {
      key = createHash("sha256").update(header.subarray(124, 140)).update(password).digest();
    } finally {
      password.fill(0);
    }
    const canary = createDecipheriv(
      "aes-256-gcm",
      key,
      version === 1 ? header.subarray(148, 160) : Buffer.alloc(16),
      { authTagLength: 16 },
    );
    if (version === 1) canary.setAuthTag(header.subarray(160, 176));
    const known = canary.update(header.subarray(140, 148));
    try {
      if (version === 1) canary.final();
      if (!timingSafeEqual(known, Buffer.from("DUCKKEY\0")))
        throw new Error("Invalid analytics key");
    } finally {
      known.fill(0);
    }
    const nonceBytes = version === 1 ? 12 : 16;
    function authenticate(block: Buffer): Buffer {
      const decipher = createDecipheriv("aes-256-gcm", key!, block.subarray(0, nonceBytes), {
        authTagLength: 16,
      });
      decipher.setAuthTag(block.subarray(nonceBytes, nonceBytes + 16));
      let plaintext: Buffer | undefined;
      try {
        plaintext = decipher.update(block.subarray(PAYLOAD_OFFSET));
        decipher.final();
        return plaintext;
      } catch {
        plaintext?.fill(0);
        throw new Error("Analytics block authentication failed");
      }
    }
    const first = (await take(HEADER_BYTES))!,
      second = (await take(HEADER_BYTES))!;
    let blockBytes = 0;
    for (const block of [first, second]) {
      const plain = authenticate(block);
      try {
        const bytes = Number(plain.readBigUInt64LE(40)) || 262_144;
        if (
          !Number.isSafeInteger(bytes) ||
          bytes < 16_384 ||
          bytes > 262_144 ||
          (bytes & (bytes - 1)) !== 0 ||
          (blockBytes !== 0 && bytes !== blockBytes)
        )
          throw new Error("Unsupported analytics block size");
        blockBytes = bytes;
      } finally {
        plain.fill(0);
      }
    }
    // Only a public validated header and authenticated original ciphertext are yielded.
    yield header;
    yield first;
    yield second;
    for (;;) {
      const block = await take(blockBytes, true);
      if (!block) break;
      // Unallocated sparse blocks contain no payload and are safe to preserve verbatim.
      if (!block.every((value) => value === 0)) authenticate(block).fill(0);
      yield block;
    }
    signal.throwIfAborted();
  } finally {
    key?.fill(0);
    await iterator.return?.();
  }
}
