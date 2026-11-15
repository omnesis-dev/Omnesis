// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The portal's live line from the gateway: `GET /portal/api/signals`, a
// server-sent event stream that names what changed and nothing more. Its first
// frame is `ready`, after which a listener re-reads everything it shows; then
// `changed` with `{ topic }` whenever the waiting items of that topic are
// created or decided, and a listener re-reads that topic through its ordinary
// list route.
//
// One browser holds one stream for all its tabs. The gateway speaks HTTP/1.1,
// where a browser opens about six connections per origin, so a stream per tab
// would starve every other request after a few tabs. The tabs elect a leader
// with a Web Lock: the leader holds the lock for as long as it lives, opens the
// stream, and relays each frame to the other tabs over a BroadcastChannel.
// When the leader closes, the browser releases its lock and the next waiting
// tab takes over and opens its own stream, whose `ready` resyncs every tab.
// A browser without navigator.locks or BroadcastChannel opens one stream per tab.

import { useEffect, useRef } from "preact/hooks";

export const SIGNALS_URL = "/portal/api/signals";
export const SIGNALS_LOCK = "omnesis:portal-signals";
export const SIGNALS_CHANNEL = "omnesis:portal-signals";
/** The first retry's ceiling; each failure doubles it up to `RECONNECT_MAX_MS`. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/**
 * How long a stream must stay open after `ready` before its end counts as a fresh drop rather than
 * another failure in a row: a stream cut right after each `ready` (a proxy that does not hold
 * streams open) keeps backing off instead of reconnecting, and re-reading everything, every second.
 * Longer than the gateway's 25-second heartbeat, so a healthy stream has proved itself.
 */
export const STABLE_STREAM_MS = 30_000;
/**
 * How often a view re-reads a list the signals keep current, in case the stream is down: slow,
 * because a live stream makes it redundant.
 */
export const SIGNAL_FALLBACK_MS = 60_000;

/**
 * How long to wait before reconnect attempt `attempt` (0-based): a ceiling that doubles from
 * `RECONNECT_BASE_MS` up to `RECONNECT_MAX_MS`, then a random point in its upper half, so tabs and
 * browsers that lost the gateway together do not all come back in the same instant.
 */
