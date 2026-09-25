// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Stops ingress before the services behind HTTP and WebSocket handlers are
 * disposed. Node's close() drains HTTP responses but excludes upgraded sockets,
 * so those are disconnected explicitly. A fetch gate also rejects requests
 * arriving over an already accepted keep-alive connection during the drain. */
export class GatewayHttpShutdown {
  private accepting = true;
  private readonly sockets = new Set<Socket>();
  private readonly upgraded = new Set<Duplex>();
  private closing: Promise<boolean> | null = null;

  guard<T>(handle: () => T): T | Response {
    if (!this.accepting) {
      return Response.json(
        { error: "Gateway is shutting down", code: "GATEWAY_SHUTTING_DOWN" },
        { status: 503, headers: { Connection: "close", "Retry-After": "1" } },
      );
    }
    return handle();
  }

  attach(server: ServerType): void {
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      if (!this.accepting) socket.destroy();
    });
    server.on("upgrade", (_request: IncomingMessage, socket: Duplex) => {
      this.upgraded.add(socket);
      socket.once("close", () => this.upgraded.delete(socket));
      if (!this.accepting) socket.destroy();
    });
  }

  /** Resolves false when the drain budget expires. Destroying remaining sockets
   * signals cancellation to request handlers; it cannot cancel arbitrary JS work. */
  close(server: ServerType, timeoutMs: number): Promise<boolean> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        for (const socket of this.sockets) socket.destroy();
        resolve(false);
      }, timeoutMs);
      timeout.unref?.();
      server.close(() => {
        clearTimeout(timeout);
        resolve(true);
      });
      for (const socket of this.upgraded) socket.destroy();
    });
    return this.closing;
  }
}
