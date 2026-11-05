// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { pipeline, type Duplex } from "node:stream";
import { createLogger, experimentalEnabled } from "@omnesis/core";
import { createWebSocketStream, WebSocket } from "ws";
import { z } from "zod";
import { gatewayIdSchema } from "./accounts.js";
import { connectOrigin, relayOrigin, SESSION_HEADER, websocketUrl } from "./network.js";
import type { ClientRequest, IncomingMessage } from "node:http";

const log = createLogger("gateway:cloud-relay");
const controlMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      version: z.literal(1),
      heartbeatMs: z.number().int().positive().max(715_827_882),
    })
    .strict(),
  z
    .object({
      type: z.literal("open"),
      version: z.literal(1),
      ticket: z.string().regex(/^[a-f0-9]{64}$/),
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
  private readonly relay: URL;
  private readonly gatewayId: string;
  private readonly gateway: URL;
  private generation = 0;
  private connecting = false;
  private sessionAbort: AbortController | undefined;
  private invalidatedGeneration = -1;
  private readonly dialing = new Set<AbortController>();
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private readonly maxChannels: number;
  private readonly reconnectMs: number;

  constructor(private readonly options: GatewayTunnelOptions) {
    if (!experimentalEnabled()) throw new Error("Cloud relay requires OMNESIS_EXPERIMENTAL=1");
    this.relay = relayOrigin(options.relayUrl);
    this.gateway = relayOrigin(options.gatewayUrl);
    if (this.gateway.protocol !== "https:") throw new Error("Tunnel gateway must terminate TLS");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(this.gateway.hostname)) {
      throw new Error("Tunnel destination must be a local gateway");
    }
    this.gatewayId = gatewayIdSchema.parse(options.gatewayId);
    this.maxChannels = options.maxChannels ?? 16;
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

  start(): void {
    if (this.stopped || this.control || this.connecting) return;
    this.connectionState = "connecting";
    this.connecting = true;
    const generation = ++this.generation;
    const sessionAbort = new AbortController();
    this.sessionAbort = sessionAbort;
    void Promise.resolve()
      .then(() => this.acquireSession(sessionAbort))
      .then((session) => {
        if (this.stopped || generation !== this.generation) return;
        const control = new WebSocket(websocketUrl(this.relay, "/_relay/v1/tunnel"), {
          headers: {
            [SESSION_HEADER]: session,
            "x-omnesis-gateway-id": this.gatewayId,
            "x-omnesis-tunnel-protocol": "2",
          },
          ca: this.options.relayCa,
          handshakeTimeout: 15_000,
          perMessageDeflate: false,
          maxPayload: 4096,
        });
        this.control = control;
        let watchdogMs = 90_000;
        const heartbeat = (): void => {
          clearTimeout(this.watchdog);
          this.watchdog = setTimeout(() => control.terminate(), watchdogMs);
        };
        control.once("unexpected-response", (request, response) =>
          this.refusedHandshake(control, request, response, generation),
        );
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
            this.connectionState = "online";
            this.lastConnectedAt = new Date().toISOString();
            this.lastError = undefined;
            watchdogMs = message.heartbeatMs * 3;
            heartbeat();
          }
          if (message.type === "open") {
            if (this.channels.size >= this.maxChannels) {
              control.close(1013, "Channel limit reached");
              return;
            }
            this.openChannel(message.ticket, session, generation);
          }
        });
        control.on("error", () => {
          control.terminate();
        });
        control.once("close", () => {
          if (generation !== this.generation || this.control !== control) return;
          sessionAbort.abort();
          clearTimeout(this.watchdog);
          this.control = undefined;
          for (const dial of this.dialing) dial.abort();
          for (const channel of this.channels) channel.terminate();
          for (const destination of this.destinations) destination.destroy();
          this.scheduleReconnect();
        });
      })
      .catch(() => {
        if (this.stopped || generation !== this.generation) return;
        log.warn("Cloud relay session unavailable; retrying");
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
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return this.options.session(controller.signal);
        })
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", aborted);
        });
    });
  }

  private openChannel(ticket: string, session: string, generation: number): void {
    const ws = new WebSocket(websocketUrl(this.relay, "/_relay/v1/data"), {
      headers: { [SESSION_HEADER]: session, "x-omnesis-relay-ticket": ticket },
      ca: this.options.relayCa,
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      maxPayload: 1024 * 1024,
    });
    ws.once("unexpected-response", (request, response) =>
      this.refusedHandshake(ws, request, response, generation),
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
      const stream = createWebSocketStream(ws);
      stream.on("error", () => {
        stream.destroy();
      });
      void connectOrigin(this.gateway, undefined, dial.signal, true)
        .then((destination) => {
          if (this.stopped || generation !== this.generation || ws.readyState !== WebSocket.OPEN) {
            destination.destroy();
            stream.destroy();
            return;
          }
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
        });
    });
  }

  private refusedHandshake(
    socket: WebSocket,
    request: ClientRequest,
    response: IncomingMessage,
    generation: number,
  ): void {
    try {
      if (
        response.statusCode === 401 &&
        !this.stopped &&
        generation === this.generation &&
        this.invalidatedGeneration !== generation
      ) {
        this.invalidatedGeneration = generation;
        this.options.invalidateSession?.();
        this.control?.terminate();
      }
    } catch {
      log.warn("Cloud relay routing session invalidation failed");
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
    clearTimeout(this.reconnect);
    clearTimeout(this.watchdog);
    for (const dial of this.dialing) dial.abort();
    this.control?.terminate();
    for (const channel of this.channels) channel.terminate();
    for (const destination of this.destinations) destination.destroy();
  }
}
