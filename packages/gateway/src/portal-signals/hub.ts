// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tells open portals, at once, that something waiting for the owner changed.
 *
 * A signal names a topic and carries nothing else: the portal re-reads that
 * topic's list through its ordinary authenticated route, so the stream never
 * becomes a second way to read data and nothing it carries can go stale. A
 * producer publishes after its change is final (on the main thread, once the
 * writer has committed it). Several publishes of one topic within a tick reach
 * each listener once.
 *
 * Expiry is not signalled: every list carries its items' expiry, and the
 * portal re-reads when the earliest one passes.
 */

import { createLogger } from "@omnesis/core";

const log = createLogger("gateway:portal-signals");

/**
 * What can be waiting for the owner, by where the portal shows it.
 *
 * - `devices`: a device asking to join (a sign-in through the cloud relay, or a
 *   collector on the owner's Tailscale network).
 * - `access`: an agent asking for access over MCP.
 * - `answers`: an answer held for the owner's approval.
 * - `watches`: a watch an agent asked to set up.
 */
export const PORTAL_SIGNAL_TOPICS = ["devices", "access", "answers", "watches"] as const;
export type PortalSignalTopic = (typeof PORTAL_SIGNAL_TOPICS)[number];

export type PortalSignalListener = (topic: PortalSignalTopic) => void;

/** Thrown by `subscribe` when every slot is taken; the route answers 503. */
export class PortalSignalsFull extends Error {
  constructor(limit: number) {
    super(`Too many open portal signal streams (${limit}).`);
  }
}

/** Enough for every tab of every browser one owner plausibly keeps open. */
const DEFAULT_MAX_LISTENERS = 64;

export class PortalSignals {
  private readonly listeners = new Set<PortalSignalListener>();
  private readonly pending = new Set<PortalSignalTopic>();
  private flushing = false;
  private readonly maxListeners: number;

  constructor({ maxListeners = DEFAULT_MAX_LISTENERS }: { maxListeners?: number } = {}) {
    this.maxListeners = maxListeners;
  }

  /** Something under `topic` changed; open portals hear it on the next tick. */
  publish(topic: PortalSignalTopic): void {
    this.pending.add(topic);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => this.flush());
  }

  /** Hear every topic's changes until the returned function is called. */
  subscribe(listener: PortalSignalListener): () => void {
    if (this.listeners.size >= this.maxListeners) throw new PortalSignalsFull(this.maxListeners);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether another stream can subscribe now. */
  hasRoom(): boolean {
    return this.listeners.size < this.maxListeners;
  }

  private flush(): void {
    this.flushing = false;
    const topics = [...this.pending];
    this.pending.clear();
    for (const listener of [...this.listeners]) {
      for (const topic of topics) {
        try {
          listener(topic);
        } catch (error) {
          log.warn(
            `Portal signal listener failed for ${topic}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}
