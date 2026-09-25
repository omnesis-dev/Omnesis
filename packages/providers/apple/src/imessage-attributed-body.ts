// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Extract plain text from an iMessage attributedBody BLOB.
 *
 * The blob is a typedstream (old-style NSArchiver) containing an NSAttributedString.
 * The text content appears after an "NSString" class marker followed by a 0x2b byte
 * and a length-encoded UTF-8 string.
 *
 * Length encoding:
 * - If the byte after 0x2b is < 0x80: it is the length directly
 * - If the byte is 0x81: the next 2 bytes are a big-endian 16-bit length
 * - If the byte is 0x82: the next 3 bytes are a big-endian 24-bit length (rare)
 * - If the byte is 0x83: the next 4 bytes are a big-endian 32-bit length (very rare)
 */
export function parseAttributedBody(blob: Buffer | Uint8Array): string | null {
  if (!blob || blob.length === 0) return null;

  // Ensure we have a Buffer for indexOf and subarray operations
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);

  try {
    // Find "NSString" marker in the blob
    const nsStringMarker = Buffer.from("NSString");
    const markerIdx = buf.indexOf(nsStringMarker);
    if (markerIdx === -1) return null;

    // Find the 0x2b byte after the marker (it's the string content indicator)
    const searchStart = markerIdx + nsStringMarker.length;
    let pos = -1;
    for (let i = searchStart; i < Math.min(searchStart + 30, buf.length); i++) {
      if (buf[i] === 0x2b) {
        pos = i;
        break;
      }
    }
    if (pos === -1) return null;

    // Read length
    pos++; // move past 0x2b
    const lenIndicator = buf[pos];
    let textLen: number;
    let textStart: number;

    if (lenIndicator < 0x80) {
      // Single-byte length
      textLen = lenIndicator;
      textStart = pos + 1;
    } else if (lenIndicator === 0x81) {
      // 2-byte big-endian length
      textLen = (buf[pos + 1] << 8) | buf[pos + 2];
      textStart = pos + 3;
    } else if (lenIndicator === 0x82) {
      // 3-byte big-endian length
      textLen = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
      textStart = pos + 4;
    } else if (lenIndicator === 0x83) {
      // 4-byte big-endian length
      textLen = (buf[pos + 1] << 24) | (buf[pos + 2] << 16) | (buf[pos + 3] << 8) | buf[pos + 4];
      textStart = pos + 5;
    } else {
      return null;
    }

    if (textLen <= 0 || textStart + textLen > buf.length) return null;

    const text = buf.subarray(textStart, textStart + textLen).toString("utf-8");
    return text.trim() || null;
  } catch {
    return null;
  }
}
