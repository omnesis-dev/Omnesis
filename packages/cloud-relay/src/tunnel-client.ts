// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { pipeline, type Duplex } from "node:stream";
import { createLogger } from "@omnesis/core";
import { createWebSocketStream, WebSocket } from "ws";
import { z } from "zod";
import { gatewayIdSchema } from "./accounts.js";
import { connectOrigin, relayOrigin, SESSION_HEADER, websocketUrl } from "./network.js";
import { recordRelayedClient } from "./relay-client-address.js";
import { OwnedCleanupLifecycle } from "./owned-cleanup-lifecycle.js";
import { DEFAULT_TUNNEL_LIMITS } from "./tunnels.js";
import { TunnelSessionRenewal } from "./tunnel-session-renewal.js";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const log = createLogger("gateway:cloud-relay");
/** Tells the relay this gateway can move its tunnel to an address the relay names. */
const DIRECT_HEADER = "x-omnesis-tunnel-direct";
/** After a named address could not be reached, how long the relay's own address is used. */
const DIRECT_RETRY_MS = 5 * 60_000;
const controlMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      version: z.literal(1),
      heartbeatMs: z.number().int().positive().max(715_827_882),
      rejectChannels: z.literal(true).optional(),
      sessionExpiresAt: z
        .number()
        .int()
        .positive()
        .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000))
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("renewed"),
      version: z.literal(1),
      expiresAt: z
        .number()
        .int()
        .positive()
        .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
    })
    .strict(),
  z
    .object({
      type: z.literal("open"),
      version: z.literal(1),
      ticket: z.string().regex(/^[a-f0-9]{64}$/),
      /** Where the relay accepted this stream from: rate-limit bookkeeping only. */
      client: z.string().max(64).optional(),
    })
    .strict(),
]);

export interface GatewayTunnelState {
  state: "disabled" | "offline" | "connecting" | "online";
  lastConnectedAt?: string;
  lastError?: "tunnel-disconnected";
}

export interface GatewayTunnelOptions {
  relayUrl: string;
  gatewayUrl: string;
  gatewayId: string;
  session: (signal?: AbortSignal) => Promise<string>;
  invalidateSession?: () => void;
  relayCa?: string;
  reconnectMs?: number;
  maxChannels?: number;
}

/** Native reverse tunnel: one outbound control socket and bounded byte-stream channels. */
export class GatewayTunnel {
  private connectionState: GatewayTunnelState["state"] = "disabled";
  private lastConnectedAt: string | undefined;
  private lastError: GatewayTunnelState["lastError"];
  private control: WebSocket | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly channels = new Set<WebSocket>();
  private readonly destinations = new Set<Duplex>();
  private readonly streams = new Set<Duplex>();
  private readonly relay: URL;
  private readonly gatewayId: string;
  private readonly gateway: URL;
  private generation = 0;
  private connecting = false;
  private sessionAbort: AbortController | undefined;
  private invalidatedGeneration = -1;
  private readonly dialing = new Set<AbortController>();
  private readonly onlineWaiters = new Set<() => void>();
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private readonly maxChannels: number;
  private readonly reconnectMs: number;
  private readonly cleanup = new OwnedCleanupLifecycle(() => this.stop());
  private sessionJoin: Promise<void> = Promise.resolve();
  private connectionAttempt: Promise<void> | undefined;
  private renewal: TunnelSessionRenewal | undefined;
  private readonly connections = new Set<Promise<void>>();
  private readonly resourceClosures = new Set<Promise<void>>();
  /**
   * Where the relay asked for the tunnel instead of its own address: the same
   * relay, reached without the proxy that fronts its pages.
   */
  private direct: URL | undefined;
  private directRefusedUntil = 0;

