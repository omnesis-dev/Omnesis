// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Encrypted-at-rest persistence for the HNSW sidecar (`index.usearch`).
 *
 * Under storage encryption the plaintext sidecar must never survive a
 * shutdown — but rebuilding the ~800k-vector graph from the encrypted
 * `chunks.embedding` vectors takes many minutes on every restart. This
 * module lets the graph persist across restarts *while encrypted*: the
 * writer emits `index.usearch.enc` (an authenticated AES-256-GCM envelope
 * keyed off the index-db data-encryption key), and boot decrypts it back
 * to a plaintext working copy ONLY when a fingerprint proves it is
 * consistent with `index.db`. On any mismatch, tamper, or corruption the
 * only fallback is a graph rebuild from the durable vectors — never a
 * re-embed, never an index wipe.
 *
 * Format (mirrors `@omnesis/core` `encrypted-artifact` so the header is
 * readable without decrypting the body):
 *
 *   MAGIC | uint32be(headerLen) | headerJSON | ciphertext | 16-byte GCM tag
 *
 * `headerJSON` is authenticated as AAD and carries the per-file random
 * salt + iv plus the consistency fingerprint (`vectorWriteSeq`) and the
 * embedder stamp (`embedModel`/`embedDim`). The body cipher key is
 * `HKDF-SHA256(indexDbKey, salt, "omnesis-usearch-sidecar")` — bound to
 * the same key that protects `index.db`, so the sidecar and its source
 * vectors share one trust root.
 *
 * All operations are synchronous and stay off the live request path:
 * `encryptSidecar` runs inside the indexer worker at shutdown, while
 * `restoreActiveSidecar`/`decryptSidecar` run at boot before the gateway
 * accepts traffic. Streaming keeps the multi-gigabyte graph off the heap.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("omnesis.usearch-sidecar.v1\n", "utf8");
const ALG = "aes-256-gcm";
const TAG_BYTES = 16;
const HKDF_INFO = "omnesis-usearch-sidecar";
const STREAM_CHUNK = 1 << 20; // 1 MiB

/** Consistency + provenance fields carried in the (authenticated) header. */
export interface SidecarFingerprint {
  /** Monotonic `index_meta['vector_write_seq']` at the moment of the graph snapshot. */
  vectorWriteSeq: number;
  /** Embedder stamp — a mismatch forces a rebuild (defense in depth). */
  embedModel: string;
  embedDim: number;
}

interface SidecarHeader extends SidecarFingerprint {
  omnesis: "usearch-sidecar";
  version: 1;
  alg: typeof ALG;
  salt: string; // base64url
  iv: string; // base64url
}

function deriveKey(indexDbKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", indexDbKey, salt, HKDF_INFO, 32));
}

function uint32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/**
 * Encrypt `plaintextPath` → `encPath` atomically (temp + fsync + rename).
 * The rename is the durability commit point. The plaintext file is left
 * in place (the caller owns its lifecycle — it is the reader's working
 * copy). Synchronous + streaming.
 */
