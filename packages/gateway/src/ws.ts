// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createLogger,
  isWsCommand,
  isWsEnvelope,
  isWsEvent,
  isWsResponse,
  makeCommand,
  makeEvent,
  makeResponseErr,
  makeResponseOk,
  newCorrelationId,
  parseRequestPayload,
  parseResponsePayload,
  PROTOCOL_VERSION,
  type WsCommand,
  type WsCommandType,
  type WsCorrelationId,
  type WsEnvelope,
  type WsEvent,
  type WsRequestPayload,
  type WsResponse,
  type WsResponsePayload,
} from "@omnesis/core";
import {
  missingHostedWriteScopes,
  scopeSatisfies,
  SCOPE_ADMIN,
  type DeviceCapability,
  type DeviceId,
  type DeviceKind,
  type Scope,
  type SourceId,
  type TokenId,
} from "@omnesis/types";
import { getDevice } from "./data/repositories/DeviceRepository.js";
import { isTokenActive, lookupToken } from "./data/repositories/TokenRepository.js";
import { wsHelloRateLimiter, type IpRateLimiter } from "./rate-limit.js";
import type { WriteGate } from "./write-gate.js";

const log = createLogger("gateway:ws");

interface WsHandle {
  send: (data: string) => void;
  close: () => void;
}

/**
 * Transport-level liveness channel for one socket.
 *
 * WebSocket ping/pong frames are answered by the peer's WebSocket
 * implementation itself — `ws` on the collector, `URLSessionWebSocketTask` on
 * iOS, OkHttp on Android — so no client application code participates. The
 * gateway supplies this when it has the underlying socket; a caller that has
 * only the send/close pair (in-process test handles) omits it and its
 * connections are never probed.
 */
export interface WsLiveness {
  /** Send a WebSocket ping frame. */
  ping(): void;
  /** Destroy the socket immediately, without a close handshake. */
  terminate(): void;
}

interface ConnectionState {
  authenticated: boolean;
  deviceId: DeviceId | null;
  deviceKind: DeviceKind | null;
  scopes: Scope[];
  upgradeAuth: WsUpgradeAuth | null;
  authTimer: ReturnType<typeof setTimeout> | null;
  /** Source IP captured at upgrade time. Populated from the HTTP
   *  upgrade request by the index.ts handler. Used by the hello
   *  handshake's per-IP rate limiter. */
  clientIp: string;
  /** Ping/terminate channel, when the caller supplied the raw socket. */
  liveness: WsLiveness | null;
  /** A ping was sent on the last heartbeat and no pong has answered it. */
  awaitingPong: boolean;
}

export interface DeviceConnection {
  deviceId: DeviceId;
  scopes: readonly Scope[];
  /** Internal hello result; never supplied by a client. */
  memberConfigChangedSourceIds?: SourceId[];
}

export interface WsUpgradeAuth {
  tokenId: TokenId;
  deviceId: DeviceId;
  scopes: Scope[];
}

export type WsUpgradeAuthResult =
  | { ok: true; auth: WsUpgradeAuth }
  | {
      ok: false;
      status: 401 | 429;
      code: "invalid_token" | "rate_limited";
      message: string;
    };

interface PendingOutbound {
  type: WsCommandType;
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Connection the command was dispatched on. Tagged at `sendCommand`
   * time so `onClose` can synchronously reject any pending commands
   * tied to a closing socket — without it, admin callers wait the
   * full `commandTimeoutMs` (30s by default) before discovering that
   * the device disconnected mid-command.
   */
  ws: WsHandle;
}

/** Structured remote command rejection; callers may distinguish capacity from failure. */
export class WsCommandError extends Error {
  override readonly name = "WsCommandError";

  constructor(
    readonly code: string,
    /** The device's own wording, without the code this error's message leads with. */
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
  }
}

const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

/**
 * Hard cap on concurrent WS connections. A personal gateway serves a
 * handful of devices; this ceiling is generous headroom while bounding a
 * connection-exhaustion DoS (opening many sockets without ever
 * authenticating — each would otherwise sit in `connections` until the
 * per-socket auth timeout). When exceeded, new opens are refused.
 */
const MAX_WS_CONNECTIONS = 512;

