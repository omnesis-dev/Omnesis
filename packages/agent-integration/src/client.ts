// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { z } from "zod";

import { silentIntegrationLogger, type IntegrationLogger } from "./logger.js";
import {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
  agentIntegrationCapabilitySchema,
  deviceUpdateCommandSchema,
  subscriptionCancelCommandSchema,
  subscriptionCommitCommandSchema,
  subscriptionPrepareCommandSchema,
  answerCompletionCancelCommandSchema,
  answerCompletionCommitCommandSchema,
  answerCompletionPrepareCommandSchema,
  type AgentIntegrationCapability,
} from "./protocol.js";
import { pinnedTlsOptions, type TlsTrust, validateGatewayUrl, websocketUrl } from "./tls.js";
import { INTEGRATION_VERSION } from "./version.js";
import { capDeviceUpdateDetail } from "./command-output.js";
import {
  updateTargetLabel,
  type HarnessRestart,
  type HarnessSelfUpdater,
  type HarnessUpdateTarget,
} from "./self-update.js";
import type { AnswerCompletionStarter, DeliveryStarter, DurableIntegrationInbox } from "./inbox.js";

interface SocketLike {
  readonly readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  /**
   * `sent`, when given, is called once the frame has been handed to the
   * operating system, or with the error that stopped it.
   */
  send(data: string, sent?: (error?: Error) => void): void;
  close(): void;
  /**
   * Drops the connection without waiting for a close handshake. Optional
   * because a test double need only implement `close()`; the real `ws` socket
   * provides it, and a link that has stopped carrying frames is precisely the
   * one whose close handshake would never be answered.
   */
  terminate?(): void;
}

export type WebSocketFactory = (
  url: string,
  protocol: string,
  options: ClientOptions,
) => SocketLike;

export type IntegrationConnectionState =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "ready"
  | "disconnected";

export interface AgentIntegrationClientOptions {
  gatewayUrl: string;
  deliveryToken: string;
  tls?: TlsTrust;
  capability: AgentIntegrationCapability;
  inbox: DurableIntegrationInbox;
  starter: DeliveryStarter;
  /** Runs a committed terminal Answer delivery in its already-bound native conversation. */
  completionStarter?: AnswerCompletionStarter;
  /**
   * Runs a gateway-commanded self-update. Omitted on a plugin that must not
   * update itself — the command is then refused rather than ignored, so the
   * gateway records why instead of waiting on a result that never comes.
   */
  selfUpdater?: HarnessSelfUpdater;
  /** Exact completed source update loaded by this plugin process. */
  sourceCommit?: string;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  webSocketFactory?: WebSocketFactory;
  logger?: IntegrationLogger;
  now?: () => number;
  onStateChange?: (state: IntegrationConnectionState) => void;
}

const DEVICE_WS_PROTOCOL_VERSION = 1;
const TOKEN_PROTOCOL_ALLOWED = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The gateway sends a `ping` event to every open device socket on a fixed
 * timer, 30 seconds by default. That cadence is a property of the protocol
 * rather than of this client: it is what makes silence on the socket
 * measurable at all, since an idle delivery connection carries no other
 * traffic for hours at a time.
 */
const GATEWAY_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long the delivery socket may produce nothing before this client stops
 * believing in it — three heartbeat periods, so two heartbeats can be lost to
 * a slow or lossy link before the connection is declared dead.
 *
 * It bounds two different waits. Once the socket is up it is a watchdog reset
 * by every inbound frame, because a half-open socket — TCP still established
 * at both ends, nothing flowing, which is what a network partition leaves
 * behind — emits neither `close` nor `error`, and the client would otherwise
 * wait forever on a link that is gone. During the handshake it is an absolute
 * deadline instead: a gateway that heartbeats but never answers the hello
 * would keep resetting a traffic-driven watchdog on a connection that never
 * becomes usable.
 */