export function encryptSidecar(
  plaintextPath: string,
  encPath: string,
  indexDbKey: Buffer,
  fingerprint: SidecarFingerprint,
): void {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header: SidecarHeader = {
    omnesis: "usearch-sidecar",
    version: 1,
    alg: ALG,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    vectorWriteSeq: fingerprint.vectorWriteSeq,
    embedModel: fingerprint.embedModel,
    embedDim: fingerprint.embedDim,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const key = deriveKey(indexDbKey, salt);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(headerBytes);

  const tmp = `${encPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const inp = openSync(plaintextPath, "r");
  let out = -1;
  try {
    out = openSync(tmp, "w", 0o600);
    writeSync(out, MAGIC);
    writeSync(out, uint32be(headerBytes.length));
    writeSync(out, headerBytes);
    const buf = Buffer.alloc(STREAM_CHUNK);
    for (;;) {
      const n = readSync(inp, buf, 0, buf.length, null);
      if (n <= 0) break;
      const enc = cipher.update(buf.subarray(0, n));
      if (enc.length > 0) writeSync(out, enc);
    }
    const finalEnc = cipher.final();
    if (finalEnc.length > 0) writeSync(out, finalEnc);
    writeSync(out, cipher.getAuthTag());
    fsyncSync(out);
    closeSync(out);
    out = -1;
    renameSync(tmp, encPath);
  } catch (err) {
    if (out >= 0) closeSync(out);
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    closeSync(inp);
    key.fill(0);
  }
}

/**
 * Read only the (plaintext, AAD-bound) header of an encrypted sidecar,
 * without decrypting the body. Returns null if the file is missing or not
 * a valid sidecar envelope. Cheap fixed-offset read used on the boot fast
 * path to compare the fingerprint before committing to a full decrypt.
 * Header integrity is verified later, when the body is decrypted (the
 * header is the GCM AAD), so a tampered header at worst causes a rebuild.
 */
export function readSidecarFingerprint(encPath: string): SidecarFingerprint | null {
  let fd: number;
  try {
    fd = openSync(encPath, "r");
  } catch {
    return null;
  }
  try {
    const magic = Buffer.alloc(MAGIC.length);
    if (readSync(fd, magic, 0, MAGIC.length, 0) !== MAGIC.length) return null;
    if (!magic.equals(MAGIC)) return null;
    const lenBuf = Buffer.alloc(4);
    if (readSync(fd, lenBuf, 0, 4, MAGIC.length) !== 4) return null;
    const headerLen = lenBuf.readUInt32BE(0);
    if (headerLen <= 0 || headerLen > 64 * 1024) return null;
    const headerBytes = Buffer.alloc(headerLen);
    if (readSync(fd, headerBytes, 0, headerLen, MAGIC.length + 4) !== headerLen) return null;
    const parsed = JSON.parse(headerBytes.toString("utf8")) as Partial<SidecarHeader>;
    if (
      parsed.omnesis !== "usearch-sidecar" ||
      parsed.version !== 1 ||
      typeof parsed.vectorWriteSeq !== "number" ||
      typeof parsed.embedModel !== "string" ||
      typeof parsed.embedDim !== "number"
    ) {
      return null;
    }
    return {
      vectorWriteSeq: parsed.vectorWriteSeq,
      embedModel: parsed.embedModel,
      embedDim: parsed.embedDim,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Decrypt `encPath` → `outPath` atomically (temp + fsync + rename).
 * Throws on a truncated envelope, a wrong key, or a GCM authentication
 * failure (tamper / torn ciphertext) — the caller treats any throw as
 * "inconsistent" and rebuilds from vectors. Synchronous + streaming; does
 * NOT load the graph into memory. `outPath` must differ from `encPath`.
 */
export function decryptSidecar(encPath: string, outPath: string, indexDbKey: Buffer): void {
  if (encPath === outPath) throw new Error("sidecar decrypt output must differ from input");
  const size = statSync(encPath).size;
  const fd = openSync(encPath, "r");
  let out = -1;
  const tmp = `${outPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let key: Buffer | null = null;
  try {
    const magic = Buffer.alloc(MAGIC.length);
    if (readSync(fd, magic, 0, MAGIC.length, 0) !== MAGIC.length || !magic.equals(MAGIC)) {
      throw new Error("not an omnesis usearch sidecar");
    }
    const lenBuf = Buffer.alloc(4);
    readSync(fd, lenBuf, 0, 4, MAGIC.length);
    const headerLen = lenBuf.readUInt32BE(0);
    const headerStart = MAGIC.length + 4;
    const bodyStart = headerStart + headerLen;
    if (bodyStart + TAG_BYTES > size) throw new Error("sidecar envelope truncated");
    const headerBytes = Buffer.alloc(headerLen);
    readSync(fd, headerBytes, 0, headerLen, headerStart);
    const header = JSON.parse(headerBytes.toString("utf8")) as SidecarHeader;
    const tag = Buffer.alloc(TAG_BYTES);
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);

    key = deriveKey(indexDbKey, Buffer.from(header.salt, "base64url"));
    const decipher = createDecipheriv(ALG, key, Buffer.from(header.iv, "base64url"), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);

    out = openSync(tmp, "w", 0o600);
    const cipherEnd = size - TAG_BYTES; // exclusive
    const buf = Buffer.alloc(STREAM_CHUNK);
    let pos = bodyStart;
    while (pos < cipherEnd) {
      const want = Math.min(buf.length, cipherEnd - pos);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) throw new Error("sidecar envelope truncated");
      const dec = decipher.update(buf.subarray(0, n));
      if (dec.length > 0) writeSync(out, dec);
      pos += n;
    }
    const finalDec = decipher.final(); // throws on auth failure
    if (finalDec.length > 0) writeSync(out, finalDec);
    fsyncSync(out);
    closeSync(out);
    out = -1;
    renameSync(tmp, outPath);
  } catch (err) {
    if (out >= 0) closeSync(out);
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    closeSync(fd);
    key?.fill(0);
  }
}

