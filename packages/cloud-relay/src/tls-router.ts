// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server, type Socket } from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { clientHelloHostname, MAX_CLIENT_HELLO_BYTES } from "./client-hello.js";

export interface TlsRouterOptions {
  accountForHostname(hostname: string): string | undefined;
  open(account: string, signal: AbortSignal): Promise<Duplex>;
  maxConnections?: number;
  helloTimeoutMs?: number;
}

/** Routes encrypted bytes without terminating TLS, parsing HTTP, or seeing credentials. */
export function createTlsRouter(options: TlsRouterOptions): {
  server: Server;
  close(): Promise<void>;
} {
  const maxConnections = options.maxConnections ?? 256;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  for (const limit of [maxConnections, helloTimeoutMs])
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647)
      throw new Error("Invalid TLS router limits");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    const timer = setTimeout(() => socket.destroy(), helloTimeoutMs);
    const initial = Buffer.alloc(MAX_CLIENT_HELLO_BYTES);
    let initialLength = 0;
    let recordOffset = 0;
    let destination: Duplex | undefined;
    socket.once("close", () => {
      sockets.delete(socket);
      clearTimeout(timer);
      controller.abort();
      destination?.destroy();
    });
    const receive = (chunk: Buffer): void => {
      try {
        if (initialLength + chunk.length > MAX_CLIENT_HELLO_BYTES)
          throw new Error("ClientHello too large");
        chunk.copy(initial, initialLength);
        initialLength += chunk.length;
        // Do not reparse the prefix for each single-byte TCP fragment.
        if (recordOffset + 5 > initialLength) return;
        const recordLength = initial.readUInt16BE(recordOffset + 3);
        const recordEnd = recordOffset + 5 + recordLength;
        if (recordLength > 18_432) throw new Error("Invalid TLS record");
        if (recordEnd > initialLength) return;
        recordOffset = recordEnd;
        const hostname = clientHelloHostname(initial.subarray(0, initialLength));
        if (hostname === undefined) return;
        const account = options.accountForHostname(hostname);
        if (account === undefined) throw new Error("Unknown gateway");
        socket.pause();
        socket.removeListener("data", receive);
        void options.open(account, controller.signal).then(
          (stream) => {
            if (socket.destroyed) {
              stream.destroy();
              return;
            }
            destination = stream;
            stream.on("error", () => socket.destroy());
            // Preserve the exact original ClientHello, including its random and key shares.
            stream.write(initial.subarray(0, initialLength));
            clearTimeout(timer);
            pipeline(socket, stream, () => {
              socket.destroy();
              stream.destroy();
            });
            pipeline(stream, socket, () => {
              socket.destroy();
              stream.destroy();
            });
          },
          () => socket.destroy(),
        );
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", receive);
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
