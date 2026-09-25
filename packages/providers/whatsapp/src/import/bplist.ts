// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { APPLE_EPOCH_OFFSET } from "./constants.js";

/**
 * Minimal binary-plist (`bplist00`) reader (#588). Covers exactly what the iOS
 * backup decrypt needs: reading `Manifest.plist` (BackupKeyBag / ManifestKey)
 * and walking the NSKeyedArchiver graph inside a Manifest.db `Files.file` BLOB
 * to extract `Size`, `ProtectionClass`, and the wrapped `EncryptionKey`.
 *
 * The parse is eager over the whole object graph, so it must understand every
 * value type a real backup carries even when the caller reads only a few keys —
 * Manifest.plist has a top-level `Date`, and `Files.file` blobs carry
 * `LastModified`/`Birth` NSDate fields. UIDs are returned as `{ UID: number }`,
 * data as `Buffer`, dates as `Date`, dicts as plain objects, arrays/sets as
 * arrays.
 *
 * Hand-rolled to avoid an unmaintained dependency and keep all backup-format
 * knowledge inside the provider.
 */

function readUIntBE(buf: Buffer, offset: number, size: number): number {
  if (size <= 6) return buf.readUIntBE(offset, size);
  if (size === 8) return Number(buf.readBigUInt64BE(offset));
  // 7-byte (and larger) widths don't occur in real backup offset tables/refs.
  throw new Error(`bplist ${size}-byte integer not supported`);
}

function decodeUtf16BE(buf: Buffer): string {
  const swapped = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString("utf16le");
}

/** Parse a `bplist00` buffer into a JS value. Throws a clear error on truncated/corrupt input. */
export function parseBplist(buf: Buffer): unknown {
  if (buf.length < 40 || buf.subarray(0, 8).toString("ascii") !== "bplist00") {
    throw new Error("Not a valid binary plist (missing bplist00 magic or truncated).");
  }
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer.readUInt8(6);
  const objectRefSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
  if (
    offsetSize < 1 ||
    objectRefSize < 1 ||
    topObject >= numObjects ||
    offsetTableOffset + numObjects * offsetSize > buf.length - 32
  ) {
    throw new Error("Corrupt or truncated binary plist (offset table out of range).");
  }

  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) {
    offsets.push(readUIntBE(buf, offsetTableOffset + i * offsetSize, offsetSize));
  }

  const parseObj = (idx: number): unknown => {
    let pos = offsets[idx];
    const marker = buf.readUInt8(pos);
    const type = marker & 0xf0;
    const info = marker & 0x0f;
    pos += 1;

    const readLength = (): number => {
      if (info !== 0x0f) return info;
      const intMarker = buf.readUInt8(pos);
      pos += 1;
      const intLen = 1 << (intMarker & 0x0f);
      const n = readUIntBE(buf, pos, intLen);
      pos += intLen;
      return n;
    };

    switch (type) {
      case 0x00:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x10: {
        const len = 1 << info;
        if (len > 8) throw new Error(`bplist ${len}-byte integer not supported`);
        return len <= 6 ? buf.readUIntBE(pos, len) : Number(buf.readBigUInt64BE(pos));
      }
      case 0x20: {
        const len = 1 << info;
        return len === 4 ? buf.readFloatBE(pos) : buf.readDoubleBE(pos);
      }
      case 0x30: {
        // Date: 8-byte big-endian IEEE-754 double, seconds since the Cocoa
        // epoch (2001-01-01 UTC). Marker is always 0x33 in practice.
        const seconds = buf.readDoubleBE(pos);
        return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
      }
      case 0x40: {
        const len = readLength();
        return Buffer.from(buf.subarray(pos, pos + len));
      }
      case 0x50: {
        const len = readLength();
        return buf.subarray(pos, pos + len).toString("ascii");
      }
      case 0x60: {
        const len = readLength();
        return decodeUtf16BE(buf.subarray(pos, pos + len * 2));
      }
      case 0x80: {
        const len = info + 1;
        return { UID: readUIntBE(buf, pos, len) };
      }
      case 0xa0:
      case 0xc0: {
        // Array (0xa0) and set (0xc0) share the same on-disk layout: `len`
        // object refs. We surface both as a JS array.
        const len = readLength();
        const arr: unknown[] = [];
        for (let k = 0; k < len; k++) {
          arr.push(parseObj(readUIntBE(buf, pos + k * objectRefSize, objectRefSize)));
        }
        return arr;
      }
      case 0xd0: {
        const len = readLength();
        const obj: Record<string, unknown> = {};
        for (let k = 0; k < len; k++) {
          const keyRef = readUIntBE(buf, pos + k * objectRefSize, objectRefSize);
          const valRef = readUIntBE(buf, pos + (len + k) * objectRefSize, objectRefSize);
          obj[String(parseObj(keyRef))] = parseObj(valRef);
        }
        return obj;
      }
      default:
        throw new Error(`Unsupported bplist marker 0x${marker.toString(16)}`);
    }
  };

  return parseObj(topObject);
}

