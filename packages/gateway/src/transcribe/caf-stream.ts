// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Put a CAF packet table before its audio data for a non-seekable decoder.
 * CAF permits the table after the data; ffmpeg cannot seek ahead to read it
 * on stdin. Move only the table, preserving every chunk and audio byte, and
 * keep recordings in memory. Unknown/truncated layouts go to the decoder
 * unchanged so it owns format errors.
 */
export function streamableCaf(bytes: Uint8Array): Uint8Array {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (input.length < 8 || input.toString("ascii", 0, 4) !== "caff" || input.readUInt16BE(4) !== 1) {
    return bytes;
  }
  let dataOffset: number | undefined;
  let table: { start: number; end: number } | undefined;
  let offset = 8;
  while (offset < input.length) {
    if (input.length - offset < 12) return bytes;
    const size = input.readBigInt64BE(offset + 4);
    if (size < 0 || size > BigInt(input.length - offset - 12)) return bytes;
    const end = offset + 12 + Number(size);
    const kind = input.toString("ascii", offset, offset + 4);
    if (kind === "data") {
      if (dataOffset !== undefined) return bytes;
      dataOffset = offset;
    } else if (kind === "pakt") {
      if (table) return bytes;
      table = { start: offset, end };
    }
    offset = end;
  }
  if (dataOffset === undefined || !table || table.start < dataOffset) return bytes;
  return Buffer.concat([
    input.subarray(0, dataOffset),
    input.subarray(table.start, table.end),
    input.subarray(dataOffset, table.start),
    input.subarray(table.end),
  ]);
}
