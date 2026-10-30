// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  CorruptBackupError,
  UnsupportedBackupFormatError,
  WrongBackupKeyError,
  decryptMsgstore,
  deriveAesKey,
  resolveRootKey,
} from "./android-backup-decrypt.js";
import { buildMsgstoreDb, makeEncryptedAndroidBackup } from "./testing/make-android-backup.js";

const CORPUS = {
  chats: [{ id: 1, jid: "15550100123@s.whatsapp.net" }],
  messages: [
    {
      id: 1,
      keyId: "ANDROID0001",
      chatId: 1,
      fromMe: 0 as const,
      tsMs: 1_700_000_000_000,
      type: 0,
      text: "hi",
    },
  ],
};

describe("Android crypt15 decrypt", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function pushFileDir(filePath: string): void {
    dirs.push(join(filePath, ".."));
  }

  it("round-trips: build encrypted backup → decrypt → exact msgstore.db bytes", () => {
    const msgstoreBytes = buildMsgstoreDb(CORPUS);
    const { filePath, keyHex } = makeEncryptedAndroidBackup({ msgstoreBytes });
    pushFileDir(filePath);

    const decrypted = decryptMsgstore(filePath, keyHex);
    expect(decrypted.equals(msgstoreBytes)).toBe(true);
    expect(decrypted.subarray(0, 16).toString("ascii")).toBe("SQLite format 3\0");
  });

  it("accepts a raw 32-byte key file with the same result as the hex key", () => {
    const msgstoreBytes = buildMsgstoreDb(CORPUS);
    const { filePath, keyHex } = makeEncryptedAndroidBackup({ msgstoreBytes });
    pushFileDir(filePath);

    const keyFileDir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-keyfile-"));
    dirs.push(keyFileDir);
    const keyFilePath = join(keyFileDir, "key");
    writeFileSync(keyFilePath, Buffer.from(keyHex, "hex"));

    const viaHex = decryptMsgstore(filePath, keyHex);
    const viaFile = decryptMsgstore(filePath, keyFilePath);
    expect(viaFile.equals(viaHex)).toBe(true);
  });

  it("accepts a key file holding the hex string as text", () => {
    const msgstoreBytes = buildMsgstoreDb(CORPUS);
    const { filePath, keyHex } = makeEncryptedAndroidBackup({ msgstoreBytes });
    pushFileDir(filePath);

    const keyFileDir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-keyfile-text-"));
    dirs.push(keyFileDir);
    const keyFilePath = join(keyFileDir, "key.txt");
    writeFileSync(keyFilePath, keyHex, "utf8");

    expect(decryptMsgstore(filePath, keyFilePath).equals(msgstoreBytes)).toBe(true);
  });

  it("throws WrongBackupKeyError on a wrong key", () => {
    const { filePath } = makeEncryptedAndroidBackup({ msgstoreBytes: buildMsgstoreDb(CORPUS) });
    pushFileDir(filePath);
    const wrongKey = randomBytes(32).toString("hex");
    expect(() => decryptMsgstore(filePath, wrongKey)).toThrow(WrongBackupKeyError);
  });

  it("decrypts a header without the features flag, as WhatsApp's non-msgstore files carry", () => {
    const msgstoreBytes = buildMsgstoreDb(CORPUS);
    const { filePath, keyHex } = makeEncryptedAndroidBackup({ msgstoreBytes, featuresFlag: false });
    pushFileDir(filePath);
    expect(readFileSync(filePath)[1]).not.toBe(0x01);
    expect(decryptMsgstore(filePath, keyHex).equals(msgstoreBytes)).toBe(true);
  });

  it.each([150, 300, 600])(
    "reads a %i-byte padded header's size as a varint, flagged or not",
    (headerPaddingBytes) => {
      const msgstoreBytes = buildMsgstoreDb(CORPUS);
      for (const featuresFlag of [true, false]) {
        const { filePath, keyHex } = makeEncryptedAndroidBackup({
          msgstoreBytes,
          featuresFlag,
          headerPaddingBytes,
        });
        pushFileDir(filePath);
        expect(readFileSync(filePath)[0] & 0x80).toBe(0x80); // a multi-byte varint
        expect(decryptMsgstore(filePath, keyHex).equals(msgstoreBytes)).toBe(true);
      }
    },
  );

  it("rejects a header length that exceeds the safety limit", () => {
    const { filePath, keyHex } = makeEncryptedAndroidBackup({
      msgstoreBytes: buildMsgstoreDb(CORPUS),
    });
    pushFileDir(filePath);
    const original = readFileSync(filePath);
    // Replace the leading one-byte varint with an implausibly large header length.
    const tampered = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]),
      original.subarray(1),
    ]);
    writeFileSync(filePath, tampered);
    expect(() => decryptMsgstore(filePath, keyHex)).toThrow(UnsupportedBackupFormatError);
  });

  it("checks the trailing MD5 over the header too", () => {
    const { filePath, keyHex } = makeEncryptedAndroidBackup({
      msgstoreBytes: buildMsgstoreDb(CORPUS),
      headerPaddingBytes: 8,
    });
    pushFileDir(filePath);
    const tampered = Buffer.from(readFileSync(filePath));
    tampered[tampered.indexOf(Buffer.from("aaaaaaaa"))] ^= 0x01; // a header byte no parse reads
    writeFileSync(filePath, tampered);
    expect(() => decryptMsgstore(filePath, keyHex)).toThrow(UnsupportedBackupFormatError);
  });

  it("rejects a zero header length", () => {
    const { filePath, keyHex } = makeEncryptedAndroidBackup({
      msgstoreBytes: buildMsgstoreDb(CORPUS),
    });
    pushFileDir(filePath);
    const tampered = Buffer.from(readFileSync(filePath));
    tampered[0] = 0;
    writeFileSync(filePath, tampered);
    expect(() => decryptMsgstore(filePath, keyHex)).toThrow(UnsupportedBackupFormatError);
  });

  it("rejects a truncated file", () => {
    const { filePath, keyHex } = makeEncryptedAndroidBackup({
      msgstoreBytes: buildMsgstoreDb(CORPUS),
    });
    pushFileDir(filePath);
    const original = readFileSync(filePath);
    writeFileSync(filePath, original.subarray(0, 5));
    expect(() => decryptMsgstore(filePath, keyHex)).toThrow(CorruptBackupError);
  });

  it("rejects a backup whose trailing checksum doesn't match (simulated chunked-backup layout)", () => {
    const { filePath, keyHex } = makeEncryptedAndroidBackup({
      msgstoreBytes: buildMsgstoreDb(CORPUS),
    });
    pushFileDir(filePath);
    const original = readFileSync(filePath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff; // corrupt one checksum byte
    writeFileSync(filePath, tampered);
    expect(() => decryptMsgstore(filePath, keyHex)).toThrow(UnsupportedBackupFormatError);
  });

  it("rejects a decompressed payload exceeding the safety limit (decompression bomb guard)", () => {
    // A long run of zero bytes compresses to a tiny ciphertext but would
    // inflate to something much larger — build a real encrypted fixture
    // around it, then call decryptMsgstore with a tight limit override (the
    // production default is a generous 4 GiB no legitimate backup reaches,
    // so the override is what makes this guard testable without allocating
    // gigabytes).
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0); // 8MB of zeros
    const { filePath, keyHex } = makeEncryptedAndroidBackup({ msgstoreBytes: bomb });
    pushFileDir(filePath);
    expect(() => decryptMsgstore(filePath, keyHex, 1024)).toThrow(CorruptBackupError);
  });

  it("rejects a Java-serialized key file instead of misparsing it", () => {
    const keyFileDir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-javakey-"));
    dirs.push(keyFileDir);
    const keyFilePath = join(keyFileDir, "encrypted_backup.key");
    writeFileSync(keyFilePath, Buffer.from([0xac, 0xed, 0x00, 0x05, 0x00, 0x00]));
    expect(() => resolveRootKey(keyFilePath)).toThrow(UnsupportedBackupFormatError);
  });

  it("rejects a key file that is neither a 32-byte key nor a hex string", () => {
    const keyFileDir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-badkey-"));
    dirs.push(keyFileDir);
    const keyFilePath = join(keyFileDir, "key");
    writeFileSync(keyFilePath, "not a key");
    expect(() => resolveRootKey(keyFilePath)).toThrow(UnsupportedBackupFormatError);
  });

  it("deriveAesKey matches an independently hand-computed HMAC chain (fictional key)", () => {
    const rootKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 3));
    const zero32 = Buffer.alloc(32, 0x00);
    const privateKey = createHmac("sha256", zero32).update(rootKey).digest();
    const expected = createHmac("sha256", privateKey)
      .update(Buffer.from("backup encryption\x01", "latin1"))
      .digest();
    expect(deriveAesKey(rootKey).equals(expected)).toBe(true);
  });
});
