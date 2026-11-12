// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { clientHelloHostname, MAX_CLIENT_HELLO_BYTES } from "./client-hello.js";

const short = (value: number): Buffer => Buffer.from([value >> 8, value & 255]);
const extension = (type: number, data: Buffer): Buffer =>
  Buffer.concat([short(type), short(data.length), data]);
const sni = (hostname: string): Buffer => {
  const name = Buffer.from(hostname);
  return extension(
    0,
    Buffer.concat([short(name.length + 3), Buffer.from([0]), short(name.length), name]),
  );
};
const body = (extensions = sni("gateway.example.test")): Buffer =>
  Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 17),
    Buffer.from([0]),
    short(2),
    Buffer.from([0x13, 1, 1, 0]),
    short(extensions.length),
    extensions,
  ]);
const record = (data: Buffer): Buffer =>
  Buffer.concat([Buffer.from([22, 3, 1]), short(data.length), data]);
const handshake = (data: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([1, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]),
    data,
  ]);

describe("bounded TLS ClientHello routing", () => {
  test("waits for every possible split without changing the handshake", () => {
    const packet = record(handshake(body()));
    for (let i = 0; i < packet.length; i++)
      expect(clientHelloHostname(packet.subarray(0, i))).toBeUndefined();
    expect(clientHelloHostname(packet)).toBe("gateway.example.test");
    expect(
      clientHelloHostname(Buffer.concat([packet, Buffer.from("following encrypted records")])),
    ).toBe("gateway.example.test");
  });
  test("accepts handshake fragmentation across TLS records, including its length prefix", () => {
    const data = handshake(
      body(Buffer.concat([extension(16, Buffer.from([0])), sni("GATEWAY.Example.Test")])),
    );
    for (let i = 1; i < data.length; i++) {
      const first = record(data.subarray(0, i));
      expect(clientHelloHostname(first)).toBeUndefined();
      expect(clientHelloHostname(Buffer.concat([first, record(data.subarray(i))]))).toBe(
        "gateway.example.test",
      );
    }
  });
  test.each([
    Buffer.alloc(MAX_CLIENT_HELLO_BYTES + 1),
    Buffer.from("GET /mcp HTTP/1.1\r\n"),
    Buffer.from([22, 2, 1, 0, 1, 0]),
    Buffer.from([22, 3, 1, 0, 0]),
    Buffer.from([22, 3, 1, 255, 255]),
    record(Buffer.from([2, 0, 0, 0])),
    record(Buffer.from([1, 1, 0, 0])),
  ])("refuses non-TLS, oversized and wrong handshake records", (input) => {
    expect(() => clientHelloHostname(input)).toThrow();
  });
  test.each([
    Buffer.alloc(0),
    Buffer.alloc(34),
    Buffer.concat([Buffer.alloc(34), Buffer.from([255])]),
    (() => {
      const value = body();
      value.writeUInt16BE(0, 35);
      return value;
    })(),
    (() => {
      const value = body();
      value.writeUInt16BE(3, 35);
      return value;
    })(),
    (() => {
      const value = body();
      value.writeUInt16BE(1000, 35);
      return value;
    })(),
    (() => {
      const value = body();
      value[39] = 255;
      return value;
    })(),
    (() => {
      const value = body();
      value.writeUInt16BE(1, 41);
      return value;
    })(),
    body(Buffer.alloc(0)),
    body(Buffer.concat([sni("one.example.test"), sni("two.example.test")])),
    body(extension(0, Buffer.alloc(4))),
    body(extension(0, Buffer.alloc(5))),
    body(extension(0, Buffer.from([0, 3, 1, 0, 0]))),
    body(extension(0, Buffer.from([0, 3, 0, 0, 1]))),
    body(Buffer.from([0, 0, 0, 10])),
    body(sni("a")),
    body(sni("-bad.example.test")),
    body(sni("bad_.example.test")),
    body(sni("bad..test")),
    body(sni("x".repeat(64) + ".test")),
    body(sni("a.".repeat(128) + "test")),
    body(extension(0, Buffer.from([0, 6, 0, 0, 3, 0xff, 46, 97]))),
  ])("refuses malformed or ambiguous ClientHello structures", (input) => {
    expect(() => clientHelloHostname(record(handshake(input)))).toThrow();
  });
});

test("refuses excessive record fragmentation before a declared handshake can allocate more work", () => {
  const declared = Buffer.concat([Buffer.from([1, 0, 1, 0]), Buffer.alloc(61)]);
  const fragments = [...declared].map((byte) => record(Buffer.from([byte])));
  expect(clientHelloHostname(Buffer.concat(fragments.slice(0, 64)))).toBeUndefined();
  expect(() => clientHelloHostname(Buffer.concat(fragments))).toThrow(
    "Too many ClientHello fragments",
  );
});
