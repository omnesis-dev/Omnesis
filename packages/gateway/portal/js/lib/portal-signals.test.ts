// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BEAT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SIGNALS_URL,
  SIGNAL_FALLBACK_MS,
  STABLE_STREAM_MS,
  STALE_MS,
  createPortalSignals,
  reconnectDelay,
  usePortalSignal,
  useSignalFallback,
  // @ts-expect-error — portal modules are plain JS.
} from "./portal-signals.js";

type Listener = (event: { data?: string }) => void;

/** One server-sent event stream, driven by the test. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();
  constructor(
    public url: string,
    public options: unknown,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: typeof data === "string" ? data : JSON.stringify(data ?? {}) });
    }
  }
  static open() {
    return FakeEventSource.instances.filter((source) => !source.closed);
  }
  static last() {
    return FakeEventSource.instances.at(-1)!;
  }
}

/**
 * A browser's lock manager (navigator.locks), shared by the tabs created against it: one holder,
 * the rest queued; `steal` takes the lock from the holder, whose request then rejects.
 */
function createLocks() {
  let holder: { reject: (error: unknown) => void } | null = null;
  const queue: Array<() => void> = [];
  const grantNext = () => {
    holder = null;
    queue.shift()?.();
  };
  return {
    request(
      _name: string,
      options: { signal?: AbortSignal; steal?: boolean },
      callback: () => Promise<unknown> | unknown,
    ) {
      return new Promise((resolve, reject) => {
        const grant = () => {
          const mine = { reject };
          holder = mine;
          Promise.resolve(callback()).then((value) => {
            if (holder === mine) grantNext();
            resolve(value);
          });
        };
        if (options.steal) {
          holder?.reject(new DOMException("stolen", "AbortError"));
          grant();
          return;
        }
        if (holder === null) {
          grant();
          return;
        }
        queue.push(grant);
        options.signal?.addEventListener("abort", () => {
          const at = queue.indexOf(grant);
          if (at >= 0) queue.splice(at, 1);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  };
}

/** A BroadcastChannel bus shared by the tabs created against it; a tab never hears itself. */
function createChannels() {
  const open = new Set<FakeChannel>();
  class FakeChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(public name: string) {
      open.add(this);
    }
    postMessage(data: unknown) {
      for (const other of open) {
        if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data }));
      }
    }
    close() {
      open.delete(this);
    }
  }
  return FakeChannel;
}

/** Lets lock grants, relayed messages, session checks and their listeners run. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** A connection with no sharing, a session that is never gone, and jitter at the top of each ceiling. */
function solo(options: Record<string, unknown> = {}) {
  return createPortalSignals({
    EventSource: FakeEventSource,
    locks: null,
    BroadcastChannel: null,
    random: () => 1,
    sessionGone: async () => false,
    onSessionGone: () => {},
    ...options,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("one stream per browser, shared by its tabs", () => {
  function browser(visible = () => true) {
    const locks = createLocks();
    const BroadcastChannel = createChannels();
    const onSessionGone = vi.fn();
    const tab = (extra: Record<string, unknown> = {}) =>
      createPortalSignals({
        EventSource: FakeEventSource,
        locks,
        BroadcastChannel,
        random: () => 0,
        visible,
        sessionGone: async () => false,
        onSessionGone,
        ...extra,
      });
    return { tab, onSessionGone };
  }

  test("the first tab leads and opens the one stream; the others follow and hear every frame", async () => {
    const { tab } = browser();
    const first = tab();
    const second = tab();
    const heardFirst: unknown[] = [];
    const heardSecond: unknown[] = [];
    const devicesOnly: unknown[] = [];
    first.subscribe((signal: unknown) => heardFirst.push(signal));
    second.subscribe((signal: unknown) => heardSecond.push(signal));
    second.subscribe((signal: unknown) => devicesOnly.push(signal), "devices");
    await flush();

    expect(first.role).toBe("leader");
    expect(second.role).toBe("follower");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(SIGNALS_URL);
    expect(FakeEventSource.instances[0].options).toEqual({ withCredentials: true });

    const stream = FakeEventSource.instances[0];
    stream.emit("ready");
    stream.emit("changed", { topic: "devices" });
    stream.emit("beat");
    stream.emit("changed", { topic: "answers" });
    await flush();
    const all = [{ type: "ready" }, { type: "changed", topic: "devices" }, { type: "changed", topic: "answers" }];
    expect(heardFirst).toEqual(all);
    expect(heardSecond).toEqual(all);
    // A topic subscriber hears its topic and every resync, nothing else.
    expect(devicesOnly).toEqual([{ type: "ready" }, { type: "changed", topic: "devices" }]);
  });

  test("a follower is healthy while the leader's stream is open, and hears when it goes down", async () => {
    const { tab } = browser();
    const first = tab();
    const second = tab();
    first.subscribe(() => {});
    second.subscribe(() => {});
    const changes: boolean[] = [];
    second.onHealth((healthy: boolean) => changes.push(healthy));
    await flush();
    expect(first.healthy).toBe(false);
    expect(second.healthy).toBe(false);

    FakeEventSource.instances[0].emit("ready");
    await flush();
    expect(first.healthy).toBe(true);
    expect(second.healthy).toBe(true);

    // The leader's stream drops (a 503 or a gateway restart): every tab falls back at once.
    FakeEventSource.instances[0].emit("error");
    await flush();
    expect(first.healthy).toBe(false);
    expect(second.healthy).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("a tab that joins late asks the leader and learns its stream is open", async () => {
    const { tab } = browser();
    const first = tab();
    first.subscribe(() => {});
    await flush();
    FakeEventSource.instances[0].emit("ready");
    const late = tab();
    late.subscribe(() => {});
    await flush();
    expect(late.role).toBe("follower");
    expect(late.healthy).toBe(true);
  });

  test("a leader that is alive but backing off keeps its followers from taking over", async () => {
    const { tab } = browser();
    const first = tab();
    const second = tab();
    first.subscribe(() => {});
    second.subscribe(() => {});
    await flush();
    FakeEventSource.instances[0].emit("error");
    for (let elapsed = 0; elapsed < STALE_MS * 2; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      // The retry keeps failing.
      FakeEventSource.open()[0]?.emit("error");
    }
    expect(first.role).toBe("leader");
    expect(second.role).toBe("follower");
  });

  test("a visible follower takes over from a leader that went quiet, which steps down", async () => {
    const { tab } = browser();
    // The first tab's timers stand still, as a frozen tab's do.
    const frozen = tab({ setTimeout: () => 0, clearTimeout: () => {} });
    const second = tab();
    const heard: unknown[] = [];
    frozen.subscribe(() => {});
    second.subscribe((signal: unknown) => heard.push(signal));
    await flush();
    const frozenStream = FakeEventSource.instances[0];
    frozenStream.emit("ready");
    await flush();
    expect(second.healthy).toBe(true);

    // Its stream is gone and it says nothing more.
    frozenStream.close();
    await vi.advanceTimersByTimeAsync(STALE_MS - 5_000);
    expect(second.role).toBe("follower");
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(second.healthy).toBe(false);
    expect(second.role).toBe("leader");
    expect(frozen.role).toBe("follower");
    expect(FakeEventSource.open()).toEqual([FakeEventSource.last()]);
    FakeEventSource.last().emit("ready");
    await flush();
    expect(heard.at(-1)).toEqual({ type: "ready" });
    expect(second.healthy).toBe(true);
  });

  test("a hidden follower does not take over; it does once on screen", async () => {
    let onScreen = false;
    const { tab } = browser(() => onScreen);
    const frozen = tab({ setTimeout: () => 0, clearTimeout: () => {}, visible: () => true });
    const second = tab();
    frozen.subscribe(() => {});
    second.subscribe(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(STALE_MS * 2);
    expect(second.role).toBe("follower");
    onScreen = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(second.role).toBe("leader");
  });

  test("a leader's relayed beats keep its followers from taking over while its stream is open", async () => {
    const { tab } = browser();
    // The leader's own timers stand still; only the server's beats arrive.
    const first = tab({ setTimeout: () => 0, clearTimeout: () => {} });
    const second = tab();
    first.subscribe(() => {});
    second.subscribe(() => {});
    await flush();
    FakeEventSource.instances[0].emit("ready");
    for (let elapsed = 0; elapsed < STALE_MS * 3; elapsed += BEAT_MS) {
      await vi.advanceTimersByTimeAsync(BEAT_MS);
      FakeEventSource.instances[0].emit("beat");
      await flush();
    }
    expect(second.role).toBe("follower");
    expect(second.healthy).toBe(true);
  });

  test("when the leading tab closes, the next one opens its own stream, whose ready resyncs every tab", async () => {
    const { tab } = browser();
    const first = tab();
    const second = tab();
    const third = tab();
    const heardThird: unknown[] = [];
    first.subscribe(() => {});
    second.subscribe(() => {});
    third.subscribe((signal: unknown) => heardThird.push(signal));
    await flush();
    const firstStream = FakeEventSource.instances[0];

    first.close();
    await flush();
    expect(firstStream.closed).toBe(true);
    expect(second.role).toBe("leader");
    expect(third.role).toBe("follower");
    expect(FakeEventSource.open()).toHaveLength(1);

    FakeEventSource.open()[0].emit("ready");
    await flush();
    expect(heardThird).toEqual([{ type: "ready" }]);
  });

  test("a follower that closes leaves the queue without ever leading", async () => {
    const { tab } = browser();
    const first = tab();
    const second = tab();
    first.subscribe(() => {});
    second.subscribe(() => {});
    await flush();
    second.close();
    first.close();
    await flush();
    expect(second.role).toBe("closed");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("an unknown message is ignored", async () => {
    const { tab } = browser();
    const first = tab();
    const second = tab();
    const heard: unknown[] = [];
    first.subscribe(() => {});
    second.subscribe((signal: unknown) => heard.push(signal));
    await flush();
    const Channel = createChannels();
    new Channel("omnesis:portal-signals").postMessage({ type: "nonsense" });
    FakeEventSource.instances[0].emit("changed", { topic: "access" });
    await flush();
    expect(heard).toEqual([{ type: "changed", topic: "access" }]);
  });

  test("a session gone at the leader stops every tab and hands over to the sign-in", async () => {
    const { tab, onSessionGone } = browser();
    const first = tab({ sessionGone: async () => true });
    const second = tab();
    first.subscribe(() => {});
    second.subscribe(() => {});
    await flush();
    FakeEventSource.instances[0].emit("error");
    await flush();
    expect(first.role).toBe("stopped");
    expect(second.role).toBe("stopped");
    expect(onSessionGone).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(second.healthy).toBe(false);
  });
});

describe("where a browser cannot share, each tab holds its own stream", () => {
  test("without navigator.locks", async () => {
    const BroadcastChannel = createChannels();
    const first = solo({ BroadcastChannel });
    const second = solo({ BroadcastChannel });
    const heard: unknown[] = [];
    first.subscribe((signal: unknown) => heard.push(signal));
    second.subscribe(() => {});
    expect(first.role).toBe("solo");
    expect(second.role).toBe("solo");
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[0].emit("changed", { topic: "watches" });
    expect(heard).toEqual([{ type: "changed", topic: "watches" }]);
  });

  test("without BroadcastChannel", () => {
    const signals = solo({ locks: createLocks() });
    signals.subscribe(() => {});
    expect(signals.role).toBe("solo");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("when the lock is refused", async () => {
    const locks = { request: vi.fn(() => Promise.reject(new Error("SecurityError"))) };
    const signals = solo({ locks, BroadcastChannel: createChannels() });
    signals.subscribe(() => {});
    await flush();
    expect(signals.role).toBe("solo");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("when asking for the lock throws", async () => {
    const locks = {
      request: vi.fn(() => {
        throw new Error("unavailable");
      }),
    };
    const signals = solo({ locks, BroadcastChannel: createChannels() });
    signals.subscribe(() => {});
    await flush();
    expect(signals.role).toBe("solo");
  });

  test("without EventSource nothing connects, nothing is heard, and it is never healthy", () => {
    const signals = solo({ EventSource: null });
    const unsubscribe = signals.subscribe(() => {});
    expect(signals.role).toBe("idle");
    expect(signals.healthy).toBe(false);
    unsubscribe();
  });
});

describe("reconnecting", () => {
  test("the delay doubles from the base to the cap, in the upper half of each ceiling", () => {
    expect(reconnectDelay(0, () => 0)).toBe(RECONNECT_BASE_MS / 2);
    expect(reconnectDelay(0, () => 1)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(3, () => 1)).toBe(RECONNECT_BASE_MS * 8);
    expect(reconnectDelay(20, () => 1)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(1000, () => 0.5)).toBe(RECONNECT_MAX_MS * 0.75);
  });

  test("a refused or dropped stream is closed and retried on a growing delay, reset by a stream that held", async () => {
    const signals = solo();
    signals.subscribe(() => {});
    const first = FakeEventSource.instances[0];
    // A 503 from a full gateway reaches EventSource as an error.
    first.emit("error");
    await flush();
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.instances[1].emit("error");
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 2 - 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    // A stream cut right after its ready is still failing: the delay keeps growing.
    FakeEventSource.instances[2].emit("ready");
    FakeEventSource.instances[2].emit("error");
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 4 - 1);
    expect(FakeEventSource.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(4);

    // One that stayed open past its ready proved itself: the next drop starts from the base.
    FakeEventSource.instances[3].emit("ready");
    for (let elapsed = 0; elapsed < STABLE_STREAM_MS; elapsed += BEAT_MS / 5) {
      await vi.advanceTimersByTimeAsync(BEAT_MS / 5);
      FakeEventSource.instances[3].emit("beat");
    }
    FakeEventSource.instances[3].emit("error");
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(FakeEventSource.instances).toHaveLength(5);
  });

  test("a stream that stops beating without an error is started over", async () => {
    const signals = solo();
    signals.subscribe(() => {});
    FakeEventSource.instances[0].emit("ready");
    expect(signals.healthy).toBe(true);
    await vi.advanceTimersByTimeAsync(STALE_MS - 5_000);
    expect(FakeEventSource.instances[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(signals.healthy).toBe(false);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  test("a gone session stops reconnecting and hands over to the sign-in", async () => {
    const onSessionGone = vi.fn();
    const signals = solo({ sessionGone: async () => true, onSessionGone });
    signals.subscribe(() => {});
    FakeEventSource.instances[0].emit("error");
    await flush();
    expect(onSessionGone).toHaveBeenCalledOnce();
    expect(signals.role).toBe("stopped");
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 3);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("a session check that cannot reach the gateway is retried like any drop", async () => {
    const signals = solo({ sessionGone: async () => Promise.reject(new Error("offline")) });
    signals.subscribe(() => {});
    FakeEventSource.instances[0].emit("error");
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  test("the default session check reads the session route, and announces a gone session", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ authenticated: false }) }));
    vi.stubGlobal("fetch", fetchMock);
    const dispatched: string[] = [];
    vi.stubGlobal("window", { dispatchEvent: (event: Event) => dispatched.push(event.type) });
    try {
      const signals = createPortalSignals({ EventSource: FakeEventSource, locks: null, BroadcastChannel: null });
      signals.subscribe(() => {});
      FakeEventSource.instances[0].emit("error");
      await flush();
      expect(fetchMock).toHaveBeenCalledWith("/portal/api/session", { credentials: "same-origin", cache: "no-store" });
      expect(dispatched).toEqual(["omnesis:session-expired"]);

      for (const [answer, gone] of [
        [{ status: 401, ok: false, json: async () => ({}) }, true],
        [{ status: 503, ok: false, json: async () => ({}) }, false],
        [{ status: 200, ok: true, json: async () => ({ authenticated: true }) }, false],
      ] as const) {
        FakeEventSource.instances = [];
        dispatched.length = 0;
        fetchMock.mockResolvedValueOnce(answer as never);
        const next = createPortalSignals({ EventSource: FakeEventSource, locks: null, BroadcastChannel: null });
        next.subscribe(() => {});
        FakeEventSource.instances[0].emit("error");
        await flush();
        expect(dispatched.length > 0).toBe(gone);
        next.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a stream that cannot be constructed is retried too", async () => {
    let attempts = 0;
    class Throwing {
      constructor() {
        attempts += 1;
        throw new Error("blocked");
      }
    }
    const signals = solo({ EventSource: Throwing });
    signals.subscribe(() => {});
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(attempts).toBe(2);
    signals.close();
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
    expect(attempts).toBe(2);
  });

  test("frames from a stream already replaced are ignored", async () => {
    const signals = solo();
    const heard: unknown[] = [];
    signals.subscribe((signal: unknown) => heard.push(signal));
    const stale = FakeEventSource.instances[0];
    stale.emit("error");
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    stale.emit("ready");
    stale.emit("beat");
    stale.emit("changed", { topic: "devices" });
    stale.emit("error");
    await flush();
    expect(heard).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  test("close stops the retry, the watch and the stream", async () => {
    const signals = solo();
    signals.subscribe(() => {});
    FakeEventSource.instances[0].emit("error");
    await flush();
    signals.close();
    signals.close();
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(signals.role).toBe("closed");
    expect(signals.healthy).toBe(false);
  });
});

describe("frames", () => {
  test("a malformed change is dropped, and one listener failing does not silence the others", () => {
    const signals = solo();
    const heard: unknown[] = [];
    signals.subscribe(() => {
      throw new Error("listener bug");
    });
    signals.onHealth(() => {
      throw new Error("listener bug");
    });
    signals.subscribe((signal: unknown) => heard.push(signal));
    const stream = FakeEventSource.instances[0];
    stream.emit("changed", "not json");
    stream.emit("changed", { topic: "" });
    stream.emit("changed", { other: 1 });
    stream.emit("changed", { topic: "devices" });
    stream.emit("ready");
    expect(heard).toEqual([{ type: "changed", topic: "devices" }, { type: "ready" }]);
    expect(signals.healthy).toBe(true);
  });

  test("an unsubscribed listener hears nothing more", () => {
    const signals = solo();
    const heard: unknown[] = [];
    const unsubscribe = signals.subscribe((signal: unknown) => heard.push(signal));
    const unwatch = signals.onHealth((healthy: boolean) => heard.push(healthy));
    unsubscribe();
    unwatch();
    FakeEventSource.instances[0].emit("ready");
    expect(heard).toEqual([]);
  });
});

describe("hooks", () => {
  let host: HTMLElement;
  let doc: Document & { hidden?: boolean };
  beforeEach(() => {
    const parsed = parseHTML("<html><body><main></main></body></html>");
    doc = parsed.document as unknown as Document & { hidden?: boolean };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", parsed.window);
    host = parsed.document.querySelector("main") as unknown as HTMLElement;
  });
  afterEach(() => {
    render(null, host);
    vi.unstubAllGlobals();
  });
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(doc, "hidden", { configurable: true, get: () => hidden });
    doc.dispatchEvent(new (globalThis.window as unknown as { Event: typeof Event }).Event("visibilitychange"));
  };

  test("usePortalSignal calls the latest callback for its topic and every ready, only while enabled", async () => {
    const signals = solo();
    const calls: string[] = [];
    function Probe({ enabled, tag }: { enabled: boolean; tag: string }) {
      usePortalSignal("access", (signal: { type: string }) => calls.push(`${tag}:${signal.type}`), { enabled, signals });
      return null;
    }
    await act(async () => render(h(Probe, { enabled: true, tag: "a" }), host));
    await act(async () => render(h(Probe, { enabled: true, tag: "b" }), host));
    const stream = FakeEventSource.instances[0];
    stream.emit("changed", { topic: "access" });
    stream.emit("changed", { topic: "devices" });
    stream.emit("ready");
    expect(calls).toEqual(["b:changed", "b:ready"]);
    await act(async () => render(h(Probe, { enabled: false, tag: "b" }), host));
    stream.emit("changed", { topic: "access" });
    expect(calls).toHaveLength(2);
  });

  test("a hidden tab reads nothing on a signal, then once when it comes back into view", async () => {
    const signals = solo();
    const calls: string[] = [];
    function Probe() {
      usePortalSignal("access", (signal: { type: string }) => calls.push(signal.type), { signals });
      return null;
    }
    await act(async () => render(h(Probe, {}), host));
    const stream = FakeEventSource.instances[0];
    setHidden(true);
    stream.emit("changed", { topic: "access" });
    stream.emit("ready");
    stream.emit("changed", { topic: "access" });
    expect(calls).toEqual([]);
    setHidden(false);
    expect(calls).toEqual(["ready"]);
    // Nothing more was missed: coming into view again reads nothing.
    setHidden(true);
    setHidden(false);
    expect(calls).toEqual(["ready"]);
  });

  test("useSignalFallback reads on an interval only while the connection is not healthy", async () => {
    const signals = solo();
    const refresh = vi.fn();
    function Probe() {
      useSignalFallback(refresh, { signals });
      return null;
    }
    signals.subscribe(() => {});
    await act(async () => render(h(Probe, {}), host));
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { FakeEventSource.instances[0].emit("ready"); });
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS * 3); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { FakeEventSource.instances[0].emit("error"); });
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
