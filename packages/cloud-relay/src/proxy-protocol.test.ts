// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { addIpv6Loopback } from "../test/loopback-peers.js";
import {
  acceptProxyProtocol,
  connectionClientAddress,
  MAX_PROXY_HEADER_BYTES,
  parseProxyHeader,
  ProxyProtocolPeers,
} from "./proxy-protocol.js";

const SIGNATURE = Buffer.from("0d0a0d0a000d0a515549540a", "hex");

/** A v2 header: version/command byte, family/transport byte and the address block. */
function v2(versionCommand: number, familyTransport: number, block: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(block.length);
  return Buffer.concat([SIGNATURE, Buffer.from([versionCommand, familyTransport]), length, block]);
}

const ports = (source: number, destination: number) => {
  const value = Buffer.alloc(4);
  value.writeUInt16BE(source);
  value.writeUInt16BE(destination, 2);
  return value;
};
const ipv4 = (address: string) => Buffer.from(address.split(".").map(Number));
const ipv6 = (hex: string) => Buffer.from(hex.padStart(32, "0"), "hex");

/** TCP over IPv4 from `source`, with any TLVs appended. */
const proxyV4 = (source: string, tlvs = Buffer.alloc(0)) =>
  v2(0x21, 0x11, Buffer.concat([ipv4(source), ipv4("192.0.2.1"), ports(50_000, 443), tlvs]));
/** TCP over IPv6 from the 32-hex-digit `source`. */
const proxyV6 = (source: string) =>
  v2(0x21, 0x21, Buffer.concat([ipv6(source), ipv6("1"), ports(50_000, 443)]));

describe("PROXY protocol v2 headers", () => {
  test("an IPv4 header names its source, and every shorter prefix asks for more bytes", () => {
    const header = proxyV4("203.0.113.7");
    for (let length = 0; length < header.length; length++)
      expect(parseProxyHeader(header.subarray(0, length))).toBeUndefined();
    expect(parseProxyHeader(header)).toEqual({ length: 28, source: "203.0.113.7" });
    // The client's own bytes after it are not part of the header.
    expect(parseProxyHeader(Buffer.concat([header, Buffer.from([0x16, 3, 1])]))).toEqual({
      length: 28,
      source: "203.0.113.7",
    });
  });

  test("an IPv6 header names its source in canonical form, and TLVs are skipped", () => {
    expect(parseProxyHeader(proxyV6("20010db8000000000000000000000007"))).toEqual({
      length: 52,
      source: "2001:db8::7",
    });
    expect(parseProxyHeader(proxyV6("00000000000000000000ffffcb007109"))).toEqual({
      length: 52,
      source: "::ffff:203.0.113.9",
    });
    const tlv = Buffer.from([0x04, 0x00, 0x03, 0x00, 0x00, 0x00]); // PP2_TYPE_NOOP
    expect(parseProxyHeader(proxyV4("198.51.100.2", tlv))).toEqual({
      length: 34,
      source: "198.51.100.2",
    });
  });

  test("LOCAL and unspecified families carry no client address, so the peer stands for it", () => {
    expect(parseProxyHeader(v2(0x20, 0x00, Buffer.alloc(0)))).toEqual({ length: 16 });
    // LOCAL ignores whatever address block it carries.
    expect(parseProxyHeader(v2(0x20, 0x11, proxyV4("203.0.113.7").subarray(16)))).toEqual({
      length: 28,
    });
    expect(parseProxyHeader(v2(0x21, 0x00, Buffer.alloc(0)))).toEqual({ length: 16 });
  });

  test("other versions, commands, transports and truncated or oversized headers are refused", () => {
    const block = proxyV4("203.0.113.7").subarray(16);
    for (const header of [
      v2(0x11, 0x11, block), // version 1 in a binary header
      v2(0x22, 0x11, block), // an unknown command
      v2(0x21, 0x12, block), // UDP over IPv4
      v2(0x21, 0x31, Buffer.alloc(216)), // a Unix socket
      v2(0x21, 0x41, block), // an unknown family
      v2(0x21, 0x11, block.subarray(0, 8)), // IPv4 addresses cut short
      v2(0x21, 0x21, block), // IPv6 with an IPv4-sized block
      v2(0x21, 0x11, Buffer.alloc(MAX_PROXY_HEADER_BYTES - 15)), // one byte over the bound
    ])
      expect(() => parseProxyHeader(header)).toThrow();
    // The size bound is decided from the length field, before the bytes arrive.
    expect(() => parseProxyHeader(v2(0x21, 0x11, Buffer.alloc(60_000)).subarray(0, 16))).toThrow(
      "too large",
    );
    expect(parseProxyHeader(v2(0x21, 0x11, Buffer.alloc(MAX_PROXY_HEADER_BYTES - 16)))).toEqual({
      length: MAX_PROXY_HEADER_BYTES,
      source: "0.0.0.0",
    });
  });
});