export interface DeviceWsOptions {
  db: Db;
  /**
   * Single-writer gate. Every DB mutation (touchDevice, updateDeviceCapabilities,
   * validateToken's last-used-at beacon) goes through this proxy so there's
   * exactly one writable handle in the process.
   */
  writeGate: WriteGate;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  commandTimeoutMs?: number;
  /** Concurrent-connection ceiling. Defaults to MAX_WS_CONNECTIONS. */
  maxConnections?: number;
  /** Handler for events emitted by a device. */
  onDeviceEvent?: (conn: DeviceConnection, event: WsEvent) => void;
  /** Handler for commands issued by a device. Returns the result payload. */
  onDeviceCommand?: (conn: DeviceConnection, command: WsCommand) => Promise<unknown>;
  /**
   * Fired right after a device successfully completes the hello handshake.
   * Lets the gateway push initial state (e.g. sources.snapshot for collectors).
   */
  onDeviceConnected?: (conn: DeviceConnection) => void;
  /** Fired after one authenticated device socket has been removed. */
  onDeviceDisconnected?: (conn: DeviceConnection) => void;
  /** Awaited before a collector hello succeeds, so declarations fail closed. */
  onCollectorConnected?: (deviceId: DeviceId) => Promise<void>;
  /** Fired after the last authenticated socket for a collector closes. */
  onCollectorDisconnected?: (deviceId: DeviceId) => Promise<void>;
}

/**
 * Bidirectional WebSocket channel between gateway and devices.
 *
 * Protocol:
 *   1. Device connects to /device/ws with a bearer token on the HTTP upgrade.
 *   2. Device sends command type="hello" with {capabilities?, protocolVersion}.
 *   3. Gateway validates protocolVersion, stores capabilities on device record,
 *      responds with {deviceId, scopes, deviceName, deviceKind, protocolVersion}.
 *      Mismatched protocolVersion → response error code "protocol_version_mismatch"
 *      and the socket is closed.
 *   4. Gateway may push events or commands; device may push events or commands.
 *      Every command type's request and response payload schemas live in
 *      `@omnesis/core/ws-messages.ts` — both ends consult the same registry.
 *   5. Heartbeat event "ping" fires every heartbeatIntervalMs from gateway.
 *      The same tick sends a WebSocket ping FRAME on every socket that has a
 *      liveness channel and drops any that left the previous one unanswered,
 *      so a peer that vanished without a FIN stops counting as connected.
 */
export class DeviceWsServer {
  private connections = new Map<WsHandle, ConnectionState>();
  private byDevice = new Map<DeviceId, Set<WsHandle>>();
  private pending = new Map<WsCorrelationId, PendingOutbound>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Db;
  private readonly w: WriteGate;
  private readonly authTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private readonly onDeviceEvent: DeviceWsOptions["onDeviceEvent"];
  private readonly onDeviceCommand: DeviceWsOptions["onDeviceCommand"];
  private readonly onDeviceConnected: DeviceWsOptions["onDeviceConnected"];
  private readonly onDeviceDisconnected: DeviceWsOptions["onDeviceDisconnected"];
  private readonly onCollectorConnected: DeviceWsOptions["onCollectorConnected"];
  private readonly onCollectorDisconnected: DeviceWsOptions["onCollectorDisconnected"];
  // Per-IP rate limiter for token checks. Applied before token lookup so a
  // brute-forcer can't run thousands of candidate tokens against the WS
  // surface inside a window.
  private readonly helloLimiter: IpRateLimiter = wsHelloRateLimiter();
  private readonly maxConnections: number;

  constructor(opts: DeviceWsOptions) {
    this.db = opts.db;
    this.w = opts.writeGate;
    this.authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxConnections = opts.maxConnections ?? MAX_WS_CONNECTIONS;
    this.onDeviceEvent = opts.onDeviceEvent;
    this.onDeviceCommand = opts.onDeviceCommand;
    this.onDeviceConnected = opts.onDeviceConnected;
    this.onDeviceDisconnected = opts.onDeviceDisconnected;
    this.onCollectorConnected = opts.onCollectorConnected;
    this.onCollectorDisconnected = opts.onCollectorDisconnected;
  }