/** Best-effort unlink; ignores a missing file. */
export function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* file absent — fine */
  }
}

/**
 * Boot-time: materialise the active generation's plaintext working graph from
 * its encrypted sidecar, but ONLY when the fingerprint proves it is consistent
 * with `index.db`. On any mismatch / tamper / missing sidecar it leaves NO
 * plaintext file — so the indexer worker rebuilds the graph from
 * `chunks.embedding` (never a re-embed). Must run AFTER the plaintext purge and
 * BEFORE the worker spawns.
 */
export function restoreActiveSidecar(opts: {
  encPath: string;
  plaintextPath: string;
  indexDbKey: Buffer;
  expectedSeq: number;
  expectedModel: { name: string; dim: number } | null;
}): { restored: boolean; reason: string; seq?: number } {
  const fp = readSidecarFingerprint(opts.encPath);
  if (!fp) return { restored: false, reason: "no encrypted sidecar" };
  if (fp.vectorWriteSeq !== opts.expectedSeq) {
    return {
      restored: false,
      reason: `write-seq mismatch (sidecar=${fp.vectorWriteSeq} db=${opts.expectedSeq})`,
    };
  }
  if (
    opts.expectedModel &&
    (fp.embedModel !== opts.expectedModel.name || fp.embedDim !== opts.expectedModel.dim)
  ) {
    return {
      restored: false,
      reason: `embedder stamp mismatch (sidecar=${fp.embedModel}/${fp.embedDim} db=${opts.expectedModel.name}/${opts.expectedModel.dim})`,
    };
  }
  try {
    decryptSidecar(opts.encPath, opts.plaintextPath, opts.indexDbKey);
    return { restored: true, reason: "consistent", seq: fp.vectorWriteSeq };
  } catch (err) {
    // Tamper / torn ciphertext / wrong key. Drop the bad `.enc` so the next
    // boot doesn't retry the same failure; the worker rebuilds from vectors.
    tryUnlink(opts.encPath);
    return { restored: false, reason: `decrypt failed: ${(err as Error).message}` };
  }
}

/**
 * Remove leftover encrypt/decrypt temp files (`*.usearch*.tmp-*`) for every
 * generation in `dir`. These only appear after a hard-kill mid-operation; they
 * are harmless but should be swept at boot. The durable `.enc` is never
 * matched.
 */
export function purgeSidecarTemps(dir: string): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const rx = /^index(?:-\d+)?\.usearch(?:\.enc)?\..*tmp-.*$/;
  for (const name of entries) {
    if (rx.test(name)) {
      tryUnlink(join(dir, name));
      removed++;
    }
  }
  return removed;
}
