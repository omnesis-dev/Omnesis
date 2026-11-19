// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { ATTENTION_PAGE_LIMIT, useAttention } from "./use-attention.js";
// @ts-expect-error — portal modules are plain JS.
import { SIGNAL_FALLBACK_MS } from "./portal-signals.js";
// @ts-expect-error — portal modules are plain JS.
import { earliestExpiry, notExpired } from "./use-refresh-at.js";

import { fakePortalSignals } from "./portal-signals-fake.js";

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const cloudRequest = (requestId: string, expiresIn = 600_000, status = "pending") => ({
  requestId,
  status,
  expiresAt: NOW + expiresIn,
});
const join = (id: string, expiresIn = 600_000) => ({
  id,
  name: "studio-laptop",
  expiresAt: new Date(NOW + expiresIn).toISOString(),
});
const accessRequest = (id: string, expiresIn = 300_000) => ({
  id,
  clientName: "Fictional planner",
  expiresAt: NOW + expiresIn,
});
const approvals = (count: number, expiresIn = 900_000) => ({
  approvals: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, expiresAt: NOW + expiresIn + i * 1000 })),
  totalCount: count,
  nextCursor: null,
});

let host: HTMLElement;
let api: Record<string, ReturnType<typeof vi.fn>>;
let signals: ReturnType<typeof fakePortalSignals>;
let seen: Record<string, { count: number; [key: string]: unknown }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api = {
    cloudPairingConfig: vi.fn(async () => ({ clientId: "fictional-client" })),
    cloudPairingRequests: vi.fn(async () => ({ items: [] as unknown[] })),
    tailscaleJoinRequests: vi.fn(async () => ({ requests: [] as unknown[] })),
    getPendingAccessRequests: vi.fn(async () => ({ pendingRequests: [] as unknown[] })),
    listPrivacyApprovals: vi.fn(async () => approvals(0)),
    listSubscriptionApprovals: vi.fn(async () => approvals(0)),
  };
  signals = fakePortalSignals();
  seen = {};
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Probe(features: Record<string, boolean>) {
  seen = useAttention(features, { api, signals });
  return null;
}
async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}
async function show(features: Record<string, boolean> = {}) {
  await act(async () => render(h(Probe, features), host));
  await settle();
}
function resetCalls() {
  for (const fn of Object.values(api)) fn.mockClear();
}
const reads = () =>
  Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, fn.mock.calls.length]));

describe("what is read, by feature", () => {
  test("with no linked account and every optional feature off, only agent access and held answers are read", async () => {
    // A gateway that never linked an account offers no sign-in pairing.
    api.cloudPairingConfig.mockResolvedValue(null);
    await show();
    expect(api.cloudPairingConfig).toHaveBeenCalledTimes(1);
    expect(api.cloudPairingRequests).not.toHaveBeenCalled();
    expect(api.tailscaleJoinRequests).not.toHaveBeenCalled();
    expect(api.listSubscriptionApprovals).not.toHaveBeenCalled();
    expect(api.getPendingAccessRequests).toHaveBeenCalledTimes(1);
    expect(api.listPrivacyApprovals).toHaveBeenCalledExactlyOnceWith({ status: "pending", limit: ATTENTION_PAGE_LIMIT });
    // Not even a signal or the fallback reads a feature that is off.
    signals.emit(null);
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS); });
    await settle();
    expect(api.cloudPairingRequests).not.toHaveBeenCalled();
    expect(api.tailscaleJoinRequests).not.toHaveBeenCalled();
    expect(api.listSubscriptionApprovals).not.toHaveBeenCalled();
  });

  test("sign-in requests are read only once the gateway says sign-in pairing is configured", async () => {
    api.cloudPairingConfig.mockResolvedValue(null);
    await show();
    expect(api.cloudPairingConfig).toHaveBeenCalledTimes(1);
    expect(api.cloudPairingRequests).not.toHaveBeenCalled();
    render(null, host);
    api.cloudPairingConfig.mockRejectedValue(new Error("unavailable"));
    await show();
    expect(api.cloudPairingRequests).not.toHaveBeenCalled();
  });

  test("the configuration answer arriving after the shell is gone reads nothing", async () => {
    let deliver!: (value: unknown) => void;
    api.cloudPairingConfig.mockReturnValue(new Promise((resolve) => { deliver = resolve; }));
    await show();
    render(null, host);
    deliver({ clientId: "fictional-client" });
    await settle();
    expect(api.cloudPairingRequests).not.toHaveBeenCalled();
  });

  test("both kinds of device count together; answered and lapsed requests do not", async () => {
    api.cloudPairingRequests.mockResolvedValue({
      items: [cloudRequest("a"), cloudRequest("b", 600_000, "approving"), cloudRequest("c", 600_000, "approved"), cloudRequest("d", -1)],
    });
    api.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1"), join("t2", -1)] });
    await show({ tailscaleEmbed: true });
    expect(seen.devices.count).toBe(3);
    expect((seen.devices.cloud as Array<{ requestId: string }>).map((r) => r.requestId)).toEqual(["a", "b"]);
    expect((seen.devices.tailscale as Array<{ id: string }>).map((r) => r.id)).toEqual(["t1"]);
  });

  test("watch requests are read only where watches are on, and counted by the gateway's total", async () => {
    api.listSubscriptionApprovals.mockResolvedValue({ ...approvals(2), totalCount: 7 });
    await show({ watches: true });
    expect(api.listSubscriptionApprovals).toHaveBeenCalledExactlyOnceWith({ status: "pending", limit: ATTENTION_PAGE_LIMIT });
    expect(seen.watches.count).toBe(7);
    // Turned off: forgotten, and no longer read.
    await show({ watches: false });
    expect(seen.watches.count).toBe(0);
    resetCalls();
    signals.emit("watches");
    await settle();
    expect(api.listSubscriptionApprovals).not.toHaveBeenCalled();
  });

  test("agents waiting come from the overview's pending requests, lapsed ones left out", async () => {
    api.getPendingAccessRequests.mockResolvedValue({ pendingRequests: [accessRequest("r1"), accessRequest("r2", -5)] });
    await show();
    expect(seen.access.count).toBe(1);
    expect((seen.access.requests as Array<{ id: string }>).map((r) => r.id)).toEqual(["r1"]);
  });

  test("a device kind switched on later is read at once", async () => {
    await show({ tailscaleEmbed: false });
    expect(api.tailscaleJoinRequests).not.toHaveBeenCalled();
    api.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    await show({ tailscaleEmbed: true });
    expect(seen.devices.count).toBe(1);
    await show({ tailscaleEmbed: false });
    expect(seen.devices.count).toBe(0);
  });
});

