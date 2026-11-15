// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A stand-in for the gateway's signal stream in view tests: views subscribe
// through the real `usePortalSignal`, and the test says what the gateway
// signalled. Mock the module with it:
//
//   const signals = vi.hoisted(() => ({ emit: (_topic: string | null) => {} }));
//   vi.mock("../lib/portal-signals.js", async (importOriginal) =>
//     (await import("../lib/portal-signals-fake.js")).mockPortalSignals(await importOriginal(), signals));
//
// `signals.emit("devices")` signals a change of that topic; `signals.emit(null)`
// a `ready`, which every subscriber hears.

type Signal = { type: "ready" } | { type: "changed"; topic: string };
type Listener = (signal: Signal) => void;
type Hook = (topic: string, onSignal: Listener, options?: Record<string, unknown>) => void;

export function mockPortalSignals(
  actual: Record<string, unknown>,
  holder: { emit: (topic: string | null) => void },
) {
  const subscribers = new Set<{ listener: Listener; topic: string | null }>();
  const fake = {
    role: "solo",
    subscribe(listener: Listener, topic: string | null = null) {
      const entry = { listener, topic };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    close() {},
  };
  holder.emit = (topic) => {
    const signal: Signal = topic === null ? { type: "ready" } : { type: "changed", topic };
    for (const { listener, topic: wanted } of [...subscribers]) {
      if (signal.type === "changed" && wanted !== null && wanted !== signal.topic) continue;
      listener(signal);
    }
  };
  const usePortalSignal = actual.usePortalSignal as Hook;
  return {
    ...actual,
    portalSignals: () => fake,
    usePortalSignal: (topic: string, onSignal: Listener, options: Record<string, unknown> = {}) =>
      usePortalSignal(topic, onSignal, { ...options, signals: fake }),
  };
}
