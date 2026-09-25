// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  isWsCommand,
  isWsEnvelope,
  isWsEvent,
  isWsResponse,
  makeCommand,
  makeResponseErr,
  makeResponseOk,
  parseResponsePayload,
  PROTOCOL_VERSION,
  toErrorMessage,
  websocketAuthProtocol,
  WsInvalidInputError,
  type WsCommand,
  type WsCommandType,
  type WsCorrelationId,
  type WsEventPayload,
  type WsEventType,
  type WsRequestPayload,
  type WsResponsePayload,
} from "@omnesis/core";
import { type DeviceCapability } from "@omnesis/types";
import { DEFAULT_WS_HEARTBEAT_TIMEOUT_MS } from "./tunables.js";

const log = createLogger("collector:ws");

type EventHandler = (type: string, payload: unknown) => void;
type CommandHandler = (command: WsCommand) => Promise<unknown>;

interface PendingOutbound {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Collector-side client for the gateway's /device/ws channel.
 *
 * Connects, identifies via `hello` command, then:
 *   - forwards events from gateway to onEvent handler
 *   - dispatches commands from gateway to onCommand handler
 *   - lets caller emit events upstream via `emitEvent`
 *   - lets caller issue commands upstream via `sendCommand`
 * On disconnect, reconnects with exponential backoff.
 */
export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private apiKey: string;
  private capabilities: DeviceCapability;
  private reconnectDelay: number;
  private readonly initialReconnectDelay: number;
  private readonly maxReconnectDelay = 30000;
  private readonly commandTimeoutMs = 30000;
  private readonly heartbeatTimeoutMs: number;
  private onEventHandler: EventHandler | null = null;
  private onCommandHandler: CommandHandler | null = null;
  private closed = false;
  private authenticated = false;
  private identity: WsResponsePayload<"hello"> | null = null;
  private pending = new Map<WsCorrelationId, PendingOutbound>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onSocketError: ((error: unknown) => void) | undefined;

  constructor(
    gatewayUrl: string,
    apiKey: string,
    opts?: {
      reconnectDelay?: number;
      capabilities?: DeviceCapability;
      heartbeatTimeoutMs?: number;
      /**
       * Told the error behind a failed socket, before the reconnect that
       * follows. A caller that keeps its own trust store uses it to re-check
       * the gateway's certificate when a handshake stops verifying.
       */
      onSocketError?: (error: unknown) => void;
    },
  ) {
    this.wsUrl = gatewayUrl.replace(/^http/, "ws") + "/device/ws";
    this.apiKey = apiKey;
    this.onSocketError = opts?.onSocketError;
    this.capabilities = opts?.capabilities ?? {};
    this.initialReconnectDelay = opts?.reconnectDelay ?? 1000;
    this.reconnectDelay = this.initialReconnectDelay;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? DEFAULT_WS_HEARTBEAT_TIMEOUT_MS;
  }

  /**
   * Whether the gateway has answered this socket's `hello`. False while
   * reconnecting — a caller that watches for a credential going stale uses
   * it to decide when an HTTP probe is worth making.
   */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Identity and scopes the gateway bound to the current authenticated socket. */
  getIdentity(): WsResponsePayload<"hello"> | null {
    return this.identity;
  }

  /** Set capabilities to be sent on each reconnect (e.g. updated source list). */
  setCapabilities(caps: DeviceCapability): void {
    this.capabilities = caps;
  }

  onEvent(handler: EventHandler): void {
    this.onEventHandler = handler;
  }

  onCommand(handler: CommandHandler): void {
    this.onCommandHandler = handler;
  }

  connect(): void {
    if (this.closed || this.ws || this.reconnectTimer) return;

    try {
      const ws = new WebSocket(this.wsUrl, websocketAuthProtocol(this.apiKey));
      this.ws = ws;
      this.armHeartbeatWatchdog(ws);

      ws.onopen = () => {
        if (this.ws !== ws) return;
        log.info(`WebSocket connected to gateway at ${this.wsUrl}`);
        this.reconnectDelay = this.initialReconnectDelay;
        this.armHeartbeatWatchdog(ws);
        this.sendHello();
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        this.armHeartbeatWatchdog(ws);
        this.handleMessage(typeof event.data === "string" ? event.data : "");
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.handleDisconnect("WebSocket closed");
      };

      ws.onerror = (err) => {
        log.debug(`WebSocket error: ${String(err)}`);
        this.onSocketError?.((err as { error?: unknown }).error ?? err);
      };
    } catch (err) {
      log.warn(`Failed to create WebSocket connection: ${toErrorMessage(err)}`);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.handleDisconnect("WebSocket closed");
    if (ws) {
      ws.close();
    }
  }

  /**
   * Send an event to the gateway. Dropped silently if not connected.
   *
   * Accepts a known `WsEventType` with the matching typed payload, OR a
   * string for the (rare) dynamic-type case (e.g. event bridges that
   * forward upstream events without re-typing). Prefer the typed call
   * site at known producers.
   */
  emitEvent<K extends WsEventType>(type: K, payload: WsEventPayload<K>): void;
  emitEvent(type: string, payload: unknown): void;
  emitEvent(type: string, payload: unknown): void {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Traceable rather than invisible: an event emitted across a reconnect
      // is routine, but one that carries a result nothing else will restate
      // is a hole worth being able to find.
      log.debug(`Dropping ${type}: the socket is not authenticated`);
      return;
    }
    this.ws.send(JSON.stringify({ kind: "event", type, payload }));
  }

