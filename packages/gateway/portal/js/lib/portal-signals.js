// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The portal's live line from the gateway: `GET /portal/api/signals`, a
// server-sent event stream that names what changed and nothing more. Its first
// frame is `ready`, after which a listener re-reads everything it shows; then
// `changed` with `{ topic }` whenever the waiting items of that topic are
// created or decided, and a listener re-reads that topic through its ordinary
// list route; and `beat` every 25 seconds, which proves the stream alive.
//
// One browser holds one stream for all its tabs. The gateway speaks HTTP/1.1,
// where a browser opens about six connections per origin, so a stream per tab
// would starve every other request after a few tabs. The tabs elect a leader
// with a Web Lock: the leader holds the lock for as long as it lives, opens the
// stream, and relays each frame, whether its stream is open, and each beat to
// the other tabs over a BroadcastChannel. When the leader closes, the browser
// releases its lock and the next waiting tab takes over. A visible follower
// that hears nothing from a leader for two beats takes the lock from it (a
// frozen tab may keep it with its stream gone), and the old leader steps down.
// Every new stream's `ready` resyncs every tab. A browser without
// navigator.locks or BroadcastChannel opens one stream per tab.
//
// The connection says whether it is healthy — a stream open and beating, here
// or at the leader — so views read on a fallback interval only while it is not.

import { useEffect, useRef, useState } from "preact/hooks";
import { useVisiblePoll } from "./use-visible-poll.js";

export const SIGNALS_URL = "/portal/api/signals";
export const SIGNALS_LOCK = "omnesis:portal-signals";
export const SIGNALS_CHANNEL = "omnesis:portal-signals";
const SESSION_URL = "/portal/api/session";
const SESSION_EXPIRED_EVENT = "omnesis:session-expired";
/** The first retry's ceiling; each failure doubles it up to `RECONNECT_MAX_MS`. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/**
 * How long a stream must stay open after `ready` before its end counts as a fresh drop rather than
 * another failure in a row: a stream cut right after each `ready` (a proxy that does not hold
 * streams open) keeps backing off instead of reconnecting, and re-reading everything, every second.
 * Longer than the gateway's beat, so a healthy stream has proved itself.
 */
export const STABLE_STREAM_MS = 30_000;
/** How often the gateway sends `beat`. */
export const BEAT_MS = 25_000;
/** Silence after which a stream, or a leader, counts as gone: two beats and some slack. */
export const STALE_MS = 2 * BEAT_MS + 5_000;
/** How often staleness is checked. */
const WATCH_MS = 5_000;
/**
 * How often a view re-reads a list the signals keep current while the connection is not healthy.
 * A healthy connection makes it redundant, and it is skipped then.
 */
export const SIGNAL_FALLBACK_MS = 15_000;

/**
 * How long to wait before reconnect attempt `attempt` (0-based): a ceiling that doubles from
 * `RECONNECT_BASE_MS` up to `RECONNECT_MAX_MS`, then a random point in its upper half, so tabs and
 * browsers that lost the gateway together do not all come back in the same instant.
 */