describe("PROXY protocol v1 lines", () => {
  test("TCP4, TCP6 and UNKNOWN lines are read, and an unfinished line asks for more", () => {
    const line = Buffer.from("PROXY TCP4 198.51.100.1 192.0.2.1 50000 443\r\nGET");
    expect(parseProxyHeader(line)).toEqual({ length: 45, source: "198.51.100.1" });
    for (let length = 0; length < 45; length++)
      expect(parseProxyHeader(line.subarray(0, length))).toBeUndefined();
    expect(
      parseProxyHeader(Buffer.from("PROXY TCP6 2001:0db8::0001 2001:db8::2 0 65535\r\n")),
    ).toEqual({ length: 48, source: "2001:db8::1" });
    expect(parseProxyHeader(Buffer.from("PROXY UNKNOWN anything at all\r\n"))).toEqual({
      length: 31,
    });
  });

  test("malformed fields and a line past the length limit are refused", () => {
    for (const text of [
      "PROXY TCP5 198.51.100.1 192.0.2.1 1 2\r\n",
      "PROXY TCP4 2001:db8::1 192.0.2.1 1 2\r\n",
      "PROXY TCP4 198.51.100.1 2001:db8::1 1 2\r\n",
      "PROXY TCP6 198.51.100.1 2001:db8::1 1 2\r\n",
      "PROXY TCP4 198.51.100.1 192.0.2.1 65536 2\r\n",
      "PROXY TCP4 198.51.100.1 192.0.2.1 1 012\r\n",
      "PROXY TCP4 198.51.100.1 192.0.2.1 1\r\n",
      "PROXY TCP4 198.51.100.1 192.0.2.1 1 2 3\r\n",
      "PROXY TCP4  198.51.100.1 192.0.2.1 1 2\r\n",
    ])
      expect(() => parseProxyHeader(Buffer.from(text)), text).toThrow();
    expect(() => parseProxyHeader(Buffer.from(`PROXY UNKNOWN ${"x".repeat(100)}`))).toThrow(
      "too long",
    );
    expect(parseProxyHeader(Buffer.from(`PROXY UNKNOWN ${"x".repeat(90)}`))).toBeUndefined();
  });

  test("bytes that cannot begin either header are refused at once", () => {
    for (const bytes of [
      Buffer.from("GET / HTTP/1.1\r\n"),
      Buffer.from([0x16, 0x03, 0x01]),
      Buffer.from("PROXX"),
      Buffer.from("\r\n\r\n\0\r\nQUIX"),
    ])
      expect(() => parseProxyHeader(bytes)).toThrow("Not a PROXY protocol header");
    expect(parseProxyHeader(Buffer.from("\r\n\r"))).toBeUndefined();
    expect(parseProxyHeader(Buffer.from("PRO"))).toBeUndefined();
  });
});