interface UidRef {
  UID: number;
}
function isUid(v: unknown): v is UidRef {
  return typeof v === "object" && v !== null && typeof (v as UidRef).UID === "number";
}

/** Extracted protection metadata from a Manifest.db `Files.file` BLOB. */
export interface FileBlobInfo {
  size: number;
  protectionClass: number;
  /** 40-byte wrapped file key (the 4-byte LE class prefix already stripped). */
  wrappedKey: Buffer;
}

/**
 * Walk an NSKeyedArchiver `Files.file` BLOB and pull out Size, ProtectionClass,
 * and the wrapped EncryptionKey. Returns null when the file is unencrypted
 * (no EncryptionKey) — e.g. an empty/directory entry.
 */
export function parseFileBlob(blob: Buffer): FileBlobInfo | null {
  const plist = parseBplist(blob) as { $top?: { root?: unknown }; $objects?: unknown[] };
  const objects = plist.$objects;
  const root = plist.$top?.root;
  if (!Array.isArray(objects) || !isUid(root)) return null;

  const data = objects[root.UID] as Record<string, unknown> | undefined;
  if (!data) return null;

  const size = Number(data.Size ?? 0);
  const protectionClass = Number(data.ProtectionClass ?? 0);
  const encRef = data.EncryptionKey;
  if (!isUid(encRef)) return null; // unencrypted entry

  const encObj = objects[encRef.UID] as Record<string, unknown> | undefined;
  const nsData = encObj?.["NS.data"];
  if (!Buffer.isBuffer(nsData)) return null;

  // Strip the 4-byte little-endian protection-class prefix → 40-byte wrapped key.
  return { size, protectionClass, wrappedKey: nsData.subarray(4) };
}

function extractXmlData(xml: string, key: string): Buffer | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<data>([\\s\\S]*?)</data>`);
  const m = re.exec(xml);
  if (!m) return undefined;
  return Buffer.from(m[1].replace(/\s+/g, ""), "base64");
}

/** Read `Manifest.plist` (binary or XML) → the keybag blob and the ManifestKey. */
export function readManifestPlist(buf: Buffer): { backupKeyBag: Buffer; manifestKey?: Buffer } {
  if (buf.subarray(0, 8).toString("ascii") === "bplist00") {
    const p = parseBplist(buf) as Record<string, unknown>;
    const bkb = p.BackupKeyBag;
    const mk = p.ManifestKey;
    if (!Buffer.isBuffer(bkb))
      throw new Error("Manifest.plist has no BackupKeyBag (not encrypted?)");
    return { backupKeyBag: bkb, manifestKey: Buffer.isBuffer(mk) ? mk : undefined };
  }
  const xml = buf.toString("utf8");
  const bkb = extractXmlData(xml, "BackupKeyBag");
  if (!bkb) throw new Error("Manifest.plist has no BackupKeyBag (not encrypted?)");
  return { backupKeyBag: bkb, manifestKey: extractXmlData(xml, "ManifestKey") };
}