  /**
   * Validate the device token before the HTTP request upgrades to WebSocket.
   * This keeps invalid-token probes on the HTTP boundary instead of allocating
   * an unauthenticated socket and waiting for an application-frame `hello`.
   */
  authenticateUpgradeToken(clientIp: string, token: string): WsUpgradeAuthResult {
    const limit = this.helloLimiter.consume(clientIp);
    if (limit) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: "too many WebSocket authentication attempts",
      };
    }

    const info = lookupToken(this.db, token);
    if (!info) {
      log.warn(`Rejected WS upgrade from ${clientIp} — invalid token`);
      return { ok: false, status: 401, code: "invalid_token", message: "invalid token" };
    }

    return {
      ok: true,
      auth: { tokenId: info.id, deviceId: info.deviceId, scopes: info.scopes },
    };
  }

  start(): void {
    this.heartbeatTimer = setInterval(() => {
      // Evict dead sockets before anything else this tick: everything below
      // (and every push transport decision) reads the connection table.
      this.sweepLiveness();
      this.broadcast(makeEvent("ping", { t: Date.now() }));
      // Update last-seen for all authenticated devices while we're at it.
      // Fire-and-forget through the writer gate — this is an activity beacon,
      // not load-bearing, and awaiting on the heartbeat loop would serialize
      // every device's touch through a single postMessage round-trip.
      for (const state of this.connections.values()) {
        if (state.authenticated && state.deviceId) {
          void this.w.touchDevice(state.deviceId).catch(() => {
            /* already logged */
          });
        }
      }
    }, this.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Reject any pending commands so callers don't hang.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("gateway shutting down"));
    }
    this.pending.clear();
  }

  onOpen(
    ws: WsHandle,
    clientIp: string = "unknown",
    upgradeAuth: WsUpgradeAuth | null = null,
    liveness: WsLiveness | null = null,
  ): void {
    // Concurrent-connection cap: refuse new sockets past the ceiling
    // so a compromised token or buggy client can't exhaust the connection
    // table. Legitimate use stays far below this.
    if (this.connections.size >= this.maxConnections) {
      log.warn(`WS connection cap reached (${this.maxConnections}); refusing ${clientIp}`);
      this.sendRaw(
        ws,
        makeResponseErr(newCorrelationId(), "too_many_connections", "too many connections"),
      );
      ws.close();
      return;
    }
    const authTimer = setTimeout(() => {
      log.warn("WS client did not authenticate in time, closing");
      this.sendRaw(ws, makeResponseErr(newCorrelationId(), "auth_timeout", "auth timeout"));
      this.closeConnection(ws, "authentication timed out");
    }, this.authTimeoutMs);

    this.connections.set(ws, {
      authenticated: false,
      deviceId: null,
      deviceKind: null,
      scopes: [],
      upgradeAuth,
      authTimer,
      clientIp,
      liveness,
      awaitingPong: false,
    });
  }

  /** A WebSocket pong frame arrived — the peer answered this tick's ping. */
  onPong(ws: WsHandle): void {
    const state = this.connections.get(ws);
    if (state) state.awaitingPong = false;
  }

  /**
   * Drop every socket whose peer stopped answering.
   *
   * A phone that loses connectivity without a TCP FIN — a tunnel collapsing, a
   * radio switching off, an access point dying — leaves the gateway holding an
   * OPEN socket whose writes only ever buffer. Without this sweep the device
   * stays in `byDevice`, `isConnected` keeps reporting it online, and every
   * notification wake is dispatched into the void as a successful `socket`
   * send instead of falling back to APNs/FCM/relay — until the kernel finally
   * gives up on the connection, which takes minutes.
   *
   * One ping frame per heartbeat, one interval of grace: a socket that has not
   * answered the previous tick's ping is dropped and destroyed, so a dead peer
   * leaves the connection table within two heartbeat intervals.
   */
  private sweepLiveness(): void {
    for (const [ws, state] of [...this.connections]) {
      const liveness = state.liveness;
      if (!liveness) continue;
      if (state.awaitingPong) {
        const who = state.deviceId ? `device ${state.deviceId}` : `client ${state.clientIp}`;
        log.warn(`WS heartbeat unanswered by ${who}; dropping the socket`);
        this.dropConnection(ws, "heartbeat unanswered");
        this.terminateQuietly(liveness);
        continue;
      }
      state.awaitingPong = true;
      try {
        liveness.ping();
      } catch {
        // The transport is already gone; treat it exactly like a missed pong.
        this.dropConnection(ws, "heartbeat send failed");
        this.terminateQuietly(liveness);
      }
    }
  }

  /**
   * `terminate`, never `close`: a close handshake waits for a reply the dead
   * peer will never send.
   */
  private terminateQuietly(liveness: WsLiveness): void {
    try {
      liveness.terminate();
    } catch {
      // The transport has already torn the socket down.
    }
  }

  onMessage(ws: WsHandle, message: string | Buffer): void {
    const raw = typeof message === "string" ? message : message.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendRaw(ws, makeResponseErr(newCorrelationId(), "invalid_json", "invalid JSON"));
      return;
    }

    if (!isWsEnvelope(parsed)) {
      this.sendRaw(ws, makeResponseErr(newCorrelationId(), "invalid_envelope", "invalid envelope"));
      return;
    }

    const state = this.connections.get(ws);
    if (!state) return;

    if (isWsResponse(parsed)) {
      this.handleResponse(ws, state, parsed);
      return;
    }

    if (!state.authenticated) {
      if (isWsCommand(parsed) && parsed.type === "hello") {
        void this.handleHello(ws, state, parsed).catch((err) => {
          log.error(`handleHello threw: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      this.sendRaw(
        ws,
        makeResponseErr(
          isWsCommand(parsed) ? parsed.id : newCorrelationId(),
          "not_authenticated",
          "authenticate via hello command first",
        ),
      );
      return;
    }

    if (isWsCommand(parsed)) {
      this.handleCommand(ws, state, parsed);
      return;
    }

    if (isWsEvent(parsed)) {
      this.handleEvent(state, parsed);
      return;
    }
  }

  onClose(ws: WsHandle): void {
    this.dropConnection(ws, "device disconnected");
  }

  /**
   * Synchronously evict every socket authenticated as a device.
   *
   * Credential repair deletes the device's previous tokens in the same
   * transaction that mints replacements. A socket authenticated just before
   * that commit would otherwise keep its already-authorized connection. The
   * pairing service calls this after the transaction commits and before it
   * returns the new credentials, closing that race without requiring callers
   * to wait for the transport's asynchronous close callback.
   */
  disconnectDevice(deviceId: DeviceId): number {
    const sockets = [...this.connections]
      .filter(
        ([, state]) => state.deviceId === deviceId || state.upgradeAuth?.deviceId === deviceId,
      )
      .map(([ws]) => ws);
    for (const ws of sockets) {
      this.dropConnection(ws, "device credentials replaced");
      try {
        ws.close();
      } catch {
        // The socket has already been removed from every authorization map.
      }
    }
    return sockets.length;
  }

  private dropConnection(ws: WsHandle, reason: string): void {
    const state = this.connections.get(ws);
    if (!state) return;
    if (state.authTimer) clearTimeout(state.authTimer);
    if (state.deviceId) {
      const set = this.byDevice.get(state.deviceId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          this.byDevice.delete(state.deviceId);
          if (state.deviceKind === "collector" && this.onCollectorDisconnected) {
            void this.onCollectorDisconnected(state.deviceId).catch((err: unknown) => {
              log.warn(
                `Collector disconnect hook failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        }
      }
    }
    this.connections.delete(ws);
    if (state.deviceId && state.authenticated && this.onDeviceDisconnected) {
      try {
        this.onDeviceDisconnected({ deviceId: state.deviceId, scopes: state.scopes });
      } catch (err) {
        log.warn(
          `onDeviceDisconnected hook threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Reject any pending commands dispatched on this socket so callers fail
    // fast instead of waiting commandTimeoutMs for a dead connection.
    for (const [id, pending] of this.pending) {
      if (pending.ws !== ws) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }

  private closeConnection(ws: WsHandle, reason: string): void {
    this.dropConnection(ws, reason);
    try {
      ws.close();
    } catch {
      // Authorization state was removed before attempting transport cleanup.
    }
  }

  // ── outgoing ────────────────────────────────────────────────────────────

  /**
   * Send an event to all authenticated connections. If `requiredScope` is
   * provided, only connections whose token carries that scope receive it.
   */
  broadcast(event: WsEvent, requiredScope?: Scope): void {
    const data = JSON.stringify(event);
    for (const [ws, state] of this.connections) {
      if (!state.authenticated) continue;
      if (requiredScope && !scopeSatisfies(state.scopes, requiredScope)) continue;
      try {
        ws.send(data);
      } catch {
        // Ignore send errors — connection will clean up on close.
      }
    }
  }

  /**
   * Send a command to a device and await its response.
   *
   * Generic over the typed registry: callers pick a known command type and
   * the payload + response are inferred from `WsRequestPayload<K>` /
   * `WsResponsePayload<K>`. Bypasses are still possible by typing the call
   * site at `WsCommandType` directly, but the default surface refuses raw
   * strings and free-form payloads.
   *
   * Drops (rejects) when the device is offline — there is no durable queue
   * here. Callers needing at-least-once delivery enqueue through a durable
   * outbox and drain it via this method. Subscription wakes use the
   * `subscription.prepare` / `subscription.commit` handshake over this channel
   * with timed backoff.
   */
  sendCommand<K extends WsCommandType>(
    deviceId: DeviceId,
    type: K,
    payload: WsRequestPayload<K>,
    timeoutMs?: number,
    requiredScope?: Scope,
  ): Promise<WsResponsePayload<K>> {
    const sockets = this.byDevice.get(deviceId);
    if (!sockets || sockets.size === 0) {
      return Promise.reject(new Error(`device ${deviceId} not connected`));
    }
    // Pick a connection carrying the required delivery credential. A device
    // can have multiple simultaneous sockets under distinct least-privilege
    // tokens, so choosing an arbitrary one would bypass the receive scope.
    const ws = [...sockets].find((socket) => {
      if (!requiredScope) return true;
      const state = this.connections.get(socket);
      return !!state && state.scopes.includes(requiredScope);
    });
    if (!ws) {
      return Promise.reject(
        new Error(`device ${deviceId} not connected with required scope ${requiredScope}`),
      );
    }
    const command = makeCommand(type, payload);
    const t = timeoutMs ?? this.commandTimeoutMs;

    return new Promise<WsResponsePayload<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`command ${type} to device ${deviceId} timed out after ${t}ms`));
      }, t);
      this.pending.set(command.id, {
        type,
        resolve: (r) => resolve(r as WsResponsePayload<K>),
        reject,
        timer,
        ws,
      });
      try {
        ws.send(JSON.stringify(command));
      } catch (err) {
        this.pending.delete(command.id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Is the given device connected, optionally under a token with an exact scope? */
  isConnected(deviceId: DeviceId, requiredScope?: Scope): boolean {
    const set = this.byDevice.get(deviceId);
    if (!set || set.size === 0) return false;
    if (!requiredScope) return true;
    return [...set].some((socket) => {
      const state = this.connections.get(socket);
      return !!state && state.scopes.includes(requiredScope);
    });
  }

  /**
   * Send a one-way event to every authenticated socket of a single device.
   * Used by the agent service to fan out streaming events to the device
   * that originated the session, without broadcasting to other devices.
   */
  sendEventToDevice(deviceId: DeviceId, event: WsEvent): boolean {
    const set = this.byDevice.get(deviceId);
    if (!set || set.size === 0) return false;
    const data = JSON.stringify(event);
    let sent = false;
    for (const ws of set) {
      try {
        ws.send(data);
        sent = true;
      } catch {
        // ignore — close handler will clean up.
      }
    }
    return sent;
  }

  get authenticatedClientCount(): number {
    let n = 0;
    for (const state of this.connections.values()) if (state.authenticated) n++;
    return n;
  }

  // ── handlers ────────────────────────────────────────────────────────────

  private async handleHello(ws: WsHandle, state: ConnectionState, cmd: WsCommand): Promise<void> {
    const parsed = parseRequestPayload("hello", cmd.payload);
    if (!parsed.ok) {
      this.sendRaw(ws, makeResponseErr(cmd.id, "invalid_payload", parsed.error));
      this.closeConnection(ws, "invalid hello payload");
      return;
    }
    const payload = parsed.value;
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      this.sendRaw(
        ws,
        makeResponseErr(
          cmd.id,
          "protocol_version_mismatch",
          `client protocol ${payload.protocolVersion} != gateway ${PROTOCOL_VERSION}`,
        ),
      );
      this.closeConnection(ws, "protocol version mismatch");
      return;
    }

    let info = state.upgradeAuth;
    if (info && !isTokenActive(this.db, info.tokenId, info.deviceId)) {
      info = null;
    }
    if (!info) {
      // Legacy fallback for older local clients/tests mounted without the
      // production upgrade-auth middleware. The real /device/ws route validates
      // tokens before upgrade and passes state.upgradeAuth into onOpen().
      const limit = this.helloLimiter.consume(state.clientIp);
      if (limit) {
        this.sendRaw(ws, makeResponseErr(cmd.id, "rate_limited", "too many hello attempts"));
        this.closeConnection(ws, "hello rate limited");
        return;
      }
      if (!payload.token) {
        this.sendRaw(ws, makeResponseErr(cmd.id, "invalid_token", "missing token"));
        this.closeConnection(ws, "missing hello token");
        return;
      }
      const tokenInfo = lookupToken(this.db, payload.token);
      if (tokenInfo) {
        info = { tokenId: tokenInfo.id, deviceId: tokenInfo.deviceId, scopes: tokenInfo.scopes };
      }
    }
    if (!info) {
      log.warn(`Failed legacy WS hello from ${state.clientIp} — invalid token`);
      this.sendRaw(ws, makeResponseErr(cmd.id, "invalid_token", "invalid token"));
      this.closeConnection(ws, "invalid hello token");
      return;
    }
    void this.w.touchTokenUsage(info.tokenId, info.deviceId).catch(() => {
      /* beacon */
    });
    const device = getDevice(this.db, info.deviceId);
    if (!device) {
      this.sendRaw(ws, makeResponseErr(cmd.id, "device_not_found", "device record missing"));
      this.closeConnection(ws, "device record missing");
      return;
    }

    const auth = info;

    // Heal a device paired before one of its hosted sources shipped: grant the
    // `write:<source-type>` scopes its kind is supposed to hold. Without this
    // the device would 403 on that source's pushes until the operator noticed
    // and re-paired — and since the phone's offline buffer drains strictly
    // FIFO, those rejections stall every other source's batches behind them.
    //
    // The missing set is derived in-process from the scopes already in hand, so
    // the steady state (nothing to grant) costs no writer dispatch. Entering the
    // write gate here would otherwise put a serialized round-trip on every
    // hello — every phone foreground, every collector reconnect.
    const missing = missingHostedWriteScopes(auth.scopes, device.kind);
    if (missing.length > 0) {
      const reconciled = await this.w
        .reconcileDeviceTokenScopes(auth.tokenId, device.kind)
        .catch((err: unknown) => {
          // A swallowed failure here reproduces the exact silent stall this
          // heal exists to prevent, so it must be visible in the log.
          log.warn(
            `Failed to reconcile scopes for ${device.name} (${device.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        });
      // This is the first suspension point in the handshake. The socket may
      // have closed or been evicted by a credential repair while it was
      // pending; `dropConnection` skips its `byDevice` cleanup because
      // `state.deviceId` is still null at that point, so registering below
      // would leave a ghost handle that `isConnected` reports as online and
      // `sendCommand` prefers forever.
      if (this.connections.get(ws) !== state) return;
      if (reconciled) {
        log.info(`Granted ${device.name} (${device.kind}) missing scopes: ${missing.join(", ")}`);
        auth.scopes = reconciled;
      }
    }

    state.authenticated = true;
    state.deviceId = auth.deviceId;
    state.deviceKind = device.kind;
    state.scopes = auth.scopes;
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    const existing = this.byDevice.get(auth.deviceId) ?? new Set<WsHandle>();
    existing.add(ws);
    this.byDevice.set(auth.deviceId, existing);

    // If the client declared capabilities, update the device record.
    // touchDevice on the no-caps branch is fire-and-forget — it's a
    // last-seen beacon, not load-bearing on the handshake response.
    //
    // The registry's capabilities schema is `passthrough` for forward
    // compatibility but inferred as `string[]` for `hostableSourceTypes`;
    // DeviceCapability's brand requires `SourceType[]`. Cast through
    // `unknown` here — it's the same in-memory string array, just brand-
    // labelled for downstream typing.
    let memberConfigChangedSourceIds: SourceId[] = [];
    if (payload.capabilities && typeof payload.capabilities === "object") {
      const caps = payload.capabilities as unknown as DeviceCapability;
      // The protocol number comes from the envelope, not the bag: it is what
      // the gateway just agreed to speak, and the version ledger reads it to
      // tell a device that is merely old from one that can no longer connect.
      memberConfigChangedSourceIds =
        (await this.w.updateDeviceCapabilities(auth.deviceId, caps, payload.protocolVersion)) ?? [];
    } else {
      void this.w.touchDevice(auth.deviceId).catch(() => {
        /* beacon */
      });
    }
    // Device repair can evict this socket while the capability write awaits.
    // Do not emit a successful hello or run connect hooks for a connection
    // that no longer exists in the authorization table.
    if (this.connections.get(ws) !== state) return;

    // A collector is declaration-ready only while at least one of its sockets
    // is live. Await publication before acknowledging hello: the client cannot
    // race a declaration POST against its own presence transition.
    if (device.kind === "collector" && this.onCollectorConnected) {
      try {
        await this.onCollectorConnected(auth.deviceId);
      } catch (err) {
        log.warn(
          `Collector connect hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.sendRaw(ws, makeResponseErr(cmd.id, "handler_error", "collector setup failed"));
        this.closeConnection(ws, "collector setup failed");
        return;
      }
      if (this.connections.get(ws) !== state) return;
    }

    this.sendRaw(
      ws,
      makeResponseOk(cmd.id, {
        deviceId: auth.deviceId,
        scopes: auth.scopes,
        deviceName: device.name,
        deviceKind: device.kind,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    log.info(`Device connected: ${device.name} (${device.kind}) id=${auth.deviceId}`);

    // Notify admin subscribers that this device came online.
    this.broadcast(
      makeEvent("device.status", { deviceId: auth.deviceId, online: true }),
      SCOPE_ADMIN,
    );

    // Fire post-handshake hook so the gateway can push initial state
    // (e.g. push a sources.snapshot to a freshly-connected collector).
    if (this.onDeviceConnected) {
      try {
        this.onDeviceConnected({
          deviceId: auth.deviceId,
          scopes: auth.scopes,
          ...(memberConfigChangedSourceIds.length ? { memberConfigChangedSourceIds } : {}),
        });
      } catch (err) {
        log.warn(
          `onDeviceConnected hook threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleCommand(ws: WsHandle, state: ConnectionState, cmd: WsCommand): Promise<void> {
    if (!state.deviceId) return; // can't happen (authenticated gate)
    const conn: DeviceConnection = { deviceId: state.deviceId, scopes: state.scopes };
    if (!this.onDeviceCommand) {
      this.sendRaw(ws, makeResponseErr(cmd.id, "unsupported", `no handler for ${cmd.type}`));
      return;
    }
    try {
      const result = await this.onDeviceCommand(conn, cmd);
      this.sendRaw(ws, makeResponseOk(cmd.id, result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendRaw(ws, makeResponseErr(cmd.id, "handler_error", message));
    }
  }

  private handleEvent(state: ConnectionState, event: WsEvent): void {
    if (!state.deviceId) return;
    const conn: DeviceConnection = { deviceId: state.deviceId, scopes: state.scopes };
    // Fire-and-forget device touch — activity beacon, same rationale as
    // the heartbeat loop in start().
    void this.w.touchDevice(state.deviceId).catch(() => {
      /* already logged */
    });
    this.onDeviceEvent?.(conn, event);
  }

  private handleResponse(ws: WsHandle, state: ConnectionState, res: WsResponse): void {
    const pending = this.pending.get(res.correlationId);
    if (!pending) return; // late or unexpected — drop
    // A correlation id is not an authority token. Only the authenticated
    // socket that received the command may settle it; another connection for
    // the same device (or an unauthenticated socket that guessed the id) must
    // not be able to spoof an acknowledgement.
    if (!state.authenticated || pending.ws !== ws) return;
    this.pending.delete(res.correlationId);
    clearTimeout(pending.timer);
    if (res.ok) {
      const parsed = parseResponsePayload(pending.type, res.result);
      if (!parsed.ok) {
        pending.reject(
          new WsCommandError(
            "invalid_response",
            `invalid ${pending.type} response payload: ${parsed.error}`,
          ),
        );
        return;
      }
      pending.resolve(parsed.value);
    } else {
      pending.reject(new WsCommandError(res.error.code, res.error.message));
    }
  }

  private sendRaw(ws: WsHandle, envelope: WsEnvelope): void {
    try {
      ws.send(JSON.stringify(envelope));
    } catch {
      // ignore
    }
  }
}
