// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { type Duplex } from "node:stream";
import { createWebSocketStream, WebSocket } from "ws";
import { CloudRelayMetrics } from "./metrics.js";
import { clientBucket } from "./client-bucket.js";

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TunnelLimits {
  maxGateways: number;
  maxStreams: number;
  maxStreamsPerGateway: number;
  /** Data connections one client address (an IPv6 /64) may hold on the data listener. */
  maxStreamsPerClient: number;
  /** Streams one client address (an IPv6 /64) may hold to one gateway. */
  maxStreamsPerClientPerGateway: number;
  connectTimeoutMs: number;
  heartbeatMs: number;
  /** A routed connection with no bytes either way for this long is closed. */
  idleTimeoutMs: number;
}

export const DEFAULT_TUNNEL_LIMITS: TunnelLimits = {
  maxGateways: 100,
  maxStreams: 256,
  maxStreamsPerGateway: 16,
  // An eighth of the relay's, and half of one gateway's, so one client never holds them all.
  // A browser opens up to six connections to one name.
  maxStreamsPerClient: 32,
  maxStreamsPerClientPerGateway: 8,
  connectTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  // Gateways ping device WebSockets and send SSE keep-alives every 15 to 30 seconds.
  idleTimeoutMs: 600_000,
};

interface Pending {
  owner: Tunnel;
  client: string | undefined;
  timer: ReturnType<typeof setTimeout>;
  resolve: (stream: Duplex) => void;
  reject: (error: Error) => void;
}

interface Tunnel {
  socket: WebSocket;
  streams: Set<Duplex>;
  pending: Set<string>;
  /** Streams and pending reservations by client bucket. */
  clients: Map<string, number>;
  expiry: ReturnType<typeof setTimeout>;
  heartbeat: ReturnType<typeof setInterval>;
  revoke(): void;
}

/** Control plane owns routing and admission; data channels carry unparsed byte streams. */
export class TunnelBroker {
  private readonly gateways = new Map<string, Tunnel>();
  private readonly pending = new Map<string, Pending>();
  private activeStreams = 0;

