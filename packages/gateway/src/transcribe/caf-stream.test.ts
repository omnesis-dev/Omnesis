// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { streamableCaf } from "./caf-stream.js";

const header = Buffer.from("6361666600010000", "hex");
function chunk(kind: string, body: Buffer): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.write(kind);
  prefix.writeBigInt64BE(BigInt(body.length), 4);
  return Buffer.concat([prefix, body]);
}
const desc = chunk("desc", Buffer.alloc(32));
const data = chunk("data", Buffer.from([0, 0, 0, 0, 7, 8, 9]));
const pakt = chunk("pakt", Buffer.alloc(24));
const info = chunk("info", Buffer.from("synthetic"));

describe("streamableCaf", () => {
  test("moves the trailing packet table before data without losing chunks or mutating input", () => {
    const bytes = Buffer.concat([header, desc, data, info, pakt]);
    const before = Buffer.from(bytes);
    expect(streamableCaf(bytes)).toEqual(Buffer.concat([header, desc, pakt, data, info]));
    expect(bytes).toEqual(before);
    // A view into a larger allocation must not include its neighbors.
    const padded = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(3)]);
    expect(streamableCaf(padded.subarray(7, -3))).toEqual(streamableCaf(bytes));
  });

  test.each([
    Buffer.from("not CAF"),
    Buffer.concat([header, desc, pakt, data]),
    Buffer.concat([header, desc, data]),
    Buffer.concat([header, desc, data, pakt, pakt]),
    Buffer.concat([header, desc, data, data, pakt]),
    Buffer.concat([header, desc, data, pakt.subarray(0, -1)]),
    Buffer.concat([header, desc, data, pakt, Buffer.alloc(1)]),
  ])("leaves unsupported or already streamable input unchanged (%#)", (bytes) => {
    expect(streamableCaf(bytes)).toBe(bytes);
  });

  test.each([-1n, 0x7fffffffffffffffn])("does not traverse unbounded chunk sizes (%s)", (size) => {
    const bytes = Buffer.concat([header, desc, data, pakt]);
    bytes.writeBigInt64BE(size, header.length + desc.length + 4);
    expect(streamableCaf(bytes)).toBe(bytes);
  });
});
