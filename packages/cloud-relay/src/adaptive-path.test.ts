// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LogLevel, setLogLevel } from "@omnesis/core";
import { GatewayTlsIdentityRefused } from "./pinned-key.js";
import { GatewayRequestRefused } from "./google-device-pairing.js";
import { AdaptiveGatewayPath } from "./adaptive-path.js";
type Hint = { address: string; port: number };
type Options = ConstructorParameters<typeof AdaptiveGatewayPath>[0];
const hint = { address: "192.168.1.20", port: 8443 };
const other = { address: "10.0.0.20", port: 8443 };
const coded = (code: string) => Object.assign(new Error(code), { code });
const network = () => coded("ECONNREFUSED");
/** A home address that drops every packet: nothing comes back until the probe's own deadline. */
const silent = (_hint: Hint, signal: AbortSignal) =>
  new Promise<never>((_yes, no) =>
    signal.addEventListener("abort", () => no(signal.reason), { once: true }),
  );
const owned: AdaptiveGatewayPath[] = [];
function manager(
  probe: Options["probe"] = vi.fn().mockResolvedValue(undefined),
  refresh?: Options["refresh"],
  reverify?: Options["reverify"],
  extra: Partial<Options> = {},
) {
  const value = new AdaptiveGatewayPath({ candidates: [hint], probe, refresh, reverify, ...extra });
  owned.push(value);
  return value;
}
function watched(...args: Parameters<typeof manager>) {
  const value = manager(...args);
  const listener = vi.fn();
  value.onTransition(listener);
  return { value, listener };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Owned timeout")), ms);
    return controller.signal;
  });
});
afterEach(() => {
  for (const value of owned.splice(0)) value.close();
  setLogLevel(LogLevel.WARN);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("an authenticated home address marks the route local and notifies observers, without exposing mutable candidates", async () => {
  const { value, listener } = watched();
  const remove = value.onTransition(listener);
  expect(value.isLocal()).toBe(false);
  await value.check();
  expect(value.isLocal()).toBe(true);
  expect(listener).toHaveBeenCalledWith("local");
  const saved = value.candidates();
  saved[0]!.address = "10.0.0.99";
  expect(value.candidates()).toEqual([hint]);
  // Each success is announced, so a socket that fell back during a brief miss is moved home.
  await value.check();
  expect(listener).toHaveBeenCalledTimes(2);
  remove();
  await value.check();
  expect(listener).toHaveBeenCalledTimes(2);
  value.assertUsable();
  expect(
    () =>
      new AdaptiveGatewayPath({ candidates: [{ address: "127.0.0.1", port: 80 }], probe: vi.fn() }),
  ).toThrow();
});

test("home addresses are asked at once, the first to authenticate wins, and it is tried first afterwards", async () => {
  const probe = vi.fn((candidate: Hint, signal: AbortSignal) =>
    candidate.address === hint.address ? silent(candidate, signal) : Promise.resolve(),
  );
  const value = new AdaptiveGatewayPath({ candidates: [hint, other], probe });
  owned.push(value);
  // The silent first address does not hold the answer back for its whole deadline.
  await value.check();
  expect(value.isLocal()).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe.mock.calls[0]![1].aborted).toBe(true);
  expect(value.candidates()).toEqual([other, hint]);
});

test("away from home, refreshed addresses come over the canonical route, are saved, and are tried in the same check", async () => {
  const fresh = [other, hint];
  const refresh = vi.fn<NonNullable<Options["refresh"]>>().mockResolvedValue(fresh);
  const persist = vi.fn<NonNullable<Options["persist"]>>().mockResolvedValue(undefined);
  const probe = vi.fn((candidate: Hint) =>
    candidate.address === other.address ? Promise.resolve() : Promise.reject(network()),
  );
  const { value, listener } = watched(probe, refresh, undefined, { persist });
  await value.check();
  // Not at home: the saved address is not offered as a way to reach the gateway.
  expect(refresh).toHaveBeenCalledExactlyOnceWith([hint], expect.any(AbortSignal), []);
  expect(persist).toHaveBeenCalledExactlyOnceWith(fresh);
  expect(probe.mock.calls.map((call) => call[0])).toEqual([hint, other]);
  expect(value.candidates()).toEqual(fresh);
  expect(listener.mock.calls).toEqual([["local"]]);
  // At home the address that answered carries the refresh, and unchanged addresses are not rewritten.
  await value.check();
  expect(refresh).toHaveBeenLastCalledWith(fresh, expect.any(AbortSignal), [other]);
  expect(persist).toHaveBeenCalledOnce();
});

test("a failed save of refreshed addresses is reported and changes nothing else", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { value } = watched(vi.fn().mockRejectedValue(network()), async () => [other], undefined, {
    persist: () => Promise.reject(new Error("read-only")),
  });
  await value.check();
  expect(value.candidates()).toEqual([other]);
  expect(warn.mock.calls.join()).toContain("read-only");
  value.assertUsable();
});