describe("trusted front-layer peers", () => {
  test("exact addresses and ranges of both families match, IPv4-mapped peers included", () => {
    expect(ProxyProtocolPeers.parse(undefined)).toBeUndefined();
    const peers = ProxyProtocolPeers.parse(
      "203.0.113.7, 192.0.2.128/25,2001:db8:5::/48 , ::ffff:198.51.100.9,2001:db8::1",
    )!;
    for (const address of [
      "203.0.113.7",
      "::ffff:203.0.113.7",
      "192.0.2.200",
      "2001:db8:5:ffff::1",
      "198.51.100.9",
      "2001:db8::1",
    ])
      expect(peers.has(address), address).toBe(true);
    for (const address of [
      undefined,
      "",
      "203.0.113.8",
      "192.0.2.127",
      "2001:db8:6::1",
      "2001:db8::2",
      "127.0.0.1",
    ])
      expect(peers.has(address), String(address)).toBe(false);
  });

  test("anything but addresses and bounded ranges is a configuration error", () => {
    for (const value of [
      "",
      " ",
      "203.0.113.7,",
      "relay",
      "203.0.113.7/0",
      "::/0",
      "203.0.113.0/33",
      "2001:db8::/129",
      "203.0.113.0/",
      "203.0.113.0/2a",
      "203.0.113.0/0024",
      "203.0.113.0/24/1",
      "203.0.113.7:443",
    ])
      expect(() => ProxyProtocolPeers.parse(value), value).toThrow("PROXY protocol peer");
  });

  test("a connection without a front-layer record is its TCP peer", () => {
    expect(connectionClientAddress(undefined)).toBeUndefined();
    expect(connectionClientAddress({})).toBeUndefined();
    expect(connectionClientAddress({ remoteAddress: "203.0.113.7" })).toBe("203.0.113.7");
  });
});

// ── Listener behaviour, over real loopback sockets ──────────────────────────
const FRONT = "::1";
const servers: Server[] = [];
const aliases: Awaited<ReturnType<typeof addIpv6Loopback>>[] = [];

