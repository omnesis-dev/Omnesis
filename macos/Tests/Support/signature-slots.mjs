// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
const KEYS = ["com.apple.application-identifier", "com.apple.developer.team-identifier"];
function within(offset, length, end) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > end
  )
    throw new Error("Generated runner signature has invalid bounds");
}
/** Diagnostic only, never used to grant trust or change product signatures. */
export function inspectMachOEntitlementSlots(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024)
    throw new Error("Unexpected generated runner size");
  within(0, 4, bytes.length);
  const magic = bytes.readUInt32BE(0);
  const slices = [];
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    within(0, 8, bytes.length);
    const count = bytes.readUInt32BE(4);
    const width = magic === 0xcafebabf ? 32 : 20;
    if (!count || count > 32) throw new Error("Invalid generated runner architecture count");
    within(8, count * width, bytes.length);
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * width;
      const offset =
        width === 32 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8);
      const size =
        width === 32 ? Number(bytes.readBigUInt64BE(entry + 16)) : bytes.readUInt32BE(entry + 12);
      within(offset, size, bytes.length);
      slices.push(bytes.subarray(offset, offset + size));
    }
  } else slices.push(bytes);
  return slices.map((slice) => {
    within(0, 28, slice.length);
    const value = slice.readUInt32LE(0);
    const little = value === 0xfeedfacf || value === 0xfeedface;
    if (!little && value !== 0xcffaedfe && value !== 0xcefaedfe)
      throw new Error("Generated runner is not Mach-O");
    const read = (offset) => (little ? slice.readUInt32LE(offset) : slice.readUInt32BE(offset));
    const header = value === 0xfeedfacf || value === 0xcffaedfe ? 32 : 28;
    const count = read(16);
    const end = header + read(20);
    within(header, end - header, slice.length);
    if (count > 4096) throw new Error("Invalid runner load-command count");
    let command = header;
    let signature;
    for (let index = 0; index < count; index++) {
      within(command, 8, end);
      const kind = read(command),
        length = read(command + 4);
      if (length < 8) throw new Error("Invalid runner load-command length");
      within(command, length, end);
      if (kind === 0x1d) {
        if (signature || length < 16) throw new Error("Invalid runner signature command");
        const offset = read(command + 8),
          size = read(command + 12);
        within(offset, size, slice.length);
        signature = slice.subarray(offset, offset + size);
      }
      command += length;
    }
    if (!signature) throw new Error("Generated runner signature is missing");
    within(0, 12, signature.length);
    if (signature.readUInt32BE(0) !== 0xfade0cc0)
      throw new Error("Invalid runner signature container");
    const length = signature.readUInt32BE(4),
      entries = signature.readUInt32BE(8);
    within(0, length, signature.length);
    if (entries > 64) throw new Error("Invalid runner signature slot count");
    within(12, entries * 8, length);
    const slots = [];
    for (let index = 0; index < entries; index++) {
      const slot = signature.readUInt32BE(12 + index * 8),
        offset = signature.readUInt32BE(16 + index * 8);
      within(offset, 8, length);
      const size = signature.readUInt32BE(offset + 4);
      if (size < 8) throw new Error("Invalid runner signature slot");
      within(offset, size, length);
      if (slot !== 5 && slot !== 7) continue;
      const payload = signature.subarray(offset + 8, offset + size);
      if (payload.length > 64 * 1024)
        throw new Error("Generated runner entitlement slot is too large");
      slots.push({
        slot,
        format: slot === 5 ? "xml" : "der",
        sha256: createHash("sha256").update(payload).digest("hex"),
        restrictedKeyBytes: KEYS.filter((key) => payload.includes(Buffer.from(key))),
        payloadBase64: payload.toString("base64"),
      });
    }
    return { cpuType: read(4), slots };
  });
}