test("an address the network refuses ends the home route at once; starting away or without addresses churns nothing", async () => {
  for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]) {
    const probe = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(coded(code));
    const { value, listener } = watched(probe);
    await value.check();
    await value.check();
    expect(value.isLocal()).toBe(false);
    await value.check();
    expect(listener.mock.calls).toEqual([["local"], ["lost"]]);
  }
  const empty = new AdaptiveGatewayPath({ candidates: [], probe: vi.fn() });
  owned.push(empty);
  await empty.check();
  expect(empty.isLocal()).toBe(false);
  // The gateway withdrew every address while this device was at home.
  const withdrawn = watched(vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue([]));
  await withdrawn.value.check();
  await withdrawn.value.check();
  expect(withdrawn.listener.mock.calls).toEqual([["local"], ["lost"]]);
});

test("one slow, reset or overloaded reply keeps the home route; two in a row release it", async () => {
  for (const miss of [
    silent,
    (_hint: Hint, signal: AbortSignal) =>
      new Promise<never>((_yes, no) =>
        signal.addEventListener("abort", () => no(coded("ABORT_ERR")), { once: true }),
      ),
    () => Promise.reject(coded("ECONNRESET")),
    () => Promise.reject(coded("ETIMEDOUT")),
    () => Promise.reject(new GatewayRequestRefused(503)),
    () => Promise.reject(new GatewayRequestRefused(429)),
  ]) {
    let home = true;
    const probe = vi.fn((candidate: Hint, signal: AbortSignal) =>
      home ? Promise.resolve() : miss(candidate, signal),
    );
    const { value, listener } = watched(probe);
    const check = async () => {
      const work = value.check();
      await vi.advanceTimersByTimeAsync(750);
      await work;
    };
    await check();
    home = false;
    await check();
    expect(value.isLocal()).toBe(true);
    // The busy gateway answers the next check: the earlier miss is forgotten.
    home = true;
    await check();
    home = false;
    await check();
    expect(listener.mock.calls).toEqual([["local"], ["local"]]);
    value.assertUsable();
    await check();
    expect(value.isLocal()).toBe(false);
    expect(listener.mock.calls).toEqual([["local"], ["local"], ["lost"]]);
  }
});

test("a running adapter confirms a silent home address three seconds later instead of waiting a whole interval", async () => {
  let home = true;
  const probe = vi.fn((candidate: Hint, signal: AbortSignal) =>
    home ? Promise.resolve() : silent(candidate, signal),
  );
  const { value, listener } = watched(probe);
  value.start();
  value.start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(listener.mock.calls).toEqual([["local"]]);
  home = false;
  await vi.advanceTimersByTimeAsync(15_000 + 750);
  expect(value.isLocal()).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3_000 + 750);
  expect(probe).toHaveBeenCalledTimes(3);
  expect(listener.mock.calls).toEqual([["local"], ["lost"]]);
  // Home again: the next periodic check brings the route back.
  home = true;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(listener.mock.calls).toEqual([["local"], ["lost"], ["local"]]);
  // A confirmation that is pending when the adapter closes never runs.
  home = false;
  await vi.advanceTimersByTimeAsync(15_000 + 750);
  const calls = probe.mock.calls.length;
  value.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(probe).toHaveBeenCalledTimes(calls);
});

test("a home address held by another machine is skipped, said once, and never blocks the relay", async () => {
  const info = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  setLogLevel(LogLevel.INFO);
  const probe = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new GatewayTlsIdentityRefused("Gateway public key pin mismatch"));
  const { value, listener } = watched(probe, async () => [hint], vi.fn());
  await value.check();
  await value.check();
  await value.check();
  // The wrong key is as final as a refusal: one check moves traffic off the home route.
  expect(listener.mock.calls).toEqual([["local"], ["lost"]]);
  value.assertUsable();
  const said = info.mock.calls.filter((call) => String(call[0]).includes("another machine"));
  expect(said).toHaveLength(1);
  expect(String(said[0]![0])).toContain("192.168.1.20:8443");
});

