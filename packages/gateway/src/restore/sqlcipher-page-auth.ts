// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHmac, pbkdf2, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(pbkdf2);
const PAGE_BYTES = 4096;
const SALT_BYTES = 16;
const TAG_BYTES = 64;

/**
 * Verify the exact SQLCipher legacy=4 profile selected by keySqliteDb.
 * SQLite3MultipleCiphers cipher_sqlcipher.c defines its page authentication:
 * PBKDF2-SHA512(256000), a masked-salt HMAC key (2 iterations), and the
 * ciphertext plus IV and little-endian page number authenticated with SHA512.
 * This verifies original bytes; it implements no cipher or database decoder.
 * Unknown profiles refuse. Callers still require complete EOF and SQLite's
 * keyed integrity check before publishing a restored database.
 */
export async function* authenticateSqlCipherPages(
  input: AsyncIterable<Uint8Array>,
  storageKey: Buffer,
  signal: AbortSignal,
): AsyncGenerator<Buffer, void, void> {
  signal.throwIfAborted();
  if (!Buffer.isBuffer(storageKey) || storageKey.length !== 32)
    throw new Error("Unsupported encrypted database key");
  let page = Buffer.alloc(PAGE_BYTES);
  let filled = 0;
  let pageNumber = 0;
  let authenticationKey: Buffer | undefined;
  try {
    for await (const chunk of input) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid encrypted database stream");
      let offset = 0;
      while (offset < chunk.byteLength) {
        signal.throwIfAborted();
        const bytes = Math.min(PAGE_BYTES - filled, chunk.byteLength - offset);
        page.set(chunk.subarray(offset, offset + bytes), filled);
        filled += bytes;
        offset += bytes;
        if (filled !== PAGE_BYTES) continue;
        pageNumber++;
        if (pageNumber > 0xffff_ffff) throw new Error("Encrypted database exceeds its page format");
        if (!authenticationKey) {
          const salt = page.subarray(0, SALT_BYTES);
          // keySqliteDb passes the 64-character hex string as a quoted SQL
          // passphrase, rather than SQLCipher's x'raw-key' syntax.
          const password = Buffer.from(storageKey.toString("hex"), "ascii");
          const maskedSalt = Buffer.from(salt.map((value) => value ^ 0x3a));
          let encryptionKey: Buffer | undefined;
          try {
            encryptionKey = await derive(password, salt, 256_000, 32, "sha512");
            signal.throwIfAborted();
            authenticationKey = await derive(encryptionKey, maskedSalt, 2, 32, "sha512");
          } finally {
            password.fill(0);
            maskedSalt.fill(0);
            encryptionKey?.fill(0);
          }
        }
        signal.throwIfAborted();
        const number = Buffer.alloc(4);
        number.writeUInt32LE(pageNumber);
        const computed = createHmac("sha512", authenticationKey)
          .update(page.subarray(pageNumber === 1 ? SALT_BYTES : 0, PAGE_BYTES - TAG_BYTES))
          .update(number)
          .digest();
        if (!timingSafeEqual(computed, page.subarray(PAGE_BYTES - TAG_BYTES)))
          throw new Error("Encrypted database page authentication failed");
        yield page;
        page = Buffer.alloc(PAGE_BYTES);
        filled = 0;
      }
    }
    signal.throwIfAborted();
    if (!pageNumber || filled !== 0) throw new Error("Encrypted database page stream is truncated");
  } finally {
    authenticationKey?.fill(0);
  }
}