/** Refusal may close with a TCP reset; both outcomes must release the slot. */
function socketClosed(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

afterEach(async () => {
  for (const alias of aliases.splice(0)) await alias.close();
  for (const server of servers.splice(0)) server.close();
});

interface Seen {
  client: string | undefined;
  data: Buffer;
  endpoint: {
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
  };
  closed: Promise<unknown>;
}

/**
 * A server whose own connection listener reports which client it was given and
 * the first bytes it read, as the HTTP, TLS and ClientHello listeners would see them.
 */
async function frontedServer(options: { timeoutMs?: number; maxPending?: number } = {}) {
  const seen: Seen[] = [];
  const server = createServer((socket: Socket) => {
    socket.once("data", (data: Buffer) => {
      const { localAddress, localPort, remoteAddress, remotePort } = socket;
      seen.push({
        client: connectionClientAddress(socket),
        data,
        endpoint: { localAddress, localPort, remoteAddress, remotePort },
        closed: socketClosed(socket),
      });
      socket.end("ok");
    });
  });
  const front = acceptProxyProtocol(server, ProxyProtocolPeers.parse(FRONT)!, {
    timeoutMs: 200,
    ...options,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  aliases.push(await addIpv6Loopback(server));
  return { seen, front, port };
}

/** Connects from `from`, writes each part in turn, and resolves with whatever came back before close. */
async function exchange(
  port: number,
  from: string,
  parts: Buffer[],
  pauseMs = 0,
): Promise<{ reply: string; socket: Socket }> {
  const socket = connect({ host: from, port, localAddress: from });
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.setNoDelay(true);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = socketClosed(socket);
  for (const part of parts) {
    socket.write(part);
    if (pauseMs) await delay(pauseMs);
  }
  await closed;
  return { reply: Buffer.concat(chunks).toString(), socket };
}

describe("reading the header before any listener", () => {
  test("a trusted front's header names the client for this connection only, until it closes", async () => {
    const { seen, port } = await frontedServer();
    const { reply } = await exchange(port, FRONT, [
      Buffer.concat([proxyV4("203.0.113.7"), Buffer.from("hello")]),
    ]);
    expect(reply).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.client).toBe("203.0.113.7");
    expect(seen[0]!.data.toString()).toBe("hello");
    await seen[0]!.closed;
    // Once closed, the same endpoints are just the peer again.
    expect(connectionClientAddress(seen[0]!.endpoint)).toBe(FRONT);

    // An IPv4-mapped IPv6 source is recorded as plain IPv4.
    await exchange(port, FRONT, [
      proxyV6("00000000000000000000ffffcb007109"),
      Buffer.from("again"),
    ]);
    expect(seen[1]!.client).toBe("203.0.113.9");
  });

  test("a header that arrives one byte at a time is still read, and the bytes after it kept", async () => {
    const { seen, port } = await frontedServer({ timeoutMs: 5_000 });
    const header = Buffer.from("PROXY TCP6 2001:db8::42 2001:db8::1 50000 443\r\n");
    await exchange(
      port,
      FRONT,
      [...header].map((byte) => Buffer.from([byte])).concat(Buffer.from("tail")),
      2,
    );
    expect(seen[0]!.client).toBe("2001:db8::42");
    expect(seen[0]!.data.toString()).toBe("tail");
  });

  test("LOCAL and unspecified headers leave the front itself as the client", async () => {
    const { seen, port } = await frontedServer();
    await exchange(port, FRONT, [
      Buffer.concat([v2(0x20, 0x00, Buffer.alloc(0)), Buffer.from("health")]),
    ]);
    await exchange(port, FRONT, [Buffer.from("PROXY UNKNOWN\r\nprobe")]);
    expect(seen.map(({ client, data }) => [client, data.toString()])).toEqual([
      [FRONT, "health"],
      [FRONT, "probe"],
    ]);
  });

  test("a trusted front without a valid header is closed before any listener sees it", async () => {
    const { seen, port } = await frontedServer();
    // Plain bytes, a too-large header, a slow sender past the deadline, and silence.
    expect((await exchange(port, FRONT, [Buffer.from("hello")])).reply).toBe("");
    expect(
      (await exchange(port, FRONT, [v2(0x21, 0x11, Buffer.alloc(1024)).subarray(0, 20)])).reply,
    ).toBe("");
    const slow = proxyV4("203.0.113.7");
    const started = Date.now();
    expect(
      (
        await exchange(
          port,
          FRONT,
          [...slow].map((byte) => Buffer.from([byte])),
          20,
        )
      ).reply,
    ).toBe("");
    expect(Date.now() - started).toBeLessThan(28 * 20 + 1_000);
    expect((await exchange(port, FRONT, [])).reply).toBe("");
    expect(seen).toEqual([]);
  });

  test("another peer's header is never parsed: it reaches the listener as its own bytes", async () => {
    const { seen, port } = await frontedServer();
    const header = proxyV4("203.0.113.7");
    await exchange(port, "127.0.0.1", [Buffer.concat([header, Buffer.from("hello")])]);
    expect(seen[0]!.client).toBe("127.0.0.1");
    expect(seen[0]!.data).toEqual(Buffer.concat([header, Buffer.from("hello")]));
  });

  test("waiting connections are bounded, freed when they close or fail, and closed on shutdown", async () => {
    const { seen, front, port } = await frontedServer({ maxPending: 1, timeoutMs: 10_000 });
    const open = async () => {
      const socket = connect({ host: FRONT, port, localAddress: FRONT });
      socket.on("error", () => {});
      await once(socket, "connect");
      return socket;
    };
    const admitted = async (source: string) => {
      await delay(50);
      await exchange(port, FRONT, [Buffer.concat([proxyV4(source), Buffer.from("x")])]);
      return seen.at(-1)?.client === source;
    };
    const waiting = await open();
    // The slot is taken: the next trusted connection is refused outright.
    expect(await admitted("203.0.113.1")).toBe(false);
    expect(seen).toEqual([]);

    // A half header and then an end frees the slot.
    waiting.end(proxyV4("203.0.113.7").subarray(0, 10));
    await socketClosed(waiting);
    expect(await admitted("203.0.113.2")).toBe(true);

    // So does a reset.
    const reset = await open();
    await delay(20);
    reset.resetAndDestroy();
    expect(await admitted("203.0.113.3")).toBe(true);

    // Shutdown closes the connection still waiting for its header, long before its deadline.
    const held = await open();
    const heldClosed = socketClosed(held);
    await delay(20);
    const closing = Date.now();
    front.close();
    await heldClosed;
    expect(Date.now() - closing).toBeLessThan(2_000);

    // An untrusted peer is never held against the bound.
    const blocker = await open();
    await delay(20);
    await exchange(port, "127.0.0.1", [Buffer.from("plain")]);
    blocker.destroy();
    expect(seen.map(({ client }) => client)).toEqual(["203.0.113.2", "203.0.113.3", "127.0.0.1"]);
  });
});
