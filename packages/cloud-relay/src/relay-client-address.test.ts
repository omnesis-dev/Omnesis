// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { recordRelayedClient, relayedClientAddress } from "./relay-client-address.js";

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

test("a value that is not an address, or a socket without a local endpoint, records nothing", () => {
  recordRelayedClient(dialled("127.0.0.1", 40003), "relay.example.test");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40003 })).toBeUndefined();
  recordRelayedClient(dialled(undefined, 40004), "198.51.100.4");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 40004 })).toBeUndefined();
  recordRelayedClient(dialled("127.0.0.1", undefined), "198.51.100.4");
  expect(relayedClientAddress({ remoteAddress: "127.0.0.1", remotePort: 0 })).toBeUndefined();
});