describe("when a topic is read again", () => {
  test("its own signal re-reads that topic only", async () => {
    await show({ tailscaleEmbed: true, watches: true });
    resetCalls();
    api.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    signals.emit("devices");
    await settle();
    expect(reads()).toMatchObject({ tailscaleJoinRequests: 1, getPendingAccessRequests: 0, listPrivacyApprovals: 0, listSubscriptionApprovals: 0 });
    expect(seen.devices.count).toBe(1);

    for (const [topic, route] of [
      ["access", "getPendingAccessRequests"],
      ["answers", "listPrivacyApprovals"],
      ["watches", "listSubscriptionApprovals"],
    ]) {
      resetCalls();
      signals.emit(topic);
      await settle();
      expect(api[route]).toHaveBeenCalledTimes(1);
      expect(Object.values(reads()).reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  test("ready re-reads every topic that is on", async () => {
    await show({ tailscaleEmbed: true, watches: true });
    resetCalls();
    api.listPrivacyApprovals.mockResolvedValue(approvals(3));
    signals.emit(null);
    await settle();
    expect(reads()).toMatchObject({ tailscaleJoinRequests: 1, getPendingAccessRequests: 1, listPrivacyApprovals: 1, listSubscriptionApprovals: 1 });
    expect(seen.answers.count).toBe(3);
  });

  test("the tab coming back into view re-reads every topic", async () => {
    await show({ tailscaleEmbed: true });
    resetCalls();
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await settle();
    expect(reads()).toMatchObject({ tailscaleJoinRequests: 1, getPendingAccessRequests: 1, listPrivacyApprovals: 1 });
  });

  test("the slow fallback re-reads every topic, in case the stream is down", async () => {
    await show({ tailscaleEmbed: true });
    resetCalls();
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS - 1); });
    expect(api.getPendingAccessRequests).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    await settle();
    expect(reads()).toMatchObject({ tailscaleJoinRequests: 1, getPendingAccessRequests: 1, listPrivacyApprovals: 1 });
  });

  test("a topic is re-read just after its earliest item expires, which the gateway does not signal", async () => {
    api.getPendingAccessRequests.mockResolvedValue({ pendingRequests: [accessRequest("late", 40_000), accessRequest("soon", 10_000)] });
    await show();
    expect(seen.access.count).toBe(2);
    expect(seen.access.nextExpiry).toBe(NOW + 10_000);
    resetCalls();
    api.getPendingAccessRequests.mockResolvedValue({ pendingRequests: [accessRequest("late", 30_000)] });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(api.getPendingAccessRequests).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(500); });
    await settle();
    expect(api.getPendingAccessRequests).toHaveBeenCalledTimes(1);
    expect(api.listPrivacyApprovals).not.toHaveBeenCalled();
    expect(seen.access.count).toBe(1);
  });

  test("held answers expire on the earliest of the listed items", async () => {
    api.listPrivacyApprovals.mockResolvedValue(approvals(3, 20_000));
    await show();
    expect(seen.answers).toEqual({ count: 3, nextExpiry: NOW + 20_000 });
  });

  test("a device kind that fails keeps its last answer while the other updates", async () => {
    api.cloudPairingRequests.mockResolvedValue({ items: [cloudRequest("a")] });
    api.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    await show({ tailscaleEmbed: true });
    expect(seen.devices.count).toBe(2);
    api.cloudPairingRequests.mockRejectedValue(new Error("offline"));
    api.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
    signals.emit("devices");
    await settle();
    expect(seen.devices.count).toBe(1);
    expect(seen.devices.cloud).toHaveLength(1);
  });

  test("a failed read keeps the last answer, so a mark never flickers away", async () => {
    api.listPrivacyApprovals.mockResolvedValue(approvals(2));
    await show();
    api.listPrivacyApprovals.mockRejectedValue({ status: 503 });
    signals.emit("answers");
    await settle();
    expect(seen.answers.count).toBe(2);
  });

  test("a read overtaken by a newer one is dropped", async () => {
    await show();
    let slow!: (value: unknown) => void;
    api.listPrivacyApprovals
      .mockReturnValueOnce(new Promise((resolve) => { slow = resolve; }))
      .mockResolvedValueOnce(approvals(1));
    signals.emit("answers");
    signals.emit("answers");
    await settle();
    expect(seen.answers.count).toBe(1);
    slow(approvals(9));
    await settle();
    expect(seen.answers.count).toBe(1);
  });
});

