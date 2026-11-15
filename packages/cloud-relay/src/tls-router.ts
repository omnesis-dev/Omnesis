// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server, type Socket } from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { CloudRelayMetrics, type DataEvent } from "./metrics.js";
import { clientHelloHostname, MAX_CLIENT_HELLO_BYTES } from "./client-hello.js";
import { connectionClientAddress } from "./proxy-protocol.js";
import { clientBucket } from "./client-bucket.js";
import { DEFAULT_TUNNEL_LIMITS } from "./tunnels.js";

export interface TlsRouterOptions {
  metrics?: CloudRelayMetrics;
  accountForHostname(hostname: string): string | undefined;
  open(account: string, signal: AbortSignal, client: string | undefined): Promise<Duplex>;
  maxConnections?: number;
  /** Connections one client address (an IPv6 /64) may hold, routed or not yet. */
  maxConnectionsPerClient?: number;
  helloTimeoutMs?: number;
  /** A routed connection with no bytes either way for this long is closed. */
  idleTimeoutMs?: number;
}

/** Routes encrypted bytes without terminating TLS, parsing HTTP, or seeing credentials. */
export function createTlsRouter(options: TlsRouterOptions): {
  server: Server;
  snapshot(): { dataConnections: number; dataIngressBytes: number; dataEgressBytes: number };
  close(): Promise<void>;
} {
  const metrics = options.metrics ?? new CloudRelayMetrics();
  let closedIngressBytes = 0;
  let closedEgressBytes = 0;
  const maxConnections = options.maxConnections ?? 256;
  const maxConnectionsPerClient =
    options.maxConnectionsPerClient ?? DEFAULT_TUNNEL_LIMITS.maxStreamsPerClient;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_TUNNEL_LIMITS.idleTimeoutMs;
  for (const limit of [maxConnections, maxConnectionsPerClient, helloTimeoutMs, idleTimeoutMs])
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647)
      throw new Error("Invalid TLS router limits");
  const sockets = new Set<Socket>();
  const clients = new Map<string, number>();
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    if (sockets.size >= maxConnections) {
      metrics.data("capacity");
      socket.destroy();
      return;
    }
    const address = connectionClientAddress(socket);
    const client = address === undefined ? undefined : clientBucket(address);
    const held = client === undefined ? 0 : (clients.get(client) ?? 0);
    if (held >= maxConnectionsPerClient) {
      metrics.data("client_capacity");
      socket.destroy();
      return;
    }
    if (client !== undefined) clients.set(client, held + 1);
    sockets.add(socket);
    metrics.data("accepted");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      metrics.data("hello_timeout");
      socket.destroy();
    }, helloTimeoutMs);
    const initial = Buffer.alloc(MAX_CLIENT_HELLO_BYTES);
    let initialLength = 0;
    let recordOffset = 0;
    let destination: Duplex | undefined;
    socket.once("close", () => {
      closedIngressBytes += socket.bytesRead;
      closedEgressBytes += socket.bytesWritten;
      sockets.delete(socket);
      if (client !== undefined) {
        const left = (clients.get(client) ?? 1) - 1;
        if (left > 0) clients.set(client, left);
        else clients.delete(client);
      }
      metrics.data("closed");
      clearTimeout(timer);
      controller.abort();
      destination?.destroy();
    });
    const receive = (chunk: Buffer): void => {
      let failure: DataEvent = "invalid_hello";
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
        if (account === undefined) {
          failure = "unknown_gateway";
          throw new Error("Unknown gateway");
        }
        failure = "connect_failed";
        socket.pause();
        socket.removeListener("data", receive);
        void options.open(account, controller.signal, address).then(
          (stream) => {
            if (socket.destroyed) {
              stream.destroy();
              return;
            }
            destination = stream;
            metrics.data("routed");
            stream.on("error", () => socket.destroy());
            // Preserve the exact original ClientHello, including its random and key shares.
            stream.write(initial.subarray(0, initialLength));
            clearTimeout(timer);
            // Node counts reads and writes as activity, so a stream that only sends stays open.
            socket.setTimeout(idleTimeoutMs, () => {
              metrics.data("idle_timeout");
              socket.destroy();
            });
            pipeline(socket, stream, () => {
              socket.destroy();
              stream.destroy();
            });
            pipeline(stream, socket, () => {
              socket.destroy();
              stream.destroy();
            });
          },
          () => {
            metrics.data("connect_failed");
            socket.destroy();
          },
        );
      } catch {
        metrics.data(failure);
        socket.destroy();
      }
    };
    socket.on("data", receive);
  });
  return {
    server,
    snapshot: () => ({
      dataConnections: sockets.size,
      dataIngressBytes:
        closedIngressBytes + [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0),
      dataEgressBytes:
        closedEgressBytes + [...sockets].reduce((sum, socket) => sum + socket.bytesWritten, 0),
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