const DELIVERY_LIVENESS_BUDGET_MS = GATEWAY_HEARTBEAT_INTERVAL_MS * 3;

const helloSuccessFrameSchema = z
  .object({
    kind: z.literal("response"),
    correlationId: z.string().min(1),
    ok: z.literal(true),
    result: z
      .object({
        deviceId: z.string().min(1),
        scopes: z.array(z.string()),
        deviceName: z.string().min(1),
        deviceKind: z.string().min(1),
        protocolVersion: z.literal(DEVICE_WS_PROTOCOL_VERSION),
      })
      .strict(),
  })
  .strict();

function websocketAuthProtocol(token: string): string {
  if (!TOKEN_PROTOCOL_ALLOWED.test(token)) {
    throw new Error("WebSocket auth token contains characters that are invalid in a subprotocol");
  }
  return `omnesis-token.${token}`;
}

function makeCommand<Type extends string, Payload>(type: Type, payload: Payload) {
  return {
    kind: "command" as const,
    id: randomUUID(),
    type,
    payload,
  };
}

function decodeRaw(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function responseOk(correlationId: string, result: unknown): string {
  return JSON.stringify({ kind: "response", correlationId, ok: true, result });
}

function event(type: string, payload: unknown): string {
  return JSON.stringify({ kind: "event", type, payload });
}

function updateResultEvent(
  target: HarnessUpdateTarget,
  state: "installed" | "restart-pending" | "failed",
  detail: string | undefined,
): string {
  return event("device.update.result", {
    ...("version" in target ? { version: target.version } : { commit: target.commit }),
    state,
    // A detail longer than the gateway accepts fails the event's schema, and
    // the row would read "dispatched" with no result.
    detail: detail === undefined ? undefined : capDeviceUpdateDetail(detail),
  });
}

/**
 * How long a frame that must precede a harness restart may take to reach the
 * operating system. A socket that has not written it by then is not carrying
 * frames, and the restart goes ahead regardless: the reconnect on the new
 * build is what marks the device current.
 */
const RESULT_WRITE_TIMEOUT_MS = 5_000;

/** Send `data` and resolve once it is written, failed, or timed out. */
function sendWritten(socket: SocketLike, data: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RESULT_WRITE_TIMEOUT_MS);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    try {
      socket.send(data, done);
    } catch {
      done();
    }
  });
}

function responseError(correlationId: string, code: string, message: string): string {
  return JSON.stringify({
    kind: "response",
    correlationId,
    ok: false,
    error: { code, message },
  });
}

export class AgentIntegrationClient {
  private readonly opts: AgentIntegrationClientOptions;
  private readonly wsUrl: URL;
  private readonly wsOptions: ClientOptions;
  private readonly factory: WebSocketFactory;
  private readonly log: IntegrationLogger;
  private socket: SocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private stopped = true;
  private helloId: string | null = null;
  private activeStarts = 0;
  private readonly activeTasks = new Set<Promise<unknown>>();
  private state: IntegrationConnectionState = "stopped";
  private updating = false;

  constructor(options: AgentIntegrationClientOptions) {
    this.opts = {
      ...options,
      capability: agentIntegrationCapabilitySchema.parse(options.capability),
    };
    const gateway = validateGatewayUrl(options.gatewayUrl);
    if (gateway.protocol === "https:" && !options.tls) {
      throw new Error("HTTPS integration requires pinned TLS trust material");
    }
    this.wsUrl = websocketUrl(options.gatewayUrl);
    this.wsOptions =
      gateway.protocol === "https:"
        ? (pinnedTlsOptions(gateway.hostname, options.tls!) as ClientOptions)
        : {};
    this.factory =
      options.webSocketFactory ??
      ((url, protocol, tlsOptions) => new WebSocket(url, protocol, tlsOptions));
    this.log = options.logger ?? silentIntegrationLogger;
    this.reconnectDelay = options.reconnectInitialMs ?? 1_000;
  }

