// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { inspectMachOEntitlementSlots } from "../../macos/Tests/Support/signature-slots.mjs";
const restricted = "com.apple.application-identifier";
function thin(xml, der) {
  const blobs = [xml, der].map((payload, index) => {
    const body = Buffer.from(payload);
    const blob = Buffer.alloc(8 + body.length);
    blob.writeUInt32BE(index === 0 ? 0xfade7171 : 0xfade7172, 0);
    blob.writeUInt32BE(blob.length, 4);
    body.copy(blob, 8);
    return blob;
  });
  const signature = Buffer.alloc(28 + blobs[0].length + blobs[1].length);
  signature.writeUInt32BE(0xfade0cc0, 0);
  signature.writeUInt32BE(signature.length, 4);
  signature.writeUInt32BE(2, 8);
  let next = 28;
  for (let index = 0; index < 2; index++) {
    signature.writeUInt32BE(index === 0 ? 5 : 7, 12 + index * 8);
    signature.writeUInt32BE(next, 16 + index * 8);
    blobs[index].copy(signature, next);
    next += blobs[index].length;
  }
  const header = Buffer.alloc(48);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x100000c, 4);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(16, 20);
  header.writeUInt32LE(0x1d, 32);
  header.writeUInt32LE(16, 36);
  header.writeUInt32LE(48, 40);
  header.writeUInt32LE(signature.length, 44);
  return Buffer.concat([header, signature]);
}
test("extracts both entitlement representations without trusting one instead of the other", () => {
  const result = inspectMachOEntitlementSlots(
    thin("<plist>safe</plist>", "safe encoded dictionary"),
  );
  expect(result).toHaveLength(1);
  expect(result[0].slots.map((s) => [s.slot, s.format, s.restrictedKeyBytes])).toEqual([
    [5, "xml", []],
    [7, "der", []],
  ]);
  expect(Buffer.from(result[0].slots[0].payloadBase64, "base64").toString()).toBe(
    "<plist>safe</plist>",
  );
});
test("detects a stale restricted key in DER despite a reduced XML slot", () => {
  const [result] = inspectMachOEntitlementSlots(thin("<plist>safe</plist>", restricted));
  expect(result.slots[0].restrictedKeyBytes).toEqual([]);
  expect(result.slots[1].restrictedKeyBytes).toEqual([restricted]);
});
test("architecture offsets remain relative to their slice in a universal binary", () => {
  const code = thin(restricted, "safe");
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(0x100000c, 8);
  header.writeUInt32BE(64, 16);
  header.writeUInt32BE(code.length, 20);
  expect(
    inspectMachOEntitlementSlots(Buffer.concat([header, code]))[0].slots[0].restrictedKeyBytes,
  ).toEqual([restricted]);
});
test("truncated or escaping commands and signature slots refuse bounded parsing", () => {
  const code = thin("safe", "safe");
  const command = Buffer.from(code);
  command.writeUInt32LE(0xffffffff, 40);
  const slot = Buffer.from(code);
  slot.writeUInt32BE(0xffffffff, 48 + 16);
  for (const value of [Buffer.alloc(2), code.subarray(0, 40), command, slot])
    expect(() => inspectMachOEntitlementSlots(value)).toThrow();
});
