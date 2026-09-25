// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { parseBplist, parseFileBlob } from "./bplist.js";
import { writeBplist } from "./testing/make-backup.js";

describe("bplist reader (#588)", () => {
  it("round-trips dicts, arrays, strings, ints, data, and UIDs", () => {
    const tree = {
      $top: { root: { __uid: 1 } },
      $objects: ["$null", { Size: 42, ProtectionClass: 3 }, [1, 2, 3]],
      blob: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    };
    const parsed = parseBplist(writeBplist(tree)) as Record<string, unknown>;
    expect(parsed.$top).toEqual({ root: { UID: 1 } });
    expect((parsed.$objects as unknown[])[1]).toEqual({ Size: 42, ProtectionClass: 3 });
    expect(parsed.blob).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it("parses the NSDate marker (0x33) as a JS Date in the Cocoa epoch", () => {
    const when = new Date("2024-01-01T00:00:00.000Z");
    const parsed = parseBplist(writeBplist({ Date: when })) as { Date: Date };
    expect(parsed.Date).toBeInstanceOf(Date);
    expect(parsed.Date.getTime()).toBe(when.getTime());
  });

  it("parses a set (marker 0xc0) the same as an array", () => {
    // writeBplist only emits arrays, so hand-craft a bplist whose top object is
    // a set of two ints: obj0 = set(refs 1,2), obj1 = int 7, obj2 = int 9.
    const b = Buffer.alloc(80);
    let q = b.write("bplist00", 0, "ascii");
    const o0 = q;
    b[q++] = 0xc2; // set, 2 elements
    b[q++] = 0x01; // ref → obj 1
    b[q++] = 0x02; // ref → obj 2
    const o1 = q;
    b[q++] = 0x10; // int, 1 byte
    b[q++] = 0x07; // 7
    const o2 = q;
    b[q++] = 0x10; // int, 1 byte
    b[q++] = 0x09; // 9
    const tableOff = q;
    b[q++] = o0;
    b[q++] = o1;
    b[q++] = o2;
    const trailer = Buffer.alloc(32);
    trailer.writeUInt8(1, 6); // offsetSize
    trailer.writeUInt8(1, 7); // objectRefSize
    trailer.writeBigUInt64BE(3n, 8); // numObjects
    trailer.writeBigUInt64BE(0n, 16); // topObject
    trailer.writeBigUInt64BE(BigInt(tableOff), 24);
    const full = Buffer.concat([b.subarray(0, q), trailer]);
    expect(parseBplist(full)).toEqual([7, 9]);
  });

  it("extracts Size / ProtectionClass / wrapped key from an NSKeyedArchiver file BLOB", () => {
    const wrapped = Buffer.alloc(40, 0x11);
    const blob = writeBplist({
      $top: { root: { __uid: 1 } },
      $objects: [
        "$null",
        { Size: 1234, ProtectionClass: 3, EncryptionKey: { __uid: 2 } },
        { "NS.data": Buffer.concat([Buffer.from([3, 0, 0, 0]), wrapped]) },
      ],
    });
    const info = parseFileBlob(blob);
    expect(info?.size).toBe(1234);
    expect(info?.protectionClass).toBe(3);
    expect(info?.wrappedKey.equals(wrapped)).toBe(true); // 4-byte LE prefix stripped
  });

  it("throws a clear error on a truncated/corrupt buffer (not a raw RangeError)", () => {
    expect(() => parseBplist(Buffer.from("bplist00"))).toThrow(/binary plist/i);
    // Valid magic + trailer but an out-of-range offset table.
    const bad = Buffer.alloc(40);
    bad.write("bplist00", 0, "ascii");
    bad.writeUInt8(1, 40 - 32 + 6); // offsetSize
    bad.writeUInt8(1, 40 - 32 + 7); // objectRefSize
    bad.writeBigUInt64BE(1n, 40 - 32 + 8); // numObjects
    bad.writeBigUInt64BE(0n, 40 - 32 + 16); // topObject
    bad.writeBigUInt64BE(9999n, 40 - 32 + 24); // offsetTableOffset (out of range)
    expect(() => parseBplist(bad)).toThrow(/out of range|truncated|corrupt/i);
  });
});
