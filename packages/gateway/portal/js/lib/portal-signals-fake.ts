// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A stand-in for the gateway's signal connection in tests: views subscribe
// through the real hooks, and the test says what the gateway signalled and
// whether the connection is healthy. Mock the module with it:
//
//   const signals = vi.hoisted(() => ({ emit: (_topic: string | null) => {}, setHealthy: (_h: boolean) => {} }));
//   vi.mock("../lib/portal-signals.js", async (importOriginal) =>
//     (await import("../lib/portal-signals-fake.js")).mockPortalSignals(await importOriginal(), signals));
//
// `signals.emit("devices")` signals a change of that topic; `signals.emit(null)`
// a `ready`, which every subscriber hears. The connection starts unhealthy, as
// one with no stream is, so fallback reads run until `setHealthy(true)`.

type Signal = { type: "ready" } | { type: "changed"; topic: string };
type Listener = (signal: Signal) => void;
type Options = Record<string, unknown>;

/** A fake connection: `subscribe`/`healthy`/`onHealth` like the real one, plus the test's controls. */
export function fakePortalSignals() {
  const subscribers = new Set<{ listener: Listener; topic: string | null }>();
  const healthListeners = new Set<(healthy: boolean) => void>();
  let healthy = false;
  return {
    role: "solo",
    subscribe(listener: Listener, topic: string | null = null) {
      const entry = { listener, topic };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    get healthy() {
      return healthy;
    },
    onHealth(listener: (healthy: boolean) => void) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    close() {},
    emit(topic: string | null) {
      const signal: Signal = topic === null ? { type: "ready" } : { type: "changed", topic };
      for (const { listener, topic: wanted } of [...subscribers]) {
        if (signal.type === "changed" && wanted !== null && wanted !== signal.topic) continue;
        listener(signal);
      }
    },
    setHealthy(next: boolean) {
      healthy = next;
      for (const listener of [...healthListeners]) listener(next);
    },
  };
}

export function mockPortalSignals(
  actual: Record<string, unknown>,
  holder: { emit: (topic: string | null) => void; setHealthy?: (healthy: boolean) => void },
) {
  const fake = fakePortalSignals();
  holder.emit = (topic) => fake.emit(topic);
  holder.setHealthy = (healthy) => fake.setHealthy(healthy);
  const withFake =
    (hook: unknown) =>
    (first: unknown, second?: unknown, options: Options = {}) =>
      (hook as (a: unknown, b?: unknown, o?: Options) => unknown)(first, second, { ...options, signals: fake });
  return {
    ...actual,
    portalSignals: () => fake,
    usePortalSignal: withFake(actual.usePortalSignal),
    useSignalFallback: (refresh: unknown, options: Options = {}) =>
      (actual.useSignalFallback as (r: unknown, o: Options) => void)(refresh, { ...options, signals: fake }),
    useSignalsHealthy: () => (actual.useSignalsHealthy as (s: unknown) => boolean)(fake),
  };
}