describe("load", () => {
  test("while the signals are healthy no topic is read on an interval; while down, every fallback interval", async () => {
    await show({ tailscaleEmbed: true });
    await act(async () => { signals.setHealthy(true); });
    resetCalls();
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS * 4); });
    await settle();
    expect(Object.values(reads()).reduce((a, b) => a + b, 0)).toBe(0);
    await act(async () => { signals.setHealthy(false); });
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS); });
    await settle();
    expect(reads()).toMatchObject({ tailscaleJoinRequests: 1, getPendingAccessRequests: 1, listPrivacyApprovals: 1 });
  });

  test("a hidden tab defers signalled reads to one read when it comes back into view", async () => {
    await show({ tailscaleEmbed: true });
    await act(async () => { signals.setHealthy(true); });
    resetCalls();
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new window.Event("visibilitychange"));
    };
    await act(async () => { setHidden(true); });
    signals.emit("answers");
    signals.emit("answers");
    signals.emit("devices");
    await settle();
    expect(Object.values(reads()).reduce((a, b) => a + b, 0)).toBe(0);
    await act(async () => { setHidden(false); });
    await settle();
    expect(reads()).toMatchObject({ listPrivacyApprovals: 1, tailscaleJoinRequests: 1, getPendingAccessRequests: 0 });
    // Healthy and nothing missed: coming into view again reads nothing.
    resetCalls();
    await act(async () => { setHidden(true); });
    await act(async () => { setHidden(false); });
    await settle();
    expect(Object.values(reads()).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("sign-in pairing configuration", () => {
  test("a failed configuration read is retried on the fallback interval until it answers", async () => {
    api.cloudPairingConfig.mockRejectedValueOnce(new Error("offline"));
    api.cloudPairingRequests.mockResolvedValue({ items: [cloudRequest("a")] });
    await show();
    expect(api.cloudPairingRequests).not.toHaveBeenCalled();
    // Even with healthy signals: the configuration is not something they cover.
    await act(async () => { signals.setHealthy(true); });
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS); });
    await settle();
    expect(api.cloudPairingConfig).toHaveBeenCalledTimes(2);
    expect(seen.devices.count).toBe(1);
    // Configured: asked no more.
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS * 2); });
    signals.emit("devices");
    await settle();
    expect(api.cloudPairingConfig).toHaveBeenCalledTimes(2);
  });

  test("a gateway that said sign-in pairing is off is asked again on a devices signal or a resync", async () => {
    api.cloudPairingConfig.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    api.cloudPairingRequests.mockResolvedValue({ items: [cloudRequest("a")] });
    await show();
    await act(async () => { signals.setHealthy(true); });
    await act(async () => { vi.advanceTimersByTime(SIGNAL_FALLBACK_MS * 2); });
    expect(api.cloudPairingConfig).toHaveBeenCalledTimes(1);
    signals.emit(null);
    await settle();
    expect(api.cloudPairingConfig).toHaveBeenCalledTimes(2);
    signals.emit("devices");
    await settle();
    expect(api.cloudPairingConfig).toHaveBeenCalledTimes(3);
    expect(seen.devices.count).toBe(1);
  });
});

describe("expiry helpers", () => {
  test("the earliest expiry ignores what has already passed, and reads ms and ISO alike", () => {
    expect(earliestExpiry([], NOW)).toBeNull();
    expect(earliestExpiry(undefined, NOW)).toBeNull();
    expect(
      earliestExpiry(
        [{ expiresAt: NOW - 1 }, { expiresAt: new Date(NOW + 5_000).toISOString() }, { expiresAt: NOW + 9_000 }, { expiresAt: "nonsense" }, {}],
        NOW,
      ),
    ).toBe(NOW + 5_000);
    expect(notExpired({ expiresAt: NOW + 1 }, NOW)).toBe(true);
    expect(notExpired({ expiresAt: new Date(NOW).toISOString() }, NOW)).toBe(false);
  });
});
