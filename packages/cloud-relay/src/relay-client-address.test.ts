// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import {
  isRelayTunnelPeer,
  recordRelayedClient,
  relayedClientAddress,
} from "./relay-client-address.js";

const dialled = (localAddress: string | undefined, localPort: number | undefined) =>
  Object.assign(new EventEmitter(), { localAddress, localPort });

test("a dialled loopback socket names its relayed client until it closes, and only that socket", () => {
  const socket = dialled("127.0.0.1", 40001);
  recordRelayedClient(socket, "::ffff:198.51.100.4");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40001 })).toBe(
    "198.51.100.4",
  );
  expect(relayedClientAddress({ remoteAddress: "::ffff:127.0.0.1", remotePort: 40001 })).toBe(
    "198.51.100.4",
  );
  // Same port from another loopback address, another port, or an incomplete peer: nothing.
  expect(relayedClientAddress({ remoteAddress: "::1", remotePort: 40001 })).toBeUndefined();
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40002 })).toBeUndefined();
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1" })).toBeUndefined();
  expect(relayedClientAddress({ remotePort: 40001 })).toBeUndefined();

  // A reused port keeps its new client when the old socket's close arrives late.
  const reused = dialled("127.0.0.1", 40001);
  recordRelayedClient(reused, "2001:db8::5");
  socket.emit("close");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40001 })).toBe(
    "2001:db8::5",
  );
  reused.emit("close");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40001 })).toBeUndefined();
});

test("a value that is not an address names no client, and a socket without a local endpoint records nothing", () => {
  recordRelayedClient(dialled("127.0.0.1", 40003), "relay.example.test");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40003 })).toBeUndefined();
  // The socket still came through the relay.
  expect(isRelayTunnelPeer({ remoteAddress: "127.0.0.1", remotePort: 40003 })).toBe(true);
  recordRelayedClient(dialled(undefined, 40004), "198.51.100.4");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40004 })).toBeUndefined();
  recordRelayedClient(dialled("127.0.0.1", undefined), "198.51.100.4");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 0 })).toBeUndefined();
  expect(isRelayTunnelPeer({ remoteAddress: "127.0.0.1", remotePort: 0 })).toBe(false);
});

test("a socket the relay named no client for is still known to have come through the relay, until it closes", () => {
  const socket = dialled("127.0.0.1", 40005);
  const peer = { remoteAddress: "127.0.0.1", remotePort: 40005 };
  expect(isRelayTunnelPeer(peer)).toBe(false);
  recordRelayedClient(socket, undefined);
  expect(isRelayTunnelPeer(peer)).toBe(true);
  expect(isRelayTunnelPeer({ remoteAddress: "::ffff:127.0.0.1", remotePort: 40005 })).toBe(true);
  expect(relayedClientAddress(peer)).toBeUndefined();
  // A local client on another port, or an incomplete peer, is not the relay's.
  expect(isRelayTunnelPeer({ remoteAddress: "127.0.0.1", remotePort: 40006 })).toBe(false);
  expect(isRelayTunnelPeer({ remoteAddress: "127.0.0.1" })).toBe(false);
  socket.emit("close");
  expect(isRelayTunnelPeer(peer)).toBe(false);
});