test("authorization and unexpected authenticated failures fail closed without fallback", async () => {
  for (const error of [
    new Error("wrong device or malformed reply"),
    new GatewayRequestRefused(401),
    new GatewayRequestRefused(600),
    new GatewayRequestRefused(undefined),
    Object.assign(new Error("revoked"), { status: 401 }),
  ]) {
    const { value, listener } = watched(vi.fn().mockRejectedValue(error));
    await value.check();
    expect(listener).toHaveBeenCalledExactlyOnceWith("blocked");
    expect(() => value.assertUsable()).toThrow("Repair pairing");
    await value.check();
    expect(listener).toHaveBeenCalledOnce();
  }
  // The gateway itself answering on one address outranks a refusal from another.
  const mixed = new AdaptiveGatewayPath({
    candidates: [hint, other],
    probe: (candidate) =>
      candidate.address === hint.address
        ? Promise.reject(new GatewayRequestRefused(401))
        : new Promise((yes) => setTimeout(yes, 10)),
  });
  owned.push(mixed);
  const work = mixed.check();
  await vi.advanceTimersByTimeAsync(10);
  await work;
  mixed.assertUsable();
  expect(mixed.isLocal()).toBe(true);
});

test("periodic checks are single-flight, unref their timer, and cancellation prevents stale success or blocked state", async () => {
  let resolve!: () => void;
  const probe = vi.fn().mockImplementation(
    () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  );
  const { value, listener } = watched(probe);
  value.start();
  value.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(probe).toHaveBeenCalledOnce();
  await value.check();
  expect(probe).toHaveBeenCalledOnce();
  value.close();
  resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(listener).not.toHaveBeenCalled();
  expect(value.isLocal()).toBe(false);
  value.start();
  await value.check();
  expect(probe).toHaveBeenCalledOnce();
  let fail!: (error: Error) => void;
  const failing = watched(vi.fn().mockImplementation(() => new Promise((_yes, no) => (fail = no))));
  const work = failing.value.check();
  failing.value.close();
  fail(new Error("refused after shutdown"));
  await work;
  failing.value.assertUsable();
});

test("refresh connectivity and deadline failures keep the saved addresses and the route, without hiding invalid metadata", async () => {
  const offline = watched(
    vi.fn().mockResolvedValue(undefined),
    vi.fn().mockRejectedValue(network()),
  );
  await offline.value.check();
  expect(offline.value.candidates()).toEqual([hint]);
  expect(offline.value.isLocal()).toBe(true);
  offline.value.assertUsable();
  for (const reason of [false, true]) {
    const timeout = manager(
      vi.fn().mockRejectedValue(network()),
      (_saved, signal) =>
        new Promise((_yes, no) =>
          signal.addEventListener("abort", () => no(reason ? signal.reason : coded("ABORT_ERR")), {
            once: true,
          }),
        ),
    );
    const work = timeout.check();
    await vi.advanceTimersByTimeAsync(5000);
    await work;
    timeout.assertUsable();
  }
  const invalid = manager(vi.fn(), vi.fn().mockResolvedValue([{ address: "invalid", port: 0 }]));
  await invalid.check();
  expect(() => invalid.assertUsable()).toThrow("Repair pairing");
});

test("a refresh completing or failing after shutdown cannot mutate candidates or migrate a socket", async () => {
  for (const fails of [false, true]) {
    let resolve!: (x: Hint[]) => void, reject!: (error: Error) => void;
    const persist = vi.fn();
    const { value, listener } = watched(
      vi.fn().mockResolvedValue(undefined),
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      undefined,
      { persist },
    );
    const work = value.check();
    await vi.advanceTimersByTimeAsync(0);
    value.close();
    if (fails) reject(new Error("pin mismatch"));
    else resolve([]);
    await work;
    expect(value.candidates()).toEqual([hint]);
    expect(persist).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    value.assertUsable();
  }
});

test("only opted-in canonical TLS blocks retry strict verification, without unblocking during outages", async () => {
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("expired"))
    .mockResolvedValue([hint]);
  const reverify = vi
    .fn()
    .mockRejectedValueOnce(network())
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("still refused"))
    .mockResolvedValue(undefined);
  const probe = vi.fn().mockResolvedValue(undefined);
  const { value, listener } = watched(probe, refresh, reverify);
  await value.check();
  expect(() => value.assertUsable()).toThrow("Strict verification");
  await value.check();
  expect(() => value.assertUsable()).toThrow("Strict verification");
  await value.check();
  expect(() => value.assertUsable()).toThrow("Strict verification");
  expect(listener).toHaveBeenCalledExactlyOnceWith("blocked");
  await value.check();
  value.assertUsable();
  expect(reverify).toHaveBeenCalledTimes(3);
  expect(probe).toHaveBeenCalledTimes(2);
  const legacy = manager(
    vi.fn().mockResolvedValue(undefined),
    vi.fn().mockRejectedValue(new GatewayTlsIdentityRefused("expired")),
  );
  await legacy.check();
  await legacy.check();
  expect(() => legacy.assertUsable()).toThrow("Repair pairing");
});

