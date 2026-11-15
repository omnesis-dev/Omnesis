// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SIGNALS_URL,
  STABLE_STREAM_MS,
  createPortalSignals,
  reconnectDelay,
  usePortalSignal,
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
      listener({ data: typeof data === "string" ? data : JSON.stringify(data) });
    }
  }
  static open() {
    return FakeEventSource.instances.filter((source) => !source.closed);
  }
}

/** A browser's lock manager (navigator.locks), shared by the tabs created against it: one holder, the rest queued. */
function createLocks() {
  let held = false;
  const queue: Array<() => void> = [];
  const grantNext = () => {
    const next = queue.shift();
    if (next) next();
    else held = false;
  };
  return {
    request(_name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown> | unknown) {
      return new Promise((resolve, reject) => {
        const grant = () => {
          held = true;
          Promise.resolve(callback()).then((value) => {
            grantNext();
            resolve(value);
          });
        };
        if (!held) {
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

/** Lets lock grants, relayed messages and their listeners run. */
async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("one stream per browser, shared by its tabs", () => {
  function browser() {
    const locks = createLocks();
    const BroadcastChannel = createChannels();
    return () => createPortalSignals({ EventSource: FakeEventSource, locks, BroadcastChannel, random: () => 0 });
  }

  test("the first tab leads and opens the one stream; the others follow and hear every frame", async () => {
    const tab = browser();
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
    stream.emit("ready", {});
    stream.emit("changed", { topic: "devices" });
    stream.emit("changed", { topic: "answers" });
    await flush();
    const all = [{ type: "ready" }, { type: "changed", topic: "devices" }, { type: "changed", topic: "answers" }];
    expect(heardFirst).toEqual(all);
    expect(heardSecond).toEqual(all);
    // A topic subscriber hears its topic and every resync, nothing else.
    expect(devicesOnly).toEqual([{ type: "ready" }, { type: "changed", topic: "devices" }]);
  });

  test("when the leading tab closes, the next one opens its own stream, whose ready resyncs every tab", async () => {
    const tab = browser();
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

    FakeEventSource.open()[0].emit("ready", {});
    await flush();
    expect(heardThird).toEqual([{ type: "ready" }]);
  });

  test("a follower that closes leaves the queue without ever leading", async () => {
    const tab = browser();
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

  test("a follower never relays a frame twice, and an unknown message is ignored", async () => {
    const tab = browser();
    const first = tab();
    const second = tab();
    const heard: unknown[] = [];
    first.subscribe(() => {});
    second.subscribe((signal: unknown) => heard.push(signal));
    await flush();
    const Channel = createChannels();
    // A message in another shape on the same channel name, from some other page of this origin.
    new Channel("omnesis:portal-signals").postMessage({ type: "nonsense" });
    FakeEventSource.instances[0].emit("changed", { topic: "access" });
    await flush();
    expect(heard).toEqual([{ type: "changed", topic: "access" }]);
  });
});

describe("where a browser cannot share, each tab holds its own stream", () => {
  test("without navigator.locks", async () => {
    const BroadcastChannel = createChannels();
    const first = createPortalSignals({ EventSource: FakeEventSource, locks: null, BroadcastChannel });
    const second = createPortalSignals({ EventSource: FakeEventSource, locks: null, BroadcastChannel });
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
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks: createLocks(), BroadcastChannel: null });
    signals.subscribe(() => {});
    expect(signals.role).toBe("solo");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("when the lock is refused", async () => {
    const locks = { request: vi.fn(() => Promise.reject(new Error("SecurityError"))) };
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks, BroadcastChannel: createChannels() });
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
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks, BroadcastChannel: createChannels() });
    signals.subscribe(() => {});
    await flush();
    expect(signals.role).toBe("solo");
  });

  test("without EventSource nothing connects and nothing is heard", () => {
    const signals = createPortalSignals({ EventSource: null, locks: null, BroadcastChannel: null });
    const unsubscribe = signals.subscribe(() => {});
    expect(signals.role).toBe("idle");
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

  test("a refused or dropped stream is closed and retried on a growing delay, reset by ready", async () => {
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks: null, random: () => 1 });
    signals.subscribe(() => {});
    const first = FakeEventSource.instances[0];
    // A 503 from a full gateway reaches EventSource as an error.
    first.emit("error");
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(RECONNECT_BASE_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.instances[1].emit("error");
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 2 - 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    // A stream cut right after its ready is still failing: the delay keeps growing.
    FakeEventSource.instances[2].emit("ready", {});
    FakeEventSource.instances[2].emit("error");
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 4 - 1);
    expect(FakeEventSource.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(4);

    // One that stayed open past its ready proved itself: the next drop starts from the base.
    FakeEventSource.instances[3].emit("ready", {});
    vi.advanceTimersByTime(STABLE_STREAM_MS);
    FakeEventSource.instances[3].emit("error");
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(FakeEventSource.instances).toHaveLength(5);
  });

  test("a stream that cannot be constructed is retried too", () => {
    let attempts = 0;
    class Throwing {
      constructor() {
        attempts += 1;
        throw new Error("blocked");
      }
    }
    const signals = createPortalSignals({ EventSource: Throwing, locks: null, random: () => 1 });
    signals.subscribe(() => {});
    expect(attempts).toBe(1);
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(attempts).toBe(2);
    signals.close();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(attempts).toBe(2);
  });

  test("frames from a stream already replaced are ignored", () => {
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks: null, random: () => 1 });
    const heard: unknown[] = [];
    signals.subscribe((signal: unknown) => heard.push(signal));
    const stale = FakeEventSource.instances[0];
    stale.emit("error");
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    stale.emit("ready", {});
    stale.emit("changed", { topic: "devices" });
    stale.emit("error");
    expect(heard).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  test("close stops the retry and the stream", () => {
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks: null });
    signals.subscribe(() => {});
    FakeEventSource.instances[0].emit("error");
    signals.close();
    signals.close();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(signals.role).toBe("closed");
  });
});

describe("frames", () => {
  test("a malformed change is dropped, and one listener failing does not silence the others", () => {
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks: null });
    const heard: unknown[] = [];
    signals.subscribe(() => {
      throw new Error("listener bug");
    });
    signals.subscribe((signal: unknown) => heard.push(signal));
    const stream = FakeEventSource.instances[0];
    stream.emit("changed", "not json");
    stream.emit("changed", { topic: "" });
    stream.emit("changed", { other: 1 });
    stream.emit("changed", { topic: "devices" });
    expect(heard).toEqual([{ type: "changed", topic: "devices" }]);
  });

  test("an unsubscribed listener hears nothing more", () => {
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks: null });
    const heard: unknown[] = [];
    const unsubscribe = signals.subscribe((signal: unknown) => heard.push(signal));
    unsubscribe();
    FakeEventSource.instances[0].emit("ready", {});
    expect(heard).toEqual([]);
  });
});

describe("usePortalSignal", () => {
  test("calls the latest callback for its topic and every ready, only while enabled", async () => {
    const parsed = parseHTML("<html><body><main></main></body></html>");
    vi.stubGlobal("document", parsed.document);
    vi.stubGlobal("window", parsed.window);
    const host = parsed.document.querySelector("main") as unknown as HTMLElement;
    const signals = createPortalSignals({ EventSource: FakeEventSource, locks: null });
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
    stream.emit("ready", {});
    expect(calls).toEqual(["b:changed", "b:ready"]);
    await act(async () => render(h(Probe, { enabled: false, tag: "b" }), host));
    stream.emit("changed", { topic: "access" });
    expect(calls).toHaveLength(2);
    render(null, host);
    vi.unstubAllGlobals();
  });
});