export function reconnectDelay(attempt, random = Math.random) {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** A signal for listeners, in its one shape, or null for anything else. */
function asSignal(value) {
  if (value?.type === "ready") return { type: "ready" };
  if (value?.type === "changed" && typeof value.topic === "string" && value.topic) {
    return { type: "changed", topic: value.topic };
  }
  return null;
}

/**
 * Whether the portal session is gone, asked after a stream fails: EventSource does not say why a
 * stream was refused, and a 401 must not be retried for ever.
 */
async function sessionGone() {
  const response = await fetch(SESSION_URL, { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return true;
  if (!response.ok) return false;
  return (await response.json())?.authenticated !== true;
}

/** Hands a gone session to the portal's own expiry handling, which shows the sign-in. */
function announceSessionGone() {
  globalThis.window?.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

/**
 * One connection to the gateway's signals, shared by the tabs of this browser where it can be.
 * Every dependency is injectable so the leader, follower and fallback paths can be exercised
 * without a browser; `null` stands for an API the browser lacks.
 *
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {typeof EventSource | null} [options.EventSource] absent: nothing connects.
 * @param {{ request: Function } | null} [options.locks] `navigator.locks`.
 * @param {typeof BroadcastChannel | null} [options.BroadcastChannel]
 * @param {() => number} [options.random]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeout]
 * @param {(handle: unknown) => void} [options.clearTimeout]
 * @param {() => number} [options.now]
 * @param {() => boolean} [options.visible] whether this tab is on screen; only a visible follower takes over.
 * @param {() => Promise<boolean>} [options.sessionGone]
 * @param {() => void} [options.onSessionGone]
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
  visible = () => globalThis.document?.hidden !== true,
  sessionGone: isSessionGone = sessionGone,
  onSessionGone = announceSessionGone,
} = {}) {
  const listeners = new Set();
  const healthListeners = new Set();
  /** "idle" until the first subscriber; then "leader", "follower" or "solo" (no sharing). */
  let role = "idle";
  let closed = false;
  /** Set once the session is gone: nothing reconnects until the page signs in again. */
  let stopped = false;
  let source = null;
  let streamOpen = false;
  let lastBeat = 0;
  let retry = null;
  let attempt = 0;
  let channel = null;
  let lockAbort = null;
  let releaseLock = null;
  let stealing = false;
  let leaderOpen = false;
  let lastHeard = 0;
  let watchTimer = null;
  let wasHealthy = false;

  function healthy() {
    if (closed || stopped) return false;
    if (role === "leader" || role === "solo") return streamOpen;
    if (role === "follower") return leaderOpen && now() - lastHeard < STALE_MS;
    return false;
  }

  function emitHealth() {
    const next = healthy();
    if (next === wasHealthy) return;
    wasHealthy = next;
    for (const listener of [...healthListeners]) {
      try {
        listener(next);
      } catch {
        // One listener's failure is its own.
      }
    }
  }

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

  function post(message) {
    try {
      channel?.postMessage(message);
    } catch {
      // A closed channel: this tab is shutting down.
    }
  }

  /** What the stream said, to this tab's listeners and to every other tab. */
  function publish(signal) {
    deliver(signal);
    post(signal);
  }

  function setStreamOpen(open) {
    streamOpen = open;
    post({ type: "state", open, stopped });
    emitHealth();
  }

  function dropStream() {
    source?.close();
    source = null;
    if (streamOpen) setStreamOpen(false);
  }

  function connect() {
    retry = null;
    if (closed || stopped || (role !== "leader" && role !== "solo")) return;
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
      lastBeat = readyAt;
      setStreamOpen(true);
      publish({ type: "ready" });
    });
    stream.addEventListener("beat", () => {
      if (source !== stream) return;
      lastBeat = now();
      post({ type: "beat" });
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
    // one end the same way: closed here, so the browser's own fixed-pace retry never runs. Then
    // the session is checked — a gone session stops for good and the portal asks to sign in — and
    // otherwise the stream is retried on the backoff below.
    stream.addEventListener("error", () => {
      if (source !== stream) return;
      if (readyAt !== null && now() - readyAt >= STABLE_STREAM_MS) attempt = 0;
      dropStream();
      void checkSessionThenReconnect();
    });
  }

  async function checkSessionThenReconnect() {
    let gone = false;
    try {
      gone = await isSessionGone();
    } catch {
      // The gateway cannot be reached either: retried like any drop.
    }
    if (closed || source !== null) return;
    if (gone) {
      stop();
      return;
    }
    reconnect();
  }

  /** The session is gone: no more streams, here or at any follower, and the sign-in takes over. */
  function stop() {
    if (stopped) return;
    stopped = true;
    if (retry !== null) cancel(retry);
    retry = null;
    dropStream();
    post({ type: "state", open: false, stopped: true });
    emitHealth();
    onSessionGone();
  }

  function reconnect() {
    if (closed || stopped || retry !== null) return;
    retry = schedule(connect, reconnectDelay(attempt, random));
    attempt += 1;
  }

  /**
   * Every few seconds: a leader's stream that stopped beating is started over (a socket that died
   * without an error), a leader says it is alive — also while its stream is down and backing off,
   * so no follower takes over from a leader that is doing its job — and a visible follower that
   * heard nothing for two beats takes over.
   */
  function watch() {
    watchTimer = null;
    if (closed) return;
    if ((role === "leader" || role === "solo") && source !== null && streamOpen && now() - lastBeat >= STALE_MS) {
      dropStream();
      reconnect();
    }
    if (role === "leader") post({ type: "state", open: streamOpen, stopped });
    if (role === "follower" && !stopped && now() - lastHeard >= STALE_MS && visible()) takeOver();
    emitHealth();
    watchTimer = schedule(watch, WATCH_MS);
  }

  function lead() {
    if (closed) return undefined;
    role = "leader";
    stealing = false;
    attempt = 0;
    emitHealth();
    connect();
    // Held until this tab closes, `close()` lets go, or another tab takes the lock.
    return new Promise((resolve) => {
      releaseLock = resolve;
    });
  }

  /** Queues for the lock; a refusal other than our own abort leaves this tab on its own stream. */
  function requestLock(options) {
    let request;
    try {
      request = locks.request(SIGNALS_LOCK, options, lead);
    } catch (error) {
      request = Promise.reject(error);
    }
    return Promise.resolve(request);
  }

  function queueForLock() {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    lockAbort = controller;
    requestLock(controller ? { signal: controller.signal } : {}).catch(() => {
      if (closed || controller !== lockAbort) return;
      if (role === "leader") {
        stepDown();
        return;
      }
      if (role !== "follower") return;
      // A sandboxed frame without lock access: this tab holds its own stream rather than none.
      role = "solo";
      try {
        channel?.close();
      } catch {
        // Already closed.
      }
      channel = null;
      connect();
    });
  }

  /** Another tab took the lock: this one follows it, and queues to lead again later. */
  function stepDown() {
    role = "follower";
    releaseLock = null;
    dropStream();
    if (retry !== null) cancel(retry);
    retry = null;
    lastHeard = now();
    leaderOpen = false;
    emitHealth();
    queueForLock();
  }

  /** Takes the lock from a leader that went quiet; its own `ready` then resyncs every tab. */
  function takeOver() {
    if (stealing) return;
    stealing = true;
    const queued = lockAbort;
    lockAbort = null;
    requestLock({ steal: true }).catch(() => {
      if (closed) return;
      // Stolen back in turn: this tab follows again.
      if (role === "leader") stepDown();
      else stealing = false;
    });
    queued?.abort();
  }

  function onMessage(event) {
    const message = event?.data;
    if (message?.type === "hello") {
      if (role === "leader") post({ type: "state", open: streamOpen, stopped });
      return;
    }
    if (role !== "follower") return;
    lastHeard = now();
    if (message?.type === "state") {
      leaderOpen = message.open === true;
      if (message.stopped === true && !stopped) {
        stopped = true;
        onSessionGone();
      }
    } else if (message?.type === "beat") {
      leaderOpen = true;
    } else {
      const signal = asSignal(message);
      if (!signal) return;
      if (signal.type === "ready") leaderOpen = true;
      deliver(signal);
    }
    emitHealth();
  }

  function start() {
    if (role !== "idle" || closed || typeof EventSourceImpl !== "function") return;
    watchTimer = schedule(watch, WATCH_MS);
    if (typeof locks?.request !== "function" || typeof ChannelImpl !== "function") {
      role = "solo";
      connect();
      return;
    }
    role = "follower";
    lastHeard = now();
    channel = new ChannelImpl(SIGNALS_CHANNEL);
    channel.onmessage = onMessage;
    post({ type: "hello" });
    queueForLock();
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
    /** Whether signals are arriving: a stream open and beating, here or at the leader. */
    get healthy() {
      return healthy();
    },
    /** `listener(healthy)` hears every change of `healthy`. Returns the unsubscribe. */
    onHealth(listener) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    /** Which part this tab plays: "idle", "leader", "follower", "solo", "stopped" or "closed". */
    get role() {
      return closed ? "closed" : stopped ? "stopped" : role;
    },
    /** Lets go of the stream, the lock and the channel; a later tab takes over. */
    close() {
      if (closed) return;
      closed = true;
      if (retry !== null) cancel(retry);
      if (watchTimer !== null) cancel(watchTimer);
      retry = null;
      watchTimer = null;
      source?.close();
      source = null;
      lockAbort?.abort();
      releaseLock?.();
      try {
        channel?.close();
      } catch {
        // Already closed.
      }
      listeners.clear();
      healthListeners.clear();
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
 * `onSignal` is used, so callers need not memoise it. A hidden tab reads nothing: what it heard
 * while hidden is delivered once, when it comes back into view (a `ready` if one came).
 */
export function usePortalSignal(topic, onSignal, { enabled = true, signals = null } = {}) {
  const callback = useRef(onSignal);
  callback.current = onSignal;
  useEffect(() => {
    if (!enabled) return undefined;
    let missed = null;
    const hidden = () => globalThis.document?.hidden === true;
    const unsubscribe = (signals ?? portalSignals()).subscribe((signal) => {
      if (!hidden()) callback.current(signal);
      else if (missed?.type !== "ready") missed = signal;
    }, topic);
    const onVisibility = () => {
      if (hidden() || missed === null) return;
      const signal = missed;
      missed = null;
      callback.current(signal);
    };
    globalThis.document?.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      globalThis.document?.removeEventListener("visibilitychange", onVisibility);
    };
  }, [topic, enabled, signals]);
}

/** Whether the connection is healthy, kept current. */
export function useSignalsHealthy(signals = null) {
  const source = signals ?? portalSignals();
  const [healthy, setHealthy] = useState(source.healthy);
  useEffect(() => {
    setHealthy(source.healthy);
    return source.onHealth(setHealthy);
  }, [source]);
  return healthy;
}

/**
 * Reads `refresh()` every `SIGNAL_FALLBACK_MS` while the signals are not healthy (and at once when
 * a hidden tab comes back into view meanwhile); nothing while they are, since a signal then says
 * when to read.
 */
export function useSignalFallback(refresh, { enabled = true, signals = null } = {}) {
  const healthy = useSignalsHealthy(signals);
  useVisiblePoll(refresh, SIGNAL_FALLBACK_MS, { enabled: enabled && !healthy });
}