  constructor(
    private readonly limits: TunnelLimits = DEFAULT_TUNNEL_LIMITS,
    private readonly metrics = new CloudRelayMetrics(),
  ) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 715_827_882)
        throw new Error("Tunnel limits must be positive integers");
    }
  }

  admit(account: string): void {
    if (this.gateways.has(account)) throw new RelayError(409, "Gateway is already connected");
    if (this.gateways.size >= this.limits.maxGateways)
      throw new RelayError(503, "Gateway capacity reached");
  }

  attach(account: string, socket: WebSocket, expiresAt: number): void {
    this.admit(account);
    let alive = true;
    const tunnel: Tunnel = {
      socket,
      streams: new Set(),
      pending: new Set(),
      clients: new Map(),
      expiry: setTimeout(
        () => {
          this.metrics.tunnel("session_expired");
          tunnel.revoke();
          socket.terminate();
        },
        Math.max(0, expiresAt * 1000 - Date.now()),
      ),
      heartbeat: setInterval(() => {
        if (!alive) {
          this.metrics.tunnel("heartbeat_timeout");
          tunnel.revoke();
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, this.limits.heartbeatMs),
      revoke: () => {
        clearTimeout(tunnel.expiry);
        clearInterval(tunnel.heartbeat);
        if (this.gateways.get(account) === tunnel) {
          this.gateways.delete(account);
          this.metrics.tunnel("disconnected");
        }
        for (const ticket of tunnel.pending) {
          this.metrics.stream("gateway_disconnected");
          this.fail(ticket, new RelayError(502, "Gateway disconnected"));
        }
        for (const stream of tunnel.streams) stream.destroy();
      },
    };
    this.gateways.set(account, tunnel);
    this.metrics.tunnel("connected");
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("error", () => {
      this.metrics.tunnel("socket_error");
      socket.terminate();
    });
    socket.on("message", () => {
      this.metrics.tunnel("unexpected_message");
      socket.close(1008, "Unexpected control message");
    });
    socket.once("close", tunnel.revoke);
    socket.send(
      JSON.stringify({ type: "ready", version: 1, heartbeatMs: this.limits.heartbeatMs }),
    );
  }

  /**
   * `client` is the address the data connection came from. The gateway uses it
   * to keep one client's rate limits apart from another's, never to authorize.
   */
  open(account: string, signal: AbortSignal, client?: string): Promise<Duplex> {
    this.metrics.stream("requested");
    const tunnel = this.gateways.get(account);
    if (!tunnel || tunnel.socket.readyState !== WebSocket.OPEN) {
      this.metrics.stream("offline");
      throw new RelayError(503, "Gateway is offline");
    }
    if (signal.aborted) {
      this.metrics.stream("aborted");
      throw new RelayError(499, "Client disconnected");
    }
    if (
      this.activeStreams + this.pending.size >= this.limits.maxStreams ||
      tunnel.streams.size + tunnel.pending.size >= this.limits.maxStreamsPerGateway
    ) {
      this.metrics.stream("capacity");
      throw new RelayError(429, "Stream capacity reached");
    }
    const address = normalizeAddress(client);
    const bucket = address === undefined ? undefined : clientBucket(address);
    if (
      bucket !== undefined &&
      (tunnel.clients.get(bucket) ?? 0) >= this.limits.maxStreamsPerClientPerGateway
    ) {
      this.metrics.stream("client_capacity");
      throw new RelayError(429, "Stream capacity reached for this client");
    }
    if (bucket !== undefined) tunnel.clients.set(bucket, (tunnel.clients.get(bucket) ?? 0) + 1);
    const ticket = randomBytes(32).toString("hex");
    return new Promise<Duplex>((resolve, reject) => {
      const abort = (): void => {
        this.metrics.stream("aborted");
        this.fail(ticket, new RelayError(499, "Client disconnected"));
      };
      const clean = (): void => signal.removeEventListener("abort", abort);
      this.pending.set(ticket, {
        owner: tunnel,
        client: bucket,
        timer: setTimeout(() => {
          this.metrics.stream("timeout");
          this.fail(ticket, new RelayError(504, "Gateway connection timed out"));
        }, this.limits.connectTimeoutMs),
        resolve: (stream) => {
          clean();
          resolve(stream);
        },
        reject: (error) => {
          clean();
          reject(error);
        },
      });
      tunnel.pending.add(ticket);
      signal.addEventListener("abort", abort, { once: true });
      tunnel.socket.send(
        JSON.stringify({
          type: "open",
          version: 1,
          ticket,
          ...(address ? { client: address } : {}),
        }),
      );
    });
  }

  canClaim(account: string, ticket: string): boolean {
    return (
      this.pending.get(ticket)?.owner === this.gateways.get(account) && this.pending.has(ticket)
    );
  }

  claim(account: string, ticket: string, socket: WebSocket): void {
    if (!this.canClaim(account, ticket)) {
      this.metrics.stream("rejected");
      socket.close(1008, "Invalid data channel");
      return;
    }
    const pending = this.pending.get(ticket)!;
    this.pending.delete(ticket);
    pending.owner.pending.delete(ticket);
    clearTimeout(pending.timer);
    const stream = createWebSocketStream(socket);
    // Consumers attach their own pipeline; this listener covers a peer closing
    // between admission and the HTTP handler resuming its await.
    stream.on("error", () => {
      stream.destroy();
    });
    pending.owner.streams.add(stream);
    this.activeStreams++;
    this.metrics.stream("connected");
    // A stream nobody writes on for a while (a parked WebSocket inside the client's TLS) must
    // not look idle to a proxy or NAT between the gateway and this relay, which would cut it.
    const keepAlive = setInterval(() => socket.ping(), this.limits.heartbeatMs);
    stream.once("close", () => {
      clearInterval(keepAlive);
      release(pending.owner, pending.client);
      pending.owner.streams.delete(stream);
      this.activeStreams--;
      this.metrics.stream("closed");
    });
    pending.resolve(stream);
  }

  private fail(ticket: string, error: Error): void {
    const pending = this.pending.get(ticket);
    if (!pending) return;
    this.pending.delete(ticket);
    pending.owner.pending.delete(ticket);
    release(pending.owner, pending.client);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  snapshot(): {
    onlineGateways: number;
    activeStreams: number;
    pendingStreams: number;
    maxGateways: number;
    maxStreams: number;
    maxStreamsPerGateway: number;
  } {
    return {
      onlineGateways: this.gateways.size,
      activeStreams: this.activeStreams,
      pendingStreams: this.pending.size,
      maxGateways: this.limits.maxGateways,
      maxStreams: this.limits.maxStreams,
      maxStreamsPerGateway: this.limits.maxStreamsPerGateway,
    };
  }

  closeAccount(account: string): void {
    const tunnel = this.gateways.get(account);
    if (!tunnel) return;
    tunnel.revoke();
    tunnel.socket.terminate();
  }

  close(): void {
    for (const tunnel of this.gateways.values()) {
      tunnel.revoke();
      tunnel.socket.terminate();
    }
  }
}

/** Returns a client's reservation on a gateway. */
function release(tunnel: Tunnel, bucket: string | undefined): void {
  if (bucket === undefined) return;
  const held = tunnel.clients.get(bucket)! - 1;
  if (held > 0) tunnel.clients.set(bucket, held);
  else tunnel.clients.delete(bucket);
}

/** An IP address in its plain form, or undefined for anything else. */
function normalizeAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const plain = /^::ffff:/i.test(value) && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  return isIP(plain) ? plain : undefined;
}
