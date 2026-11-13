// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";

/**
 * Give a listening IPv4 loopback server a second, real peer address on ::1.
 * Both listeners stay on loopback; the original server receives the actual
 * IPv6 socket, so address-based trust is exercised without socket mocks or
 * requiring an operating system to assign extra addresses from 127/8.
 */
export async function addIpv6Loopback(server: Server): Promise<{ close(): Promise<void> }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a listening TCP server");
  const sockets = new Set<Socket>();
  const ipv6 = createServer((socket) => {
    sockets.add(socket);
    server.emit("connection", socket);
  });
  ipv6.listen({ host: "::1", port: address.port, ipv6Only: true });
  await once(ipv6, "listening");
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve, reject) => {
        ipv6.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
