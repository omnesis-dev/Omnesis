// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { PublicRouteProbe } from "./public-route-probe.js";
const signal = () => new AbortController().signal;
function fixture() {
  let wall = 1000,
    monotonic = 0;
  return {
    probe: new PublicRouteProbe({ wall: () => wall, monotonic: () => monotonic }),
    binding: { identity: "invented-route", expiresAt: 200000 },
    wall: (value: number) => {
      wall = value;
    },
    monotonic: (value: number) => {
      monotonic = value;
    },
  };
}
test("only actual completion stamps bounded evidence, reads never extend it", async () => {
  const f = fixture();
  expect(f.probe.snapshot(f.binding)).toBeUndefined();
  await f.probe.check(f.binding, signal(), async () => true);
  expect(f.probe.snapshot(f.binding)).toEqual({ checkedAt: 1000, validUntil: 91000 });
  f.wall(40000);
  expect(f.probe.snapshot(f.binding)?.validUntil).toBe(91000);
  f.monotonic(90000);
  expect(f.probe.snapshot(f.binding)).toBeUndefined();
});
test.each(["origin", "certificate", "tunnel"])(
  "%s identity changes invalidate old success",
  async (identity) => {
    const f = fixture();
    await f.probe.check(f.binding, signal(), async () => true);
    expect(f.probe.snapshot({ ...f.binding, identity })).toBeUndefined();
  },
);
test("certificate expiry caps evidence and wall rollback cannot refresh it", async () => {
  const f = fixture(),
    binding = { ...f.binding, expiresAt: 2000 };
  await f.probe.check(binding, signal(), async () => true);
  expect(f.probe.snapshot(binding)?.validUntil).toBe(2000);
  f.wall(999);
  expect(f.probe.snapshot(binding)).toBeUndefined();
});
test("short certificate lifetime expires monotonically even while wall time remains inside the old interval", async () => {
  const f = fixture(),
    binding = { ...f.binding, expiresAt: 6000 };
  await f.probe.check(binding, signal(), async () => true);
  f.monotonic(4999);
  f.wall(5999);
  expect(f.probe.snapshot(binding)?.validUntil).toBe(6000);
  // Wall time rolled back, but not before checkedAt, so only elapsed lifetime proves expiry.
  f.monotonic(5000);
  f.wall(2000);
  expect(f.probe.snapshot(binding)).toBeUndefined();
});
test.each(["false", "throw"])(
  "a later %s cannot leave positive route evidence",
  async (outcome) => {
    const f = fixture();
    await f.probe.check(f.binding, signal(), async () => true);
    expect(f.probe.snapshot(f.binding)).toBeDefined();
    const pending = f.probe.check(f.binding, signal(), async () => {
      if (outcome === "throw") throw new Error("Invented route failure");
      return false;
    });
    if (outcome === "throw") await expect(pending).rejects.toThrow("Invented route failure");
    else expect(await pending).toBe(false);
    expect(f.probe.snapshot(f.binding)).toBeUndefined();
  },
);
test("coalesced retries and new generation wait for physical old probe settlement", async () => {
  const f = fixture();
  let release = (value: boolean) => {};
  const old = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.probe.check(f.binding, signal(), old),
    second = f.probe.check(f.binding, signal(), old);
  await vi.waitFor(() => expect(old).toHaveBeenCalledOnce());
  f.probe.invalidate();
  const next = vi.fn(async () => true),
    binding = { ...f.binding, identity: "next-route" };
  const third = f.probe.check(binding, signal(), next);
  await Promise.resolve();
  expect(next).not.toHaveBeenCalled();
  release(true);
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(await third).toBe(true);
  expect(next).toHaveBeenCalledOnce();
  expect(f.probe.snapshot(binding)?.checkedAt).toBe(1000);
});
test("invalidating an in-flight route cannot resurrect timestamps or stale readiness", async () => {
  const f = fixture();
  let release = () => {};
  const pending = f.probe.check(
    f.binding,
    signal(),
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  );
  await Promise.resolve();
  f.probe.invalidate();
  release();
  expect(await pending).toBe(false);
  expect(f.probe.snapshot(f.binding)).toBeUndefined();
});

test("abort clears evidence immediately but join retains a noncooperative physical check", async () => {
  const f = fixture();
  await f.probe.check(f.binding, signal(), async () => true);
  const controller = new AbortController();
  let release = () => {},
    joined = false;
  const pending = f.probe.check(
    f.binding,
    controller.signal,
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  );
  await Promise.resolve();
  controller.abort();
  expect(f.probe.snapshot(f.binding)).toBeUndefined();
  const drained = f.probe.join().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  release();
  expect(await pending).toBe(false);
  await drained;
  expect(joined).toBe(true);
});

test("a superseded queued route never probes or publishes after an older physical check rejects", async () => {
  const f = fixture();
  let rejectOld!: (error: Error) => void;
  const failed = new Error("Invented old route connection failure"),
    oldProbe = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectOld = reject;
        }),
    ),
    old = f.probe.check(f.binding, signal(), oldProbe),
    oldResult = expect(old).rejects.toBe(failed);
  await vi.waitFor(() => expect(oldProbe).toHaveBeenCalledOnce());
  const obsoleteProbe = vi.fn(async () => true),
    obsolete = f.probe.check(
      { ...f.binding, identity: "superseded-route" },
      signal(),
      obsoleteProbe,
    ),
    current = { ...f.binding, identity: "current-route" },
    currentProbe = vi.fn(async () => true),
    newest = f.probe.check(current, signal(), currentProbe);
  await Promise.resolve();
  expect(obsoleteProbe).not.toHaveBeenCalled();
  expect(currentProbe).not.toHaveBeenCalled();
  rejectOld(failed);
  await oldResult;
  expect(await obsolete).toBe(false);
  expect(obsoleteProbe).not.toHaveBeenCalled();
  expect(await newest).toBe(true);
  expect(currentProbe).toHaveBeenCalledOnce();
  expect(f.probe.snapshot(current)).toEqual({ checkedAt: 1000, validUntil: 91000 });
  await f.probe.join();
});