export function reconnectDelay(attempt, random = Math.random) {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** A relayed or parsed signal in its one shape, or null for anything else. */
function asSignal(value) {
  if (value?.type === "ready") return { type: "ready" };
  if (value?.type === "changed" && typeof value.topic === "string" && value.topic) {
    return { type: "changed", topic: value.topic };
  }
  return null;
}

/**
 * One connection to the gateway's signals, shared by the tabs of this browser where it can be.
 * Every dependency is injectable so the leader, follower and fallback paths can be exercised
 * without a browser.
 *
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {typeof EventSource} [options.EventSource] absent: nothing connects and listeners hear nothing.
 * @param {{ request: Function }} [options.locks] `navigator.locks`.
 * @param {typeof BroadcastChannel} [options.BroadcastChannel]
 * @param {() => number} [options.random]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeout]
 * @param {(handle: unknown) => void} [options.clearTimeout]
 * @param {() => number} [options.now]
 */
export function createPortalSignals({
  url = SIGNALS_URL,
  EventSource: EventSourceImpl = globalThis.EventSource,
  locks = globalThis.navigator?.locks,
  BroadcastChannel: ChannelImpl = globalThis.BroadcastChannel,
  random = Math.random,
  setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = (handle) => globalThis.clearTimeout(handle),
  now = () => Date.now(),
} = {}) {
  const listeners = new Set();
  /** "idle" until the first subscriber; then "leader", "follower" or "solo" (no sharing). */
  let role = "idle";
  let closed = false;
  let source = null;
  let retry = null;
  let attempt = 0;
  let channel = null;
  let abort = null;
  let releaseLock = null;

  function deliver(signal) {
    for (const { listener, topic } of [...listeners]) {
      if (signal.type === "changed" && topic !== null && signal.topic !== topic) continue;
      try {
        listener(signal);
      } catch {
        // One listener's failure is its own; the others still hear the signal.
      }
    }
  }

  /** What the stream said, to this tab's listeners and to every other tab. */
  function publish(signal) {
    deliver(signal);
    try {
      channel?.postMessage(signal);
    } catch {
      // A closed channel: this tab is shutting down.
    }
  }

  function connect() {
    retry = null;
    if (closed) return;
    let stream;
    try {
      stream = new EventSourceImpl(url, { withCredentials: true });
    } catch {
      reconnect();
      return;
    }
    source = stream;
    let readyAt = null;
    stream.addEventListener("ready", () => {
      if (source !== stream) return;
      readyAt = now();
      publish({ type: "ready" });
    });
    stream.addEventListener("changed", (event) => {
      if (source !== stream) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const signal = asSignal({ type: "changed", topic: data?.topic });
      if (signal) publish(signal);
    });
    // A refused stream (503 when the gateway is full, 401 once the session is gone) and a dropped
    // one end the same way: closed here, so the browser's own fixed-pace retry never runs, and
    // retried on the backoff below.
    stream.addEventListener("error", () => {
      if (source !== stream) return;
      stream.close();
      source = null;
      if (readyAt !== null && now() - readyAt >= STABLE_STREAM_MS) attempt = 0;
      reconnect();
    });
  }

  function reconnect() {
    if (closed || retry !== null) return;
    retry = schedule(connect, reconnectDelay(attempt, random));
    attempt += 1;
  }

  function start() {
    if (role !== "idle" || closed || typeof EventSourceImpl !== "function") return;
    if (typeof locks?.request !== "function" || typeof ChannelImpl !== "function") {
      role = "solo";
      connect();
      return;
    }
    role = "follower";
    channel = new ChannelImpl(SIGNALS_CHANNEL);
    channel.onmessage = (event) => {
      const signal = asSignal(event?.data);
      if (signal && role === "follower") deliver(signal);
    };
    abort = typeof AbortController === "function" ? new AbortController() : null;
    const lead = () => {
      if (closed) return undefined;
      role = "leader";
      connect();
      // Held until this tab closes or `close()` lets go.
      return new Promise((resolve) => {
        releaseLock = resolve;
      });
    };
    let request;
    try {
      request = locks.request(SIGNALS_LOCK, abort ? { signal: abort.signal } : {}, lead);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).catch(() => {
      // `close()` aborting the wait is the expected way here. Any other refusal (a sandboxed frame
      // without lock access) leaves this tab to hold its own stream rather than none.
      if (closed || role !== "follower") return;
      role = "solo";
      try {
        channel.close();
      } catch {
        // Already closed.
      }
      channel = null;
      connect();
    });
  }

  return {
    /**
     * `listener(signal)` hears `{ type: "ready" }` — re-read everything — and
     * `{ type: "changed", topic }`; with `topic`, only that topic's changes and every `ready`.
     * The first subscriber opens the connection. Returns the unsubscribe.
     *
     * @param {(signal: { type: "ready" } | { type: "changed", topic: string }) => void} listener
     * @param {string | null} [topic]
     */
    subscribe(listener, topic = null) {
      const entry = { listener, topic };
      listeners.add(entry);
      start();
      return () => listeners.delete(entry);
    },
    /** Which part this tab plays: "idle", "leader", "follower" or "solo". */
    get role() {
      return closed ? "closed" : role;
    },
    /** Lets go of the stream, the lock and the channel; a later tab takes over. */
    close() {
      if (closed) return;
      closed = true;
      if (retry !== null) cancel(retry);
      retry = null;
      source?.close();
      source = null;
      abort?.abort();
      releaseLock?.();
      try {
        channel?.close();
      } catch {
        // Already closed.
      }
      listeners.clear();
    },
  };
}

let shared = null;

/** This tab's connection, created on first use with the browser's own APIs. */
export function portalSignals() {
  shared ??= createPortalSignals();
  return shared;
}

/**
 * Calls `onSignal(signal)` when `topic` changes and on every `ready`, while `enabled`. The latest
 * `onSignal` is used, so callers need not memoise it.
 */
export function usePortalSignal(topic, onSignal, { enabled = true, signals = null } = {}) {
  const callback = useRef(onSignal);
  callback.current = onSignal;
  useEffect(() => {
    if (!enabled) return undefined;
    return (signals ?? portalSignals()).subscribe((signal) => callback.current(signal), topic);
  }, [topic, enabled, signals]);
}
