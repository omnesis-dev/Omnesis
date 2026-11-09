// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BlockList, isIPv4, isIPv6, SocketAddress, type Server, type Socket } from "node:net";

/**
 * PROXY protocol (v1 text and v2 binary) from an explicitly trusted TCP front
 * layer, such as HAProxy forwarding raw TCP with `send-proxy-v2`.
 *
 * The header names the address the front layer accepted the client from. It is
 * read only on connections whose socket peer is in the operator's list, and it is
 * then required there: such a connection without a valid header is closed. Any
 * other peer's bytes are never inspected, so a PROXY header it sends stays part of
 * its stream and fails the TLS handshake or ClientHello parse as it always did.
 * The address is used for rate limits, logs and the client address the relay
 * reports to gateways, never for authorization.
 */

const V2_SIGNATURE = Buffer.from("\r\n\r\n\0\r\nQUIT\n", "latin1");
const V1_PREFIX = Buffer.from("PROXY ", "latin1");
/** The longest v1 line the specification allows, including its CRLF. */
const V1_MAX_BYTES = 107;
/** The fixed v2 header, an IPv6 address block and room for small TLVs. */
export const MAX_PROXY_HEADER_BYTES = 512;
export const PROXY_HEADER_TIMEOUT_MS = 5_000;

export interface ProxyHeader {
  /** Bytes the header occupies at the start of the stream. */
  length: number;
  /** The client's address, or undefined for LOCAL and unspecified families, which keep the peer. */
  source?: string;
}

/**
 * Parses a PROXY header at the start of `data`. Returns undefined while it
 * could still become a valid header, and throws as soon as it cannot.
 */
export function parseProxyHeader(data: Buffer): ProxyHeader | undefined {
  const v2 = data.subarray(0, V2_SIGNATURE.length);
  if (v2.equals(V2_SIGNATURE.subarray(0, v2.length)))
    return data.length < V2_SIGNATURE.length ? undefined : parseV2(data);
  const v1 = data.subarray(0, V1_PREFIX.length);
  if (v1.equals(V1_PREFIX.subarray(0, v1.length)))
    return data.length < V1_PREFIX.length ? undefined : parseV1(data);
  throw new Error("Not a PROXY protocol header");
}

function parseV2(data: Buffer): ProxyHeader | undefined {
  if (data.length < 16) return undefined;
  const versionCommand = data[12]!;
  const familyTransport = data[13]!;
  const length = 16 + data.readUInt16BE(14);
  if (versionCommand >> 4 !== 2) throw new Error("Unsupported PROXY protocol version");
  const command = versionCommand & 0x0f;
  if (command > 1) throw new Error("Unsupported PROXY protocol command");
  if (length > MAX_PROXY_HEADER_BYTES) throw new Error("PROXY protocol header too large");
  if (data.length < length) return undefined;
  // LOCAL: the front layer's own connection, such as a health check.
  if (command === 0) return { length };
  const family = familyTransport >> 4;
  const transport = familyTransport & 0x0f;
  // Unspecified: no address to report; the peer stands for the client.
  if (family === 0) return { length };
  if (transport !== 1 || (family !== 1 && family !== 2))
    throw new Error("Unsupported PROXY protocol address family");
  const block = family === 1 ? 12 : 36;
  if (length - 16 < block) throw new Error("Truncated PROXY protocol addresses");
  const source =
    family === 1
      ? [...data.subarray(16, 20)].join(".")
      : new SocketAddress({
          family: "ipv6",
          address: (data.subarray(16, 32).toString("hex").match(/.{4}/g) as string[]).join(":"),
        }).address;
  return { length, source };
}

function parseV1(data: Buffer): ProxyHeader | undefined {
  const end = data.subarray(0, V1_MAX_BYTES).indexOf("\r\n");
  if (end < 0) {
    if (data.length >= V1_MAX_BYTES) throw new Error("PROXY protocol line too long");
    return undefined;
  }
  const fields = data.subarray(V1_PREFIX.length, end).toString("latin1").split(" ");
  // UNKNOWN may carry anything after it; the peer stands for the client.
  if (fields[0] === "UNKNOWN") return { length: end + 2 };
  const port = /^(0|[1-9]\d{0,4})$/;
  const [family, source, destination, sourcePort, destinationPort] = fields;
  const valid = family === "TCP4" ? isIPv4 : family === "TCP6" ? isIPv6 : undefined;
  if (
    fields.length !== 5 ||
    !valid?.(source!) ||
    !valid(destination!) ||
    ![sourcePort!, destinationPort!].every((value) => port.test(value) && Number(value) <= 65535)
  )
    throw new Error("Invalid PROXY protocol line");
  return {
    length: end + 2,
    source:
      family === "TCP6" ? new SocketAddress({ family: "ipv6", address: source }).address : source,
  };
}