  getState(): IntegrationConnectionState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // The socket is detached below, so its `close` handler will not recognise
    // it as the current one and will not clear these for us.
    this.clearLivenessTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    await Promise.allSettled([...this.activeTasks]);
    this.setState("stopped");
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    let socket: SocketLike;
    try {
      socket = this.factory(
        this.wsUrl.toString(),
        websocketAuthProtocol(this.opts.deliveryToken),
        this.wsOptions,
      );
    } catch (error) {
      this.log.warn(
        `delivery socket creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // Armed before the socket is even open, so a connect that never completes
    // is bounded by the same budget as one that goes quiet later.
    this.armSilenceWatchdog(socket);
    socket.on("open", () => this.sendHello(socket));
    socket.on("message", (data) => {
      this.armSilenceWatchdog(socket);
      this.track(this.handleMessage(socket, decodeRaw(data)), "delivery message handling failed");
    });
    socket.on("error", (error) => {
      this.log.warn(`delivery socket error: ${error.message}`);
      // Reconnecting is driven from `close` alone, so the close is issued here
      // rather than assumed. `ws` does emit `close` after every `error`, but
      // several of its error paths get there by an orderly shutdown that waits
      // on the peer — and on the broken link that produced the error, that wait
      // runs out its full close timer. Dropping the socket here makes the
      // reconnect unconditional and immediate; it is a no-op on a socket that
      // has already closed itself.
      this.dropSocket(socket);
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.clearLivenessTimers();
      }
      this.helloId = null;
      if (this.stopped) return;
      this.setState("disconnected");
      this.scheduleReconnect();
    });
  }

  private sendHello(socket: SocketLike): void {
    if (this.socket !== socket || this.stopped) return;
    this.setState("authenticating");
    const command = makeCommand("hello", {
      capabilities: {
        hostname: this.opts.capability.harness,
        platform: process.platform,
        version: INTEGRATION_VERSION,
        ...(this.opts.sourceCommit ? { sourceCommit: this.opts.sourceCommit } : {}),
        agentIntegration: this.opts.capability,
      },
      protocolVersion: DEVICE_WS_PROTOCOL_VERSION,
    });
    this.helloId = command.id;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.socket !== socket) return;
      this.log.warn(
        `delivery hello unanswered for ${DELIVERY_LIVENESS_BUDGET_MS}ms; dropping the socket`,
      );
      this.dropSocket(socket);
    }, DELIVERY_LIVENESS_BUDGET_MS);
    socket.send(JSON.stringify(command));
  }

  /**
   * (Re)start the silence watchdog for `socket`. Every inbound frame counts as
   * proof of life, including the gateway's heartbeat, so on a healthy but idle
   * connection this timer is pushed forward every heartbeat period and never
   * fires.
   */
  private armSilenceWatchdog(socket: SocketLike): void {
    if (this.socket !== socket) return;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.socket !== socket) return;
      this.log.warn(
        `delivery socket silent for ${DELIVERY_LIVENESS_BUDGET_MS}ms; dropping it to reconnect`,
      );
      this.dropSocket(socket);
    }, DELIVERY_LIVENESS_BUDGET_MS);
  }

  private clearLivenessTimers(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  /**
   * Close `socket` and let its `close` handler run the single reconnect path.
   * Prefers `terminate` so a link that is no longer carrying frames is not
   * waited on through a close handshake that will never be answered.
   */
  private dropSocket(socket: SocketLike): void {
    if (this.socket === socket) this.clearLivenessTimers();
    if (socket.terminate) socket.terminate();
    else socket.close();
  }

  /**
   * Acknowledge an update command and start the work behind it.
   *
   * The answer is a receipt: the update is minutes of install work, far past
   * any command timeout. The outcome arrives as a `device.update.result`
   * event. An install then restarts the harness at once, interrupting any
   * run in progress: the result goes out first and is written to the socket
   * before the restart is launched, because the restart ends this process.
   */
  private startSelfUpdate(
    socket: SocketLike,
    correlationId: string,
    target: HarnessUpdateTarget,
  ): string {
    if (!this.opts.selfUpdater) {
      return responseError(correlationId, "unsupported", "this plugin cannot update itself");
    }
    const label = updateTargetLabel(target);
    if ("version" in target && target.version === INTEGRATION_VERSION) {
      return responseOk(correlationId, {
        accepted: false,
        reason: `Already running ${label}.`,
      });
    }
    if (this.updating) {
      return responseOk(correlationId, {
        accepted: false,
        reason: "An update is already running on this machine.",
      });
    }
    this.updating = true;
    const updater = this.opts.selfUpdater;
    this.track(
      (async () => {
        let attempt;
        try {
          attempt = await updater.run(target);
        } catch (error) {
          attempt = {
            state: "failed" as const,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        this.updating = false;
        // Sent on the socket the command arrived on: a result that outlived
        // its connection belongs to a plugin the gateway will ask again.
        if (this.socket === socket) {
          await sendWritten(socket, updateResultEvent(target, attempt.state, attempt.detail));
        }
        // A plugin being stopped belongs to a harness already on its way
        // down; the plugin on disk loads when it starts again.
        if (attempt.restart && !this.stopped) {
          this.restartHarness(socket, label, target, attempt.restart);
        }
      })(),
      "self-update failed",
    );
    return responseOk(correlationId, { accepted: true });
  }

  /**
   * Launch the harness restart that loads an installed plugin. Deliberately
   * untracked: the restart stops this plugin, and `stop()` waiting on
   * anything the restart itself waits on would deadlock it. A restart that
   * could not be started turns the result into `restart-pending`, naming the
   * command the operator runs instead.
   */
  private restartHarness(
    socket: SocketLike,
    label: string,
    target: HarnessUpdateTarget,
    restart: HarnessRestart,
  ): void {
    (this.log.info ?? this.log.warn).call(
      this.log,
      `Plugin ${label} installed; restarting the harness: ${restart.command}`,
    );
    restart.start((detail) => {
      this.log.warn(`harness restart failed: ${detail}`);
      if (this.stopped || this.socket !== socket) return;
      socket.send(updateResultEvent(target, "restart-pending", detail));
    });
  }

  private async handleMessage(socket: SocketLike, raw: string): Promise<void> {
    if (this.socket !== socket || this.stopped) return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const obj = frame as Record<string, unknown>;
    if (typeof obj.correlationId === "string" && obj.correlationId === this.helloId) {
      const hello = helloSuccessFrameSchema.safeParse(frame);
      if (hello.success) {
        if (this.helloTimer) {
          clearTimeout(this.helloTimer);
          this.helloTimer = null;
        }
        this.reconnectDelay = this.opts.reconnectInitialMs ?? 1_000;
        this.setState("ready");
      } else {
        this.log.warn("delivery hello was rejected or malformed");
        socket.close();
      }
      return;
    }
    if (obj.kind !== "command" || typeof obj.id !== "string") return;
    if (this.state !== "ready") {
      socket.send(responseError(obj.id, "not_authenticated", "integration hello is incomplete"));
      return;
    }
    if (obj.type === "answer-completion.prepare") {
      const parsed = answerCompletionPrepareCommandSchema.safeParse(frame);
      if (!parsed.success) {
        socket.send(
          responseError(obj.id, "invalid_payload", "invalid answer completion preparation"),
        );
        return;
      }
      try {
        const prepared = this.opts.inbox.prepareAnswerCompletion(
          parsed.data.payload,
          (this.opts.now ?? Date.now)(),
        );
        socket.send(responseOk(obj.id, prepared));
      } catch (error) {
        const code =
          error instanceof Error && error.name === "DeliveryConflictError"
            ? "delivery_conflict"
            : error instanceof Error && error.name === "DeliveryCancelledError"
              ? "cancelled"
              : "prepare_failed";
        socket.send(
          responseError(
            obj.id,
            code,
            code === "delivery_conflict"
              ? "answer completion delivery identifier was rebound"
              : code === "cancelled"
                ? "answer completion delivery was cancelled"
                : "integration could not persist the answer completion delivery",
          ),
        );
      }
      return;
    }
    if (obj.type === "answer-completion.cancel") {
      const parsed = answerCompletionCancelCommandSchema.safeParse(frame);
      if (!parsed.success) {
        socket.send(
          responseError(obj.id, "invalid_payload", "invalid answer completion cancellation"),
        );
        return;
      }
      const cancelled = this.opts.inbox.cancelAnswerCompletion(
        parsed.data.payload.deliveryId,
        (this.opts.now ?? Date.now)(),
      );
      socket.send(responseOk(obj.id, cancelled));
      return;
    }
    if (obj.type === "answer-completion.commit") {
      const parsed = answerCompletionCommitCommandSchema.safeParse(frame);
      if (!parsed.success) {
        socket.send(responseError(obj.id, "invalid_payload", "invalid answer completion commit"));
        return;
      }
      if (!this.opts.completionStarter) {
        socket.send(responseError(obj.id, "unsupported", "answer completion is not configured"));
        return;
      }
      try {
        const accepted = await this.opts.inbox.commitAnswerCompletion(
          parsed.data.payload.deliveryId,
          this.opts.completionStarter,
          (this.opts.now ?? Date.now)(),
        );
        socket.send(responseOk(obj.id, accepted));
      } catch (error) {
        const parkedAmbiguous =
          this.opts.inbox.getAnswerCompletionState(parsed.data.payload.deliveryId) === "starting";
        const code =
          parkedAmbiguous || (error instanceof Error && error.name === "AmbiguousDeliveryError")
            ? "ambiguous_start"
            : error instanceof Error && error.name === "DeliveryNotPreparedError"
              ? "not_prepared"
              : error instanceof Error && error.name === "DeliveryCancelledError"
                ? "cancelled"
                : "retryable_start_failure";
        socket.send(
          responseError(
            obj.id,
            code,
            code === "ambiguous_start"
              ? "answer completion delivery is ambiguous and requires manual review"
              : code === "not_prepared"
                ? "answer completion was not prepared"
                : code === "cancelled"
                  ? "answer completion was cancelled"
                  : "integration did not accept the answer completion delivery",
          ),
        );
      }
      return;
    }
    if (obj.type === "device.update") {
      const parsed = deviceUpdateCommandSchema.safeParse(frame);
      if (!parsed.success) {
        socket.send(responseError(obj.id, "invalid_payload", "invalid update command"));
        return;
      }
      socket.send(this.startSelfUpdate(socket, obj.id, parsed.data.payload));
      return;
    }
    if (obj.type === "subscription.prepare") {
      const parsed = subscriptionPrepareCommandSchema.safeParse(frame);
      if (!parsed.success) {
        socket.send(responseError(obj.id, "invalid_payload", "invalid subscription preparation"));
        return;
      }
      if (parsed.data.payload.answer.expiresAt <= (this.opts.now ?? Date.now)()) {
        socket.send(responseError(obj.id, "expired", "firing answer authority expired"));
        return;
      }
      try {
        const prepared = this.opts.inbox.prepare(
          parsed.data.payload,
          (this.opts.now ?? Date.now)(),
        );
        socket.send(responseOk(obj.id, prepared));
      } catch (error) {
        const code =
          error instanceof Error && error.name === "DeliveryConflictError"
            ? "delivery_conflict"
            : error instanceof Error && error.name === "DeliveryCancelledError"
              ? "cancelled"
              : "prepare_failed";
        socket.send(
          responseError(
            obj.id,
            code,
            code === "delivery_conflict"
              ? "delivery identifier was rebound"
              : code === "cancelled"
                ? "delivery was cancelled"
                : "integration could not persist the delivery",
          ),
        );
      }
      return;
    }

    if (obj.type === "subscription.cancel") {
      const parsed = subscriptionCancelCommandSchema.safeParse(frame);
      if (!parsed.success) {
        socket.send(responseError(obj.id, "invalid_payload", "invalid subscription cancellation"));
        return;
      }
      const cancelled = this.opts.inbox.cancel(
        parsed.data.payload.deliveryId,
        (this.opts.now ?? Date.now)(),
      );
      socket.send(responseOk(obj.id, cancelled));
      return;
    }

    if (obj.type !== "subscription.commit") {
      socket.send(responseError(obj.id, "unsupported", "unsupported integration command"));
      return;
    }
    const parsed = subscriptionCommitCommandSchema.safeParse(frame);
    if (!parsed.success) {
      socket.send(responseError(obj.id, "invalid_payload", "invalid subscription commit"));
      return;
    }
    if (this.activeStarts >= this.opts.capability.maxConcurrentRuns) {
      socket.send(responseError(obj.id, "busy", "integration concurrency limit reached"));
      return;
    }
    this.activeStarts += 1;
    try {
      const accepted = await this.opts.inbox.commit(
        parsed.data.payload.deliveryId,
        this.opts.starter,
        (this.opts.now ?? Date.now)(),
      );
      socket.send(responseOk(obj.id, accepted));
    } catch (error) {
      const parkedAmbiguous =
        this.opts.inbox.getState(parsed.data.payload.deliveryId) === "starting";
      const code =
        parkedAmbiguous || (error instanceof Error && error.name === "AmbiguousDeliveryError")
          ? "ambiguous_start"
          : error instanceof Error && error.name === "DeliveryConflictError"
            ? "delivery_conflict"
            : error instanceof Error && error.name === "DeliveryNotPreparedError"
              ? "not_prepared"
              : error instanceof Error && error.name === "DeliveryCancelledError"
                ? "cancelled"
                : error instanceof Error && error.name === "DeliveryAuthorityExpiredError"
                  ? "expired"
                  : "retryable_start_failure";
      socket.send(
        responseError(
          obj.id,
          code,
          code === "ambiguous_start"
            ? "native start outcome is ambiguous and requires manual review"
            : code === "delivery_conflict"
              ? "delivery identifier was rebound"
              : code === "not_prepared"
                ? "delivery was not prepared"
                : code === "cancelled"
                  ? "delivery was cancelled"
                  : code === "expired"
                    ? "firing answer authority expired"
                    : "harness did not accept the delivery",
        ),
      );
    } finally {
      this.activeStarts -= 1;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.opts.reconnectMaxMs ?? 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private track(task: Promise<unknown>, failure: string): void {
    const tracked = task
      .catch((error) => {
        this.log.warn(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.activeTasks.delete(tracked);
      });
    this.activeTasks.add(tracked);
  }

  private setState(state: IntegrationConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }
}

/**
 * The wake versions this plugin understands, as a range rather than a pin.
 *
 * The gateway builds each wake at the highest version both ends know, so a
 * plugin that keeps accepting the older shape goes on working against a
 * gateway that has not been upgraded yet, and starts receiving the newer
 * fields the moment one has.
 */
export function defaultIntegrationCapability(
  harness: "openclaw" | "hermes",
  maxConcurrentRuns: number = 2,
): AgentIntegrationCapability {
  return {
    harness,
    deliveryProtocolMin: AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
    deliveryProtocolMax: AGENT_INTEGRATION_PROTOCOL_VERSION,
    maxConcurrentRuns,
    watchPrivacyPolicyVersion: 1,
  };
}

/** Exported for deterministic protocol-fixture tests. */
export function newDeliveryCommandId(): string {
  return `integration_${randomUUID()}`;
}
