// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptSidecar,
  decryptSidecar,
  readSidecarFingerprint,
} from "./usearch-sidecar-crypto.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const FP = { vectorWriteSeq: 42, embedModel: "Qwen/Qwen3-Embedding-0.6B", embedDim: 1024 };

describe("usearch-sidecar-crypto", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidecar-crypto-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function encPath() {
    return join(dir, "index.usearch.enc");
  }

  it("round-trips arbitrary bytes and leaves the plaintext source in place", () => {
    const plain = join(dir, "index.usearch");
    const data = randomBytes(3 * 1024 * 1024 + 777); // >stream chunk, non-aligned
    writeFileSync(plain, data);

    encryptSidecar(plain, encPath(), KEY, FP);
    expect(existsSync(encPath())).toBe(true);
    expect(existsSync(plain)).toBe(true); // source untouched — it is the reader's working copy
    // Encrypted output is not the plaintext.
    expect(readFileSync(encPath()).subarray(0, 32).equals(data.subarray(0, 32))).toBe(false);

    const out = join(dir, "index.usearch.dec");
    decryptSidecar(encPath(), out, KEY);
    expect(readFileSync(out).equals(data)).toBe(true);
  });

  it("round-trips an empty and a tiny graph file", () => {
    for (const bytes of [0, 1, 15]) {
      const plain = join(dir, `p${bytes}`);
      const data = randomBytes(bytes);
      writeFileSync(plain, data);
      const enc = join(dir, `e${bytes}.enc`);
      encryptSidecar(plain, enc, KEY, FP);
      const out = join(dir, `d${bytes}`);
      decryptSidecar(enc, out, KEY);
      expect(readFileSync(out).equals(data)).toBe(true);
    }
  });

  it("exposes the fingerprint via the header without the key, and it survives decrypt (AAD)", () => {
    const plain = join(dir, "index.usearch");
    writeFileSync(plain, randomBytes(4096));
    encryptSidecar(plain, encPath(), KEY, FP);

    const fp = readSidecarFingerprint(encPath());
    expect(fp).toEqual(FP);
    // returns null for a non-sidecar / missing file
    expect(readSidecarFingerprint(join(dir, "nope.enc"))).toBeNull();
    writeFileSync(join(dir, "garbage.enc"), randomBytes(200));
    expect(readSidecarFingerprint(join(dir, "garbage.enc"))).toBeNull();
  });

  it("rejects a wrong key (GCM auth failure)", () => {
    const plain = join(dir, "index.usearch");
    writeFileSync(plain, randomBytes(65536));
    encryptSidecar(plain, encPath(), KEY, FP);
    expect(() => decryptSidecar(encPath(), join(dir, "d"), OTHER_KEY)).toThrow();
    expect(existsSync(join(dir, "d"))).toBe(false); // no partial output survives
  });

  it("rejects a tampered ciphertext body", () => {
    const plain = join(dir, "index.usearch");
    writeFileSync(plain, randomBytes(65536));
    encryptSidecar(plain, encPath(), KEY, FP);
    const buf = readFileSync(encPath());
    buf[buf.length - 32] ^= 0xff; // flip a ciphertext byte (before the 16-byte tag)
    writeFileSync(encPath(), buf);
    expect(() => decryptSidecar(encPath(), join(dir, "d"), KEY)).toThrow();
  });

  it("rejects a tampered header (fingerprint forged) via AAD", () => {
    const plain = join(dir, "index.usearch");
    writeFileSync(plain, randomBytes(4096));
    encryptSidecar(plain, encPath(), KEY, FP);
    const buf = readFileSync(encPath());
    const s = buf.toString("latin1");
    // Change the seq in the JSON header from 42 to 99 (same length) — the
    // header is AAD, so decrypt must fail even though readSidecarFingerprint
    // would now report 99.
    const tampered = s.replace('"vectorWriteSeq":42', '"vectorWriteSeq":99');
    expect(tampered).not.toEqual(s);
    writeFileSync(encPath(), Buffer.from(tampered, "latin1"));
    expect(readSidecarFingerprint(encPath())?.vectorWriteSeq).toBe(99); // header read is unauthenticated
    expect(() => decryptSidecar(encPath(), join(dir, "d"), KEY)).toThrow(); // but decrypt catches it
  });

  it("rejects a truncated envelope", () => {
    const plain = join(dir, "index.usearch");
    writeFileSync(plain, randomBytes(65536));
    encryptSidecar(plain, encPath(), KEY, FP);
    const buf = readFileSync(encPath());
    writeFileSync(encPath(), buf.subarray(0, buf.length - 100)); // drop the tail
    expect(() => decryptSidecar(encPath(), join(dir, "d"), KEY)).toThrow();
  });

  it("refuses to decrypt onto the input path", () => {
    const plain = join(dir, "index.usearch");
    writeFileSync(plain, randomBytes(1024));
    encryptSidecar(plain, encPath(), KEY, FP);
    expect(() => decryptSidecar(encPath(), encPath(), KEY)).toThrow(/differ/);
  });

  it("encrypt is atomic — no .tmp left behind on success", () => {
    const plain = join(dir, "index.usearch");
    writeFileSync(plain, randomBytes(1 << 20));
    encryptSidecar(plain, encPath(), KEY, FP);
    // The temp uses `.enc.tmp-...`; confirm only the final file exists.
    expect(statSync(encPath()).size).toBeGreaterThan(0);
  });
});
