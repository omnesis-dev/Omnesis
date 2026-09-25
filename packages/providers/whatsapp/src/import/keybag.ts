// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { RFC3394_IV, WRAP_PASSPHRASE } from "./constants.js";

/**
 * iOS backup keybag parsing + the passphrase-key derivation and RFC-3394 AES
 * key (un)wrap. Pure and self-contained so it is unit-testable against the
 * published RFC vectors, independent of any real backup. (#588)
 *
 * Format + algorithm ported from jsharkey13/iphone_backup_decrypt
 * (google_iphone_dataprotection.py). The keybag is a flat TLV stream; class-key
 * entries are delimited only by a recurring `UUID` tag, not by length.
 */

/** A single protection-class key entry from the keybag. */
export interface ClassKey {
  /** Protection class number (CLAS). */
  clas: number;
  /** Wrap flags — `(wrap & 2)` means passphrase-wrapped (unwrappable off-device). */
  wrap: number;
  /** The 40-byte wrapped key (WPKY). */
  wrapped: Buffer;
  /** The 32-byte unwrapped key, filled in by {@link unwrapClassKeys}. */
  key?: Buffer;
}

export interface Keybag {
  /** Keybag-level scalar attributes (SALT, ITER, DPSL, DPIC, …) by tag. */
  attrs: Record<string, Buffer>;
  /** Protection-class keys, indexed by class number. */
  classKeys: Map<number, ClassKey>;
}

const CLASS_TAGS = new Set(["CLAS", "WRAP", "WPKY", "KTYP", "PBKY"]);

/**
 * Parse the raw `BackupKeyBag` TLV blob into keybag-level attrs + per-class keys.
 */
export function parseKeybag(blob: Buffer): Keybag {
  const attrs: Record<string, Buffer> = {};
  const classKeys = new Map<number, ClassKey>();

  let current: Partial<Record<string, Buffer>> | null = null;
  const flush = () => {
    if (!current || current.CLAS === undefined) return;
    const clas = current.CLAS.readUInt32BE(0);
    classKeys.set(clas, {
      clas,
      wrap: current.WRAP ? current.WRAP.readUInt32BE(0) : 0,
      wrapped: current.WPKY ?? Buffer.alloc(0),
    });
  };

  let i = 0;
  while (i + 8 <= blob.length) {
    const tag = blob.subarray(i, i + 4).toString("ascii");
    const len = blob.readUInt32BE(i + 4);
    const data = blob.subarray(i + 8, i + 8 + len);
    i += 8 + len;

    if (tag === "UUID") {
      // A recurring UUID starts a new class-key entry. The first UUID is the
      // keybag's own; treat it as the start of entry collection regardless —
      // a keybag-level entry with no CLAS simply never flushes.
      flush();
      current = {};
      continue;
    }
    if (current && CLASS_TAGS.has(tag)) {
      current[tag] = data;
      continue;
    }
    // Keybag-level scalar (SALT/ITER/DPSL/DPIC/HMCK/VERS/TYPE/WRAP before any
    // class entry). A pre-UUID WRAP is the keybag-level default; ignore for our
    // purposes (we only unwrap entries whose own WRAP has bit 2).
    attrs[tag] = data;
  }
  flush();

  return { attrs, classKeys };
}

/**
 * Derive the passphrase key (KEK) via the double PBKDF2 Apple uses for iOS
 * 10.2+ backups: PBKDF2-SHA256(password, DPSL, DPIC) → PBKDF2-SHA1(that, SALT, ITER).
 */
export function derivePassphraseKey(password: string, attrs: Record<string, Buffer>): Buffer {
  const { DPSL, DPIC, SALT, ITER } = attrs;
  if (!DPSL || !DPIC || !SALT || !ITER) {
    throw new Error("Backup keybag is missing DPSL/DPIC/SALT/ITER — unsupported backup format");
  }
  const round1 = pbkdf2Sync(
    Buffer.from(password, "utf8"),
    DPSL,
    DPIC.readUInt32BE(0),
    32,
    "sha256",
  );
  return pbkdf2Sync(round1, SALT, ITER.readUInt32BE(0), 32, "sha1");
}

/** RFC 3394 AES-256 key unwrap. Throws on integrity failure (= wrong passphrase). */
export function aesUnwrap(kek: Buffer, wrapped: Buffer): Buffer {
  const d = createDecipheriv("aes256-wrap", kek, RFC3394_IV);
  return Buffer.concat([d.update(wrapped), d.final()]);
}

/** RFC 3394 AES-256 key wrap. Used only by the synthetic test-fixture builder. */
export function aesWrap(kek: Buffer, key: Buffer): Buffer {
  const c = createCipheriv("aes256-wrap", kek, RFC3394_IV);
  return Buffer.concat([c.update(key), c.final()]);
}

/**
 * Unwrap every passphrase-wrapped class key in place with the derived KEK.
 * Device-only classes (without `WRAP & 2`) are left without a `key`. Throws if
 * the passphrase is wrong (the first unwrap fails its integrity check).
 */
export function unwrapClassKeys(keybag: Keybag, passphraseKey: Buffer): void {
  for (const ck of keybag.classKeys.values()) {
    if ((ck.wrap & WRAP_PASSPHRASE) === 0) continue;
    ck.key = aesUnwrap(passphraseKey, ck.wrapped);
  }
}