test("canonical re-verification stays blocked until the entire strict pass succeeds and auth refusal ends retries", async () => {
  for (const error of [
    new GatewayRequestRefused(400),
    new GatewayRequestRefused(401),
    new GatewayRequestRefused(403),
    new GatewayRequestRefused(404),
    new GatewayRequestRefused(499),
    new GatewayRequestRefused(600),
    new GatewayRequestRefused(undefined),
    new Error("wrong device or malformed response"),
  ]) {
    const reverify = vi.fn().mockRejectedValue(error);
    const value = manager(
      vi.fn(),
      vi.fn().mockRejectedValue(new GatewayTlsIdentityRefused("expired")),
      reverify,
    );
    await value.check();
    await value.check();
    await value.check();
    expect(() => value.assertUsable()).toThrow("Repair pairing");
    expect(reverify).toHaveBeenCalledOnce();
  }
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("expired"))
    .mockResolvedValue([]);
  let release!: () => void;
  const reverify = vi.fn().mockImplementation(() => new Promise<void>((yes) => (release = yes)));
  const value = new AdaptiveGatewayPath({ candidates: [], probe: vi.fn(), refresh, reverify });
  owned.push(value);
  await value.check();
  const pending = value.check();
  expect(() => value.assertUsable()).toThrow("Strict verification");
  release();
  await pending;
  value.assertUsable();
  expect(value.candidates()).toEqual([]);
});

test("re-verification deadline and shutdown retain the block and discard late results", async () => {
  for (const mode of ["deadline", "coded", "shutdown"]) {
    const reverify = vi
      .fn()
      .mockImplementation(
        (signal: AbortSignal) =>
          new Promise<void>((_yes, no) =>
            signal.addEventListener(
              "abort",
              () => no(mode === "coded" ? coded("ABORT_ERR") : signal.reason),
              { once: true },
            ),
          ),
      );
    const value = manager(
      vi.fn(),
      vi.fn().mockRejectedValue(new GatewayTlsIdentityRefused("expired")),
      reverify,
    );
    await value.check();
    const pending = value.check();
    if (mode === "shutdown") value.close();
    else await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(() => value.assertUsable()).toThrow("Strict verification");
  }
  // Verification that succeeds only as the adapter shuts down unblocks nothing.
  let release!: () => void;
  const late = manager(
    vi.fn(),
    vi.fn().mockRejectedValue(new GatewayTlsIdentityRefused("expired")),
    () => new Promise<void>((yes) => (release = yes)),
  );
  await late.check();
  const pending = late.check();
  late.close();
  release();
  await pending;
  expect(() => late.assertUsable()).toThrow("Strict verification");
});

test("a verified canonical device does not unblock traffic before refreshed metadata has also passed validation", async () => {
  let release!: (value: Hint[]) => void;
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("expired"))
    .mockImplementationOnce(() => new Promise((yes) => (release = yes)));
  const reverify = vi.fn().mockResolvedValue(undefined);
  const value = manager(vi.fn().mockRejectedValue(network()), refresh, reverify);
  await value.check();
  const pending = value.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(() => value.assertUsable()).toThrow("Strict verification");
  release([{ address: "127.0.0.1", port: 443 }]);
  await pending;
  expect(() => value.assertUsable()).toThrow("Repair pairing");
  await value.check();
  expect(reverify).toHaveBeenCalledOnce();
});

test("canonical throttling and service outages retain a TLS block until exact-device verification succeeds", async () => {
  const reverify = vi.fn().mockResolvedValue(undefined);
  for (const status of [429, 500, 503, 599])
    reverify.mockRejectedValueOnce(new GatewayRequestRefused(status));
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("expired"))
    .mockResolvedValue([hint]);
  const probe = vi.fn().mockResolvedValue(undefined);
  const value = manager(probe, refresh, reverify);
  await value.check();
  for (const _status of [429, 500, 503, 599]) {
    await value.check();
    expect(() => value.assertUsable()).toThrow("Strict verification");
    expect(probe).toHaveBeenCalledOnce();
  }
  await value.check();
  value.assertUsable();
  expect(reverify).toHaveBeenCalledTimes(5);
  expect(probe).toHaveBeenCalledTimes(2);
});
