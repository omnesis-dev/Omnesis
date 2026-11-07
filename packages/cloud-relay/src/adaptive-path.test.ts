// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayTlsIdentityRefused } from "./pinned-key.js";
import { GatewayRequestRefused } from "./google-device-pairing.js";
import { AdaptiveGatewayPath } from "./adaptive-path.js";
const hint = { address: "192.168.1.20", port: 8443 };
const network = () => Object.assign(new Error("unreachable"), { code: "ECONNREFUSED" });
const owned: AdaptiveGatewayPath[] = [];
function manager(
  probe = vi.fn().mockResolvedValue([hint]),
  refresh?: (saved: (typeof hint)[], signal: AbortSignal) => Promise<(typeof hint)[]>,
  reverify?: (signal: AbortSignal) => Promise<void>,
) {
  const value = new AdaptiveGatewayPath({ candidates: [hint], probe, refresh, reverify });
  owned.push(value);
  return value;
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("authenticated LAN success updates bounded hints and notifies observers, without exposing mutable candidates", async () => {
  const value = manager();
  const listener = vi.fn();
  const remove = value.onTransition(listener);
  await value.check();
  expect(listener).toHaveBeenCalledWith("local");
  const saved = value.candidates();
  saved[0]!.address = "10.0.0.99";
  expect(value.candidates()).toEqual([hint]);
  remove();
  await value.check();
  expect(listener).toHaveBeenCalledOnce();
  value.assertUsable();
  expect(
    () =>
      new AdaptiveGatewayPath({ candidates: [{ address: "127.0.0.1", port: 80 }], probe: vi.fn() }),
  ).toThrow();
});
test("remote refresh authenticates new hints and a reachable second candidate can replace an unavailable first one", async () => {
  const other = { address: "10.0.0.20", port: 8443 };
  const refresh = vi.fn().mockResolvedValue([hint, other]);
  const probe = vi.fn().mockRejectedValueOnce(network()).mockResolvedValue([other]);
  const value = manager(probe, refresh);
  const listener = vi.fn();
  value.onTransition(listener);
  await value.check();
  expect(refresh).toHaveBeenCalledWith([hint], expect.any(AbortSignal));
  expect(probe).toHaveBeenCalledTimes(2);
  expect(value.candidates()).toEqual([other]);
  expect(listener).toHaveBeenCalledWith("local");
});
test("a lost local route triggers reconnect once, while initially remote or empty candidates do not churn sockets", async () => {
  const probe = vi.fn().mockResolvedValueOnce([hint]).mockRejectedValue(network());
  const value = manager(probe);
  const listener = vi.fn();
  value.onTransition(listener);
  await value.check();
  await value.check();
  await value.check();
  expect(listener.mock.calls).toEqual([["local"], ["lost"]]);
  const empty = new AdaptiveGatewayPath({ candidates: [], probe: vi.fn() });
  owned.push(empty);
  await empty.check();
});
test("identity, authorization and malformed authenticated discovery failures fail closed without fallback", async () => {
  for (const error of [
    new Error("wrong TLS key"),
    Object.assign(new Error("revoked"), { status: 401 }),
  ]) {
    const value = manager(vi.fn().mockRejectedValue(error));
    const listener = vi.fn();
    value.onTransition(listener);
    await value.check();
    expect(listener).toHaveBeenCalledExactlyOnceWith("blocked");
    expect(() => value.assertUsable()).toThrow("Repair pairing");
    await value.check();
    expect(listener).toHaveBeenCalledOnce();
  }
  const malformed = manager(vi.fn().mockResolvedValue([{ address: "8.8.8.8", port: 443 }]));
  const listener = vi.fn();
  malformed.onTransition(listener);
  await malformed.check();
  expect(listener).toHaveBeenCalledWith("blocked");
});
test("periodic checks are single-flight, unref their timer, and cancellation prevents stale success or blocked state", async () => {
  let resolve!: (x: (typeof hint)[]) => void;
  const probe = vi.fn().mockImplementation(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const value = manager(probe);
  const listener = vi.fn();
  value.onTransition(listener);
  value.start();
  value.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(probe).toHaveBeenCalledOnce();
  await value.check();
  expect(probe).toHaveBeenCalledOnce();
  value.close();
  resolve([hint]);
  await Promise.resolve();
  await Promise.resolve();
  expect(listener).not.toHaveBeenCalled();
  value.start();
  await value.check();
  expect(probe).toHaveBeenCalledOnce();
});
test("per-candidate owned deadlines continue only as connectivity failures", async () => {
  for (const coded of [false, true]) {
    const probe = vi
      .fn()
      .mockImplementationOnce(
        (_hint, signal: AbortSignal) =>
          new Promise((_yes, no) =>
            signal.addEventListener(
              "abort",
              () =>
                no(
                  coded
                    ? Object.assign(new Error("aborted"), { code: "ABORT_ERR" })
                    : signal.reason,
                ),
              { once: true },
            ),
          ),
      )
      .mockResolvedValue([]);
    const value = new AdaptiveGatewayPath({
      candidates: [hint, { address: "10.0.0.20", port: 8443 }],
      probe,
    });
    owned.push(value);
    const listener = vi.fn();
    value.onTransition(listener);
    const work = value.check();
    await vi.advanceTimersByTimeAsync(750);
    await work;
    expect(listener).toHaveBeenCalledWith("local");
  }
});
test("refresh connectivity and total-deadline failures retain usable saved hints without hiding invalid metadata", async () => {
  const networkRefresh = manager(vi.fn(), vi.fn().mockRejectedValue(network()));
  await networkRefresh.check();
  expect(networkRefresh.candidates()).toEqual([hint]);
  networkRefresh.assertUsable();
  const timeout = manager(
    vi.fn(),
    (_saved, signal) =>
      new Promise((_yes, no) =>
        signal.addEventListener("abort", () => no(signal.reason), { once: true }),
      ),
  );
  const work = timeout.check();
  await vi.advanceTimersByTimeAsync(5000);
  await work;
  timeout.assertUsable();
  const invalid = manager(vi.fn(), vi.fn().mockResolvedValue([{ address: "invalid", port: 0 }]));
  await invalid.check();
  expect(() => invalid.assertUsable()).toThrow("Repair pairing");
});
test("a refresh completing after shutdown cannot mutate candidates or migrate a socket", async () => {
  let resolve!: (x: (typeof hint)[]) => void;
  const value = manager(
    vi.fn(),
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const listener = vi.fn();
  value.onTransition(listener);
  const work = value.check();
  value.close();
  resolve([]);
  await work;
  expect(value.candidates()).toEqual([hint]);
  expect(listener).not.toHaveBeenCalled();
});

test("a bounded refresh failure also releases an old local WebSocket for reconnection", async () => {
  const refresh = vi.fn().mockResolvedValueOnce([hint]).mockRejectedValue(network());
  const value = manager(vi.fn().mockResolvedValue([hint]), refresh);
  const listener = vi.fn();
  value.onTransition(listener);
  await value.check();
  await value.check();
  expect(listener.mock.calls).toEqual([["local"], ["lost"]]);
  value.assertUsable();
});

test("only opted-in TLS blocks retry strict canonical verification, without unblocking during outages", async () => {
  const probe = vi
    .fn()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("expired"))
    .mockResolvedValue([hint]);
  const reverify = vi
    .fn()
    .mockRejectedValueOnce(network())
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("still refused"))
    .mockResolvedValue(undefined);
  const value = manager(probe, undefined, reverify);
  const listener = vi.fn();
  value.onTransition(listener);
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
  const legacy = manager(vi.fn().mockRejectedValue(new GatewayTlsIdentityRefused("expired")));
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
      vi.fn().mockRejectedValue(new GatewayTlsIdentityRefused("expired")),
      undefined,
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
  for (const shutdown of [false, true]) {
    const reverify = vi
      .fn()
      .mockImplementation(
        (signal: AbortSignal) =>
          new Promise<void>((_yes, no) =>
            signal.addEventListener("abort", () => no(signal.reason), { once: true }),
          ),
      );
    const value = manager(
      vi.fn().mockRejectedValue(new GatewayTlsIdentityRefused("expired")),
      undefined,
      reverify,
    );
    await value.check();
    const pending = value.check();
    if (shutdown) value.close();
    else await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(() => value.assertUsable()).toThrow("Strict verification");
  }
});

test("a verified canonical device does not unblock traffic before refreshed metadata has also passed validation", async () => {
  let release!: (value: unknown) => void;
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("expired"))
    .mockImplementationOnce(() => new Promise((yes) => (release = yes)));
  const reverify = vi.fn().mockResolvedValue(undefined);
  const value = manager(vi.fn(), refresh, reverify);
  await value.check();
  const pending = value.check();
  await Promise.resolve();
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
  const probe = vi
    .fn()
    .mockRejectedValueOnce(new GatewayTlsIdentityRefused("expired"))
    .mockResolvedValue([hint]);
  const value = manager(probe, undefined, reverify);
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
