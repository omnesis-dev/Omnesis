// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isIP } from "node:net";

/**
 * Every relayed connection reaches the gateway from its own tunnel client over
 * loopback, so the socket peer says nothing about who is on the other end. The
 * relay names the address each data stream came from in its open frame on the
 * authenticated control socket, and the tunnel client, in the gateway's own
 * process, records it here against the loopback socket it dialled.
 *
 * Only that tunnel client writes this table. The gateway reads it to keep one
 * relayed client's rate limits apart from another's and for audit lines; it
 * never authorizes anything, since the relay could name any address it likes.
 *
 * Every socket the tunnel client dials is recorded, whether or not the relay
 * named an address: that it came through the relay is the gateway's own fact,
 * which the relay can't hide by leaving the address out.
 */
const clients = new Map<string, { client?: string }>();

function plain(address: string): string {
  return /^::ffff:/i.test(address) && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

function entry(peer: { remoteAddress?: string; remotePort?: number }) {
  if (!peer.remoteAddress || peer.remotePort === undefined) return undefined;
  return clients.get(`${plain(peer.remoteAddress)}|${peer.remotePort}`);
}

/** The address the relay reported for the client behind this loopback peer, if any. */
export function relayedClientAddress(peer: {
  remoteAddress?: string;
  remotePort?: number;
}): string | undefined {
  return entry(peer)?.client;
}

/**
 * Whether this peer is a socket this process's relay tunnel dialled, so the request on it came
 * through the relay. Unlike a header, nothing the relay sends can make this false.
 */
export function isRelayTunnelPeer(peer: { remoteAddress?: string; remotePort?: number }): boolean {
  return entry(peer) !== undefined;
}

/**
 * Records a connected loopback socket the tunnel dialled until that socket closes, with the
 * client the relay named for it when that is an address.
 */
export function recordRelayedClient(
  socket: {
    localAddress?: string;
    localPort?: number;
    once(event: "close", listener: () => void): unknown;
  },
  client: string | undefined,
): void {
  if (!socket.localAddress || socket.localPort === undefined) return;
  const address = client === undefined ? undefined : plain(client);
  const key = `${plain(socket.localAddress)}|${socket.localPort}`,
    entry = address !== undefined && isIP(address) ? { client: address } : {};
  clients.set(key, entry);
  socket.once("close", () => {
    if (clients.get(key) === entry) clients.delete(key);
  });
}