/** `::ffff:a.b.c.d` as `a.b.c.d`; anything else unchanged. */
function plain(address: string): string {
  return /^::ffff:/i.test(address) && isIPv4(address.slice(7)) ? address.slice(7) : address;
}

/** The exact peer addresses and CIDR ranges allowed to send PROXY headers. */
export class ProxyProtocolPeers {
  private constructor(private readonly list: BlockList) {}

  /**
   * Parses a comma-separated list such as `192.0.2.0/24, 2001:db8::7`.
   * Undefined stays undefined; any malformed entry, or a range that admits every
   * address, is a configuration error.
   */
  static parse(value: string | undefined): ProxyProtocolPeers | undefined {
    if (value === undefined) return undefined;
    const list = new BlockList();
    for (const raw of value.split(",")) {
      const entry = raw.trim();
      const [address = "", prefix, extra] = entry.split("/");
      const family = isIPv4(address) ? "ipv4" : isIPv6(address) ? "ipv6" : undefined;
      if (!family || extra !== undefined)
        throw new Error("Invalid PROXY protocol peer; use IP addresses or CIDR ranges");
      if (prefix === undefined) {
        list.addAddress(plain(address), isIPv4(plain(address)) ? "ipv4" : family);
        continue;
      }
      const bits = Number(prefix);
      if (!/^\d{1,3}$/.test(prefix) || bits < 1 || bits > (family === "ipv4" ? 32 : 128))
        throw new Error("Invalid PROXY protocol peer range");
      list.addSubnet(address, bits, family);
    }
    return new ProxyProtocolPeers(list);
  }

  has(address: string | undefined): boolean {
    if (!address) return false;
    const peer = plain(address);
    return this.list.check(peer, isIPv4(peer) ? "ipv4" : "ipv6");
  }
}

interface Endpoint {
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
}

/**
 * Header addresses by connection. A TLS socket the HTTPS server wraps around a
 * TCP socket shares that socket's endpoints, so both find the same entry.
 */
const proxied = new Map<string, string>();

/** A connected socket's four endpoints; an incomplete one matches no recorded connection. */
function endpointKey(socket: Endpoint): string {
  const { localAddress = "", localPort, remoteAddress = "", remotePort } = socket;
  return `${plain(localAddress)}|${localPort}|${plain(remoteAddress)}|${remotePort}`;
}

/**
 * The client a connection serves: the address a trusted front layer reported
 * for it, otherwise its TCP peer. For rate limits, logs and gateway reports only.
 */
export function connectionClientAddress(socket: Endpoint | undefined): string | undefined {
  if (!socket) return undefined;
  return proxied.get(endpointKey(socket)) ?? socket.remoteAddress;
}

/**
 * Makes `server` read a PROXY header first on every connection from a trusted
 * peer, before any listener registered so far (HTTP, TLS or the ClientHello
 * router) sees a byte. Call it after those listeners are registered.
 */
export function acceptProxyProtocol(
  server: Server,
  peers: ProxyProtocolPeers,
  options: { timeoutMs?: number; maxPending?: number } = {},
): { close(): void } {
  const timeoutMs = options.timeoutMs ?? PROXY_HEADER_TIMEOUT_MS;
  const maxPending = options.maxPending ?? 256;
  const listeners = server.listeners("connection") as ((socket: Socket) => void)[];
  server.removeAllListeners("connection");
  const pending = new Set<Socket>();
  const handOff = (socket: Socket) => {
    for (const listener of listeners) listener.call(server, socket);
  };
  server.on("connection", (socket: Socket) => {
    if (!peers.has(socket.remoteAddress)) {
      handOff(socket);
      return;
    }
    if (pending.size >= maxPending) {
      socket.destroy();
      return;
    }
    pending.add(socket);
    let received = Buffer.alloc(0);
    const finish = () => {
      clearTimeout(timer);
      pending.delete(socket);
      socket.removeListener("readable", read);
      socket.removeListener("error", refuse);
      socket.removeListener("close", finish);
    };
    const refuse = () => {
      finish();
      socket.destroy();
    };
    const timer = setTimeout(refuse, timeoutMs);
    function read(): void {
      for (let chunk: Buffer | null; (chunk = socket.read() as Buffer | null) !== null;)
        received = Buffer.concat([received, chunk]);
      let header: ProxyHeader | undefined;
      try {
        header = parseProxyHeader(received);
      } catch {
        refuse();
        return;
      }
      if (!header) return;
      finish();
      if (received.length > header.length) socket.unshift(received.subarray(header.length));
      const key = endpointKey(socket);
      if (header.source !== undefined) {
        const source = plain(header.source);
        proxied.set(key, source);
        // The four endpoints name one TCP connection, which TCP keeps from being reused while it closes.
        socket.once("close", () => proxied.delete(key));
      }
      handOff(socket);
    }
    socket.on("readable", read);
    socket.on("error", refuse);
    socket.once("close", finish);
  });
  return {
    close() {
      for (const socket of pending) socket.destroy();
    },
  };
}
