// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getTailscale: vi.fn() }));
vi.mock("./tailscale-api.js", () => api);

// @ts-expect-error — portal modules are plain JS.
import { tailscalePollInterval, tailscaleTransitioning, useTailscaleAdmin } from "./use-tailscale-admin.js";

type State = Record<string, any>;
const base = (over: State = {}): State => ({
  enabled: true,
  helper: { state: "running" },
  connection: "connected",
  certificate: { source: "tailscale" },
  public: { wanted: false, state: "off" },
  joinRequests: [],
  ...over,
});

describe("tailscaleTransitioning", () => {
  test("follows only what may change within seconds", () => {
    const fast: State[] = [
      base({ helper: { state: "starting" }, connection: "starting" }),
      base({ helper: { state: "restarting" } }),
      base({ connection: "needs-sign-in" }),
      base({ certificate: { source: "gateway", reason: "pending" } }),
      base({ public: { wanted: true, state: "starting" } }),
      base({ public: { wanted: true, state: "needs-enable" } }),
      base({ public: { wanted: true, state: "off" } }),
    ];
    const slow: (State | null)[] = [
      null,
      base({ enabled: false, connection: "off", helper: { state: "off" } }),
      base(),
      base({ connection: "needs-approval" }),
      base({ connection: "stopped" }),
      base({ helper: { state: "unavailable", reason: "missing" }, connection: "starting" }),
      base({ certificate: { source: "gateway", reason: "https-disabled" } }),
      base({ public: { wanted: true, state: "on" } }),
      base({ public: { wanted: true, state: "unavailable", reason: "https-disabled" } }),
      base({ public: { wanted: false, state: "starting" } }),
      base({ connection: "needs-sign-in", public: { wanted: true, state: "off" }, enabled: false }),
    ];
    for (const state of fast) {
      expect(tailscaleTransitioning(state)).toBe(true);
      expect(tailscalePollInterval(state)).toBe(2000);
    }
    for (const state of slow) {
      expect(tailscaleTransitioning(state)).toBe(false);
      expect(tailscalePollInterval(state)).toBe(10_000);
    }
  });
});

describe("useTailscaleAdmin polling", () => {
  let host: HTMLElement;
  let doc: Document;
  let hidden = false;

  let admin: ReturnType<typeof useTailscaleAdmin>;
  function Probe() {
    admin = useTailscaleAdmin();
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const dom = parseHTML("<html><body><main></main></body></html>");
    vi.stubGlobal("document", dom.document);
    vi.stubGlobal("window", dom.window);
    doc = dom.document as unknown as Document;
    hidden = false;
    Object.defineProperty(doc, "hidden", { configurable: true, get: () => hidden });
    host = dom.document.querySelector("main") as unknown as HTMLElement;
  });
  afterEach(() => {
    render(null, host);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount(state: State) {
    api.getTailscale.mockResolvedValue(state);
    await act(async () => render(h(Probe, {}), host));
    await act(async () => {});
    expect(api.getTailscale).toHaveBeenCalledTimes(1);
  }
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  test("polls every 2 s during a transition and every 10 s once settled", async () => {
    await mount(base({ connection: "needs-sign-in" }));
    await advance(2000);
    expect(api.getTailscale).toHaveBeenCalledTimes(2);
    api.getTailscale.mockResolvedValue(base());
    await advance(2000);
    expect(api.getTailscale).toHaveBeenCalledTimes(3);
    await advance(9000);
    expect(api.getTailscale).toHaveBeenCalledTimes(3);
    await advance(1000);
    expect(api.getTailscale).toHaveBeenCalledTimes(4);
  });

  test("stops while the tab is hidden and reads at once when it returns", async () => {
    await mount(base({ connection: "needs-sign-in" }));
    hidden = true;
    await act(async () => {
      doc.dispatchEvent(new (window as any).Event("visibilitychange"));
    });
    await advance(20_000);
    expect(api.getTailscale).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => {
      doc.dispatchEvent(new (window as any).Event("visibilitychange"));
    });
    await act(async () => {});
    expect(api.getTailscale).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(api.getTailscale).toHaveBeenCalledTimes(3);
  });

  test("unmounting aborts the read in flight and stops polling", async () => {
    await mount(base({ connection: "needs-sign-in" }));
    let signal: AbortSignal | undefined;
    api.getTailscale.mockImplementation((s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    await advance(2000);
    expect(signal?.aborted).toBe(false);
    await act(async () => render(null, host));
    expect(signal?.aborted).toBe(true);
    await advance(20_000);
    expect(api.getTailscale).toHaveBeenCalledTimes(2);
  });

  test("a change that may ask for the passkey waits for the person; others time out at 10 s", async () => {
    await mount(base());
    const pending = () => {
      let signal: AbortSignal | undefined;
      const call = (s: AbortSignal) => {
        signal = s;
        return new Promise((_, reject) => s.addEventListener("abort", () => reject(new Error("aborted"))));
      };
      return { call, aborted: () => signal?.aborted };
    };
    // The gateway asks for a step-up before turning the device on and before signing it in
    // (whoever finishes the sign-in picks the tailnet): routes/tailscale.ts.
    for (const operation of ["enable", "sign-in"]) {
      const change = pending();
      let done: Promise<unknown>;
      await act(async () => { done = admin.run(operation, change.call); });
      await advance(60_000);
      expect(change.aborted(), operation).toBe(false);
      await advance(70_000);
      expect(change.aborted(), operation).toBe(true);
      await act(async () => { await done; });
    }
    // Joining policies are set together on Connectivity's own route, not here.
    for (const operation of ["device-name", "sign-out", "disable"]) {
      const quick = pending();
      let done: Promise<unknown>;
      await act(async () => { done = admin.run(operation, quick.call); });
      await advance(9_999);
      expect(quick.aborted(), operation).toBe(false);
      await advance(1);
      expect(quick.aborted(), operation).toBe(true);
      await act(async () => { await done; });
    }
  });

  test("a state another route answered with replaces the state, and a read that started before it can't undo it", async () => {
    await mount(base({ joinPolicy: "ask" }));
    let answer!: (value: State) => void;
    api.getTailscale.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    let read: Promise<unknown>;
    await act(async () => { read = admin.refresh(); });
    await act(async () => admin.adopt(base({ joinPolicy: "automatic" })));
    expect(admin.state.joinPolicy).toBe("automatic");
    await act(async () => { answer(base({ joinPolicy: "ask" })); await read; });
    expect(admin.state.joinPolicy).toBe("automatic");
    api.getTailscale.mockResolvedValue(base({ joinPolicy: "off" }));
    await act(async () => { await admin.refresh(); });
    expect(admin.state.joinPolicy).toBe("off");
  });
});