  /** Send a command to the gateway, await response. */
  sendCommand<K extends WsCommandType>(
    type: K,
    payload: WsRequestPayload<K>,
  ): Promise<WsResponsePayload<K>> {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected / not authenticated"));
    }
    const command = makeCommand(type, payload);
    return new Promise<WsResponsePayload<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`command ${type} timed out`));
      }, this.commandTimeoutMs);
      this.pending.set(command.id, {
        resolve: (r) => resolve(r as WsResponsePayload<K>),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(command));
    });
  }

  // ── private ─────────────────────────────────────────────────────────────

  private armHeartbeatWatchdog(ws: WebSocket): void {
    this.clearHeartbeatWatchdog();
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws !== ws || this.closed) return;
      log.warn(
        `WebSocket received no gateway frames for ${this.heartbeatTimeoutMs}ms; reconnecting`,
      );
      this.ws = null;
      this.handleDisconnect("gateway heartbeat timed out");
      try {
        ws.close();
      } catch {
        // The reconnect has already been scheduled.
      }
    }, this.heartbeatTimeoutMs);
  }

  private clearHeartbeatWatchdog(): void {
    if (!this.heartbeatTimer) return;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleDisconnect(reason: string): void {
    this.clearHeartbeatWatchdog();
    this.ws = null;
    this.authenticated = false;
    this.identity = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    if (this.closed) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    log.warn(`WebSocket disconnected, reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(delay * 2, this.maxReconnectDelay);
  }

  private sendHello(): void {
    const cmd = makeCommand("hello", {
      capabilities: this.capabilities,
      protocolVersion: PROTOCOL_VERSION,
    });
    this.pending.set(cmd.id, {
      resolve: (result) => {
        const parsed = parseResponsePayload("hello", result);
        if (!parsed.ok) {
          log.error(`WebSocket hello returned an invalid identity: ${parsed.error}`);
          const ws = this.ws;
          this.handleDisconnect("invalid hello response");
          ws?.close();
          return;
        }
        this.identity = parsed.value;
        this.authenticated = true;
        log.info("WebSocket authenticated with gateway");
      },
      reject: (err) => {
        log.error(`WebSocket hello failed: ${err.message}`);
      },
      timer: setTimeout(() => {
        this.pending.delete(cmd.id);
        log.error("WebSocket hello timed out");
      }, this.commandTimeoutMs),
    });
    this.ws!.send(JSON.stringify(cmd));
  }

  private handleMessage(raw: string): void {
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("Received invalid JSON from gateway WebSocket");
      return;
    }
    if (!isWsEnvelope(parsed)) {
      log.warn("Received non-envelope from gateway WebSocket");
      return;
    }

    if (isWsResponse(parsed)) {
      const pending = this.pending.get(parsed.correlationId);
      if (!pending) return;
      this.pending.delete(parsed.correlationId);
      clearTimeout(pending.timer);
      if (parsed.ok) pending.resolve(parsed.result);
      else pending.reject(new Error(`${parsed.error.code}: ${parsed.error.message}`));
      return;
    }

    if (isWsEvent(parsed)) {
      if (parsed.type === "ping") return; // keepalive
      this.onEventHandler?.(parsed.type, parsed.payload);
      return;
    }

    if (isWsCommand(parsed)) {
      void this.handleCommand(parsed);
      return;
    }
  }

  private async handleCommand(command: WsCommand): Promise<void> {
    const handler = this.onCommandHandler;
    if (!handler) {
      this.ws?.send(
        JSON.stringify(
          makeResponseErr(command.id, "unsupported", `no handler for ${command.type}`),
        ),
      );
      return;
    }
    try {
      const result = await handler(command);
      this.ws?.send(JSON.stringify(makeResponseOk(command.id, result)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof WsInvalidInputError ? err.code : "handler_error";
      this.ws?.send(JSON.stringify(makeResponseErr(command.id, code, msg)));
    }
  }
}