  constructor(private readonly options: GatewayTunnelOptions) {
    this.relay = relayOrigin(options.relayUrl);
    this.gateway = relayOrigin(options.gatewayUrl);
    if (this.gateway.protocol !== "https:") throw new Error("Tunnel gateway must terminate TLS");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(this.gateway.hostname)) {
      throw new Error("Tunnel destination must be a local gateway");
    }
    this.gatewayId = gatewayIdSchema.parse(options.gatewayId);
    this.maxChannels = options.maxChannels ?? DEFAULT_TUNNEL_LIMITS.maxStreamsPerGateway;
    this.reconnectMs = options.reconnectMs ?? 1000;
    for (const value of [this.maxChannels, this.reconnectMs]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Tunnel client limits must be positive integers");
    }
  }

  status(): GatewayTunnelState {
    return {
      state: this.connectionState,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Settles once the relay has accepted this tunnel, at once when it already has, or rejects when
   * `signal` aborts first. Until then the relay drops public connections for this gateway.
   */
  online(signal: AbortSignal): Promise<void> {
    if (this.connectionState === "online") return Promise.resolve();
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const accepted = (): void => {
        signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = (): void => {
        this.onlineWaiters.delete(accepted);
        reject(signal.reason);
      };
      this.onlineWaiters.add(accepted);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  start(): void {
    if (this.stopped || this.control || this.connecting) return;
    this.connectionState = "connecting";
    this.connecting = true;
    const generation = ++this.generation;
    const sessionAbort = new AbortController();
    this.sessionAbort = sessionAbort;
    this.connectionAttempt = Promise.resolve()
      .then(async () => {
        await this.sessionJoin;
        sessionAbort.signal.throwIfAborted();
        return this.acquireSession(sessionAbort);
      })
      .then((session) => {
        if (this.stopped || generation !== this.generation) return;
        const endpoint = this.direct ?? this.relay;
        let routingSession = session;
        this.renewal = undefined;
        const control = new WebSocket(websocketUrl(endpoint, "/_relay/v1/tunnel"), {
          headers: {
            [SESSION_HEADER]: session,
            "x-omnesis-gateway-id": this.gatewayId,
            "x-omnesis-tunnel-protocol": "2",
            "x-omnesis-reject-channels": "1",
            "x-omnesis-tunnel-renewal": "1",
            ...(endpoint === this.relay && Date.now() >= this.directRefusedUntil
              ? { [DIRECT_HEADER]: "1" }
              : {}),
          },
          ca: this.options.relayCa,
          handshakeTimeout: 15_000,
          perMessageDeflate: false,
          maxPayload: 4096,
        });
        this.retainClose(control);
        this.control = control;
        let watchdogMs = 90_000;
        let ready = false;
        let rejectChannels = false;
        const heartbeat = (): void => {
          clearTimeout(this.watchdog);
          this.watchdog = setTimeout(() => control.terminate(), watchdogMs);
        };
        control.once("unexpected-response", (request, response) => {
          if (endpoint === this.relay) this.direct = movedTunnel(response);
          this.refusedHandshake(control, request, response, generation);
        });
        control.on("open", heartbeat);
        control.on("ping", heartbeat);
        control.on("message", (raw) => {
          if (this.stopped || generation !== this.generation || this.control !== control) return;
          let message;
          try {
            message = controlMessage.parse(JSON.parse(raw.toString()));
          } catch {
            control.close(1008, "Invalid control message");
            return;
          }
          if (message.type === "ready") {
            if (ready) {
              control.terminate();
              return;
            }
            ready = true;
            rejectChannels = message.rejectChannels === true;
            this.connectionState = "online";
            this.lastConnectedAt = new Date().toISOString();
            this.lastError = undefined;
            watchdogMs = message.heartbeatMs * 3;
            heartbeat();
            if (message.sessionExpiresAt !== undefined) {
              this.renewal = new TunnelSessionRenewal({
                expiresAt: message.sessionExpiresAt,
                session: routingSession,
                acquire: (controller) => this.acquireSession(controller),
                joined: () => this.sessionJoin,
                invalidate: () => this.options.invalidateSession?.(),
                send: (token) =>
                  control.send(JSON.stringify({ type: "renew", version: 1, session: token })),
                adopt: (token) => {
                  routingSession = token;
                },
                observe: (error) => {
                  if (!this.cleanup.observe(error) && !this.stopped)
                    log.warn(
                      "Cloud relay session renewal unavailable; retaining the accepted deadline",
                    );
                },
                terminate: () => control.terminate(),
              });
            }
            for (const accepted of this.onlineWaiters) accepted();
            this.onlineWaiters.clear();
          }
          if (message.type === "renewed") {
            if (!this.renewal?.accept(message.expiresAt)) control.terminate();
          }
          if (message.type === "open") {
            if (this.channels.size >= this.maxChannels) {
              // Capacity accounting closes asynchronously at each end. Refuse only this ticket;
              // a relay without rejection support expires its reservation on its own deadline.
              if (rejectChannels)
                control.send(
                  JSON.stringify({ type: "reject", version: 1, ticket: message.ticket }),
                );
              return;
            }
            this.openChannel(
              endpoint,
              message.ticket,
              routingSession,
              generation,
              message.client,
              () => routingSession,
            );
          }
        });
        control.on("error", () => {
          control.terminate();
        });
        control.once("close", () => {
          if (generation !== this.generation || this.control !== control) return;
          sessionAbort.abort();
          this.renewal?.stop();
          clearTimeout(this.watchdog);
          this.control = undefined;
          if (endpoint !== this.relay && !ready) {
            // The named address does not serve this gateway; the relay's own still does.
            this.direct = undefined;
            this.directRefusedUntil = Date.now() + DIRECT_RETRY_MS;
          }
          for (const dial of this.dialing) dial.abort();
          for (const channel of this.channels) channel.terminate();
          for (const destination of this.destinations) destination.destroy();
          for (const stream of this.streams) stream.destroy();
          this.scheduleReconnect();
        });
      })
      .catch(async (error: unknown) => {
        this.cleanup.observe(error);
        if (this.stopped || generation !== this.generation) return;
        this.connectionState = "offline";
        this.lastError = "tunnel-disconnected";
        log.warn("Cloud relay session unavailable; waiting for acquisition cleanup before retry");
        // Cancellation ends the caller's wait, not the credential operation.
        // Never overlap another acquisition with an unjoined session source.
        await this.sessionJoin;
        this.scheduleReconnect();
      })
      .finally(() => {
        if (generation === this.generation) this.connecting = false;
      });
  }

  private acquireSession(controller: AbortController): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => controller.abort(new Error("Cloud relay routing session acquisition timed out")),
        30_000,
      );
      const aborted = (): void => {
        clearTimeout(timer);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", aborted, { once: true });
      const operation = this.cleanup.run(async () => {
        controller.signal.throwIfAborted();
        return this.options.session(controller.signal);
      });
      this.sessionJoin = operation.then(
        () => {},
        () => {},
      );
      operation.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", aborted);
      });
    });
  }

  private openChannel(
    endpoint: URL,
    ticket: string,
    session: string,
    generation: number,
    client: string | undefined,
    currentSession: () => string,
  ): void {
    const ws = new WebSocket(websocketUrl(endpoint, "/_relay/v1/data"), {
      headers: { [SESSION_HEADER]: session, "x-omnesis-relay-ticket": ticket },
      ca: this.options.relayCa,
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      maxPayload: 1024 * 1024,
    });
    this.retainClose(ws);
    ws.once("unexpected-response", (request, response) =>
      this.refusedHandshake(ws, request, response, generation, session === currentSession()),
    );
    const dial = new AbortController();
    this.dialing.add(dial);
    this.channels.add(ws);
    ws.on("error", () => {
      ws.terminate();
    });
    ws.once("close", () => {
      dial.abort();
      this.dialing.delete(dial);
      this.channels.delete(ws);
    });
    ws.once("open", () => {
      if (this.stopped || generation !== this.generation) {
        ws.terminate();
        return;
      }
      const stream = createWebSocketStream(ws);
      this.retainClose(stream);
      this.streams.add(stream);
      stream.once("close", () => this.streams.delete(stream));
      stream.on("error", () => {
        stream.destroy();
      });
      const connection = Promise.resolve()
        .then(() => {
          dial.signal.throwIfAborted();
          return connectOrigin(this.gateway, undefined, dial.signal, true);
        })
        .then((destination) => {
          this.retainClose(destination);
          if (this.stopped || generation !== this.generation || ws.readyState !== WebSocket.OPEN) {
            destination.destroy();
            stream.destroy();
            return;
          }
          // Before any byte reaches the gateway, so its first request already sees it.
          recordRelayedClient(destination as Socket, client);
          this.destinations.add(destination);
          destination.once("close", () => {
            this.destinations.delete(destination);
          });
          pipeline(stream, destination, () => {
            stream.destroy();
            destination.destroy();
          });
          pipeline(destination, stream, () => {
            stream.destroy();
            destination.destroy();
          });
        })
        .catch(() => {
          stream.destroy();
        })
        .finally(() => {
          this.connections.delete(connection);
        });
      this.connections.add(connection);
    });
  }

  private refusedHandshake(
    socket: WebSocket,
    request: ClientRequest,
    response: IncomingMessage,
    generation: number,
    currentSession = true,
  ): void {
    try {
      if (
        response.statusCode === 401 &&
        currentSession &&
        !this.stopped &&
        generation === this.generation &&
        this.invalidatedGeneration !== generation
      ) {
        this.invalidatedGeneration = generation;
        this.options.invalidateSession?.();
        this.control?.terminate();
      }
    } catch (error) {
      if (!this.cleanup.observe(error)) log.warn("Cloud relay routing session invalidation failed");
    } finally {
      response.destroy();
      request.destroy();
      socket.terminate();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.connectionState = "offline";
    this.lastError = "tunnel-disconnected";
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.start();
    }, this.reconnectMs);
  }

  stop(): void {
    this.connectionState = "disabled";
    this.stopped = true;
    this.generation++;
    this.sessionAbort?.abort();
    this.renewal?.stop();
    clearTimeout(this.reconnect);
    clearTimeout(this.watchdog);
    for (const dial of this.dialing) dial.abort();
    this.control?.terminate();
    for (const channel of this.channels) channel.terminate();
    for (const destination of this.destinations) destination.destroy();
    for (const stream of this.streams) stream.destroy();
  }

  cleanupFailure(): unknown | undefined {
    return this.cleanup.receipt();
  }

  close(): Promise<void> {
    this.stop();
    return this.cleanup.close(async () => {
      await this.connectionAttempt;
      await this.renewal?.close();
      await Promise.all([...this.connections]);
      await Promise.all([...this.resourceClosures]);
    });
  }

  private retainClose(resource: {
    closed?: boolean;
    readyState?: number;
    once(event: "close", listener: () => void): unknown;
  }): void {
    if (
      resource.closed === true ||
      (resource.readyState !== undefined && resource.readyState === WebSocket.CLOSED)
    )
      return;
    const proof = new Promise<void>((resolve) => {
      resource.once("close", () => {
        this.resourceClosures.delete(proof);
        resolve();
      });
    });
    this.resourceClosures.add(proof);
  }
}

/**
 * The address a relay behind a reverse proxy names for the tunnel, from its
 * refusal of a handshake that offered to move. The relay already holds this
 * gateway's session, so it may name any HTTPS address; anything else is ignored.
 */
function movedTunnel(response: IncomingMessage): URL | undefined {
  if (response.statusCode !== 307) return undefined;
  try {
    const url = new URL(response.headers.location!);
    if (url.pathname !== "/_relay/v1/tunnel" || url.search || url.hash) return undefined;
    return relayOrigin(`${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`);
  } catch {
    return undefined;
  }
}
