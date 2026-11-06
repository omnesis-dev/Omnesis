// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { DeviceId } from "@omnesis/types";
import type { DeviceWsServer } from "../../ws.js";

const log = createLogger("gateway:http").child("collector-descriptors");

/** How long a request may wait for a connection's first answer. */
const FIRST_ANSWER_WAIT_MS = 3_000;
const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** A descriptor as a collector serialized it: opaque beyond its `id`. */
export type CollectorDescriptor = Readonly<Record<string, unknown>>;

/** The part of the device socket server the cache uses. */
export type CollectorDescriptorTransport = Pick<DeviceWsServer, "sendCommand" | "connectionEpoch">;

export interface CollectorDescriptorCacheDeps {
  wsServer: () => CollectorDescriptorTransport | undefined;
  /** Overridable only to keep tests fast. */
  firstAnswerWaitMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
}

interface Entry {
  /** The connection epoch the descriptors were, or are being, asked under. */
  epoch: number;
  descriptors: readonly CollectorDescriptor[] | null;
  /** The request in flight, settled once its answer is recorded. */
  inflight: Promise<void> | null;
  /** After this, a request no longer waits for this connection's first answer. */
  waitUntil: number;
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Each connected collector's source descriptors, as it last reported them.
 *
 * A collector's descriptors are the provider packages its build installed, so
 * they stay the same for as long as its process runs, and a collector that is
 * updated or restarted reconnects. The cache therefore holds one answer per
 * connection: it asks a collector once when it connects, and an answer is
 * served only while the device's connection epoch is the one it was asked
 * under, so a reconnect always asks again and a stale answer is never served.
 *
 * A request finds the answer in memory. Only in the first few seconds of a
 * connection, before its first answer has arrived, does it wait, and never
 * longer than {@link FIRST_ANSWER_WAIT_MS} from when the collector was first
 * asked. A collector that does not answer is asked again in the background with
 * backoff, so a slow or hung collector never holds a request after that.
 */
export class CollectorDescriptorCache {
  private readonly entries = new Map<DeviceId, Entry>();
  private readonly wsServer: () => CollectorDescriptorTransport | undefined;
  private readonly firstAnswerWaitMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private closed = false;

  constructor(deps: CollectorDescriptorCacheDeps) {
    this.wsServer = deps.wsServer;
    this.firstAnswerWaitMs = deps.firstAnswerWaitMs ?? FIRST_ANSWER_WAIT_MS;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
    this.maxRetryDelayMs = deps.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Ask a collector that has just connected, so the first request finds its answer. */
  prefetch(deviceId: DeviceId): void {
    this.current(deviceId);
  }

  /**
   * One of a device's sockets closed. Forget a collector that has no socket
   * left; a collector still connected through another socket is asked again,
   * since its epoch has moved on.
   */
  onDisconnected(deviceId: DeviceId): void {
    const entry = this.entries.get(deviceId);
    if (!entry) return;
    this.current(deviceId);
  }

  /**
   * The descriptors a connected collector reported over its current
   * connection, or null when it is not connected or has not answered yet.
   */
  async descriptorsFor(deviceId: DeviceId): Promise<readonly CollectorDescriptor[] | null> {
    const entry = this.current(deviceId);
    if (!entry) return null;
    if (entry.descriptors) return entry.descriptors;
    const wait = entry.waitUntil - this.now();
    if (entry.inflight && wait > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        entry.inflight,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.current(deviceId) === entry ? entry.descriptors : null;
  }

  /** Stop asking: clears every retry timer. */
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.clearRetry(entry);
    this.entries.clear();
  }

  /**
   * The entry for the device's current connection, starting one (and its
   * request) when the connection is new, or null when the device has none.
   */
  private current(deviceId: DeviceId): Entry | null {
    const ws = this.wsServer();
    const epoch = ws?.connectionEpoch(deviceId) ?? 0;
    const existing = this.entries.get(deviceId);
    if (existing && existing.epoch === epoch) return existing;
    if (existing) {
      this.clearRetry(existing);
      this.entries.delete(deviceId);
    }
    if (!ws || epoch === 0 || this.closed) return null;
    const entry: Entry = {
      epoch,
      descriptors: null,
      inflight: null,
      waitUntil: this.now() + this.firstAnswerWaitMs,
      failures: 0,
      retryTimer: null,
    };
    this.entries.set(deviceId, entry);
    this.ask(deviceId, entry, ws);
    return entry;
  }

  private ask(deviceId: DeviceId, entry: Entry, ws: CollectorDescriptorTransport): void {
    // No per-call timeout: nobody waits on this beyond the first-answer
    // window, so a busy collector gets the socket server's whole command
    // budget to answer rather than being abandoned and asked again.
    entry.inflight = ws.sendCommand(deviceId, "source.descriptors", {}).then(
      (result) => {
        entry.inflight = null;
        if (this.entries.get(deviceId) !== entry) return;
        entry.descriptors = result.descriptors.filter(
          (d): d is CollectorDescriptor => typeof d === "object" && d !== null,
        );
        entry.failures = 0;
      },
      (err: unknown) => {
        entry.inflight = null;
        if (this.entries.get(deviceId) !== entry) return;
        if (this.wsServer()?.connectionEpoch(deviceId) !== entry.epoch) {
          // Failed because the connection it was asked over went away.
          this.current(deviceId);
          return;
        }
        entry.failures += 1;
        const delay = Math.min(this.retryDelayMs * 2 ** (entry.failures - 1), this.maxRetryDelayMs);
        log.warn(
          `Collector ${deviceId} did not report its source descriptors (${err instanceof Error ? err.message : String(err)}); asking again in ${Math.round(delay / 1000)}s`,
        );
        this.scheduleRetry(deviceId, entry, delay);
      },
    );
  }

  private scheduleRetry(deviceId: DeviceId, entry: Entry, delay: number): void {
    if (this.closed) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (this.entries.get(deviceId) !== entry) return;
      const ws = this.wsServer();
      if (!ws || ws.connectionEpoch(deviceId) !== entry.epoch) {
        // The connection it was asked under is gone; the next connection
        // starts its own entry.
        this.current(deviceId);
        return;
      }
      this.ask(deviceId, entry, ws);
    }, delay);
    entry.retryTimer.unref?.();
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
}
