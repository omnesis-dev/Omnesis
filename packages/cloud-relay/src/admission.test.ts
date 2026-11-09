// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { LoginAdmission, admissionClientKey } from "./admission.js";

const from = (remoteAddress?: string) => ({ socket: { remoteAddress } });
const hold = () => {
  let release!: () => void;
  const work = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  return { work, release: () => release() };
};

afterEach(() => {
  vi.useRealTimers();
});

test("admission snapshots distinguish in-flight work, current-minute attempts and expired windows", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const admission = new LoginAdmission(2, 4);
  expect(admission.snapshot()).toEqual({
    activeLogins: 0,
    loginAttempts: 0,
    maxConcurrentLogins: 2,
    maxLoginsPerMinute: 4,
  });
  const held = hold();
  const work = admission.run(held.work, undefined);
  expect(admission.snapshot()).toMatchObject({ activeLogins: 1, loginAttempts: 1 });
  vi.setSystemTime(1800000060000);
  expect(admission.snapshot()).toMatchObject({ activeLogins: 1, loginAttempts: 0 });
  held.release();
  await work;
  expect(admission.snapshot().activeLogins).toBe(0);
});

test("client keys are the peer's IPv4 address or its IPv6 /64, and absent without a peer", () => {
  expect(admissionClientKey(undefined)).toBeUndefined();
  expect(admissionClientKey({})).toBeUndefined();
  expect(admissionClientKey(from())).toBeUndefined();
  expect(admissionClientKey(from("203.0.113.7"))).toBe("203.0.113.7");
  expect(admissionClientKey(from("::ffff:203.0.113.7"))).toBe("203.0.113.7");
  expect(admissionClientKey(from("::FFFF:203.0.113.7"))).toBe("203.0.113.7");
  expect(admissionClientKey(from("2001:db8:0a:0001:1:2:3:4"))).toBe("2001:db8:a:1::/64");
  expect(admissionClientKey(from("2001:db8:a:1::9"))).toBe("2001:db8:a:1::/64");
  expect(admissionClientKey(from("2001:db8::9"))).toBe("2001:db8:0:0::/64");
  expect(admissionClientKey(from("::1"))).toBe("0:0:0:0::/64");
  expect(admissionClientKey(from("fe80::1%eth0"))).toBe("fe80:0:0:0::/64");
  expect(admissionClientKey(from("::ffff:0:1"))).toBe("0:0:0:0::/64");
  expect(admissionClientKey(from("2001:db8:a:1:2::"))).toBe("2001:db8:a:1::/64");
});

test("one client's attempts and concurrency run out without starving another client", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const admission = new LoginAdmission(8, 60, { maxConcurrent: 2, maxPerMinute: 3 });
  const a = from("198.51.100.1"),
    b = from("198.51.100.2");
  for (let i = 0; i < 3; i++) expect(await admission.run(async () => i, a)).toBe(i);
  await expect(admission.run(async () => "more", a)).rejects.toThrow("capacity");
  // Another address, and an IPv4-mapped spelling of it, still get in.
  expect(await admission.run(async () => "b", b)).toBe("b");
  expect(await admission.run(async () => "b", from("::ffff:198.51.100.2"))).toBe("b");
  // Polling an operation already started is not a new attempt.
  expect(await admission.poll(async () => "poll", a)).toBe("poll");

  const first = hold(),
    second = hold();
  const running = [admission.poll(first.work, b), admission.poll(second.work, b)];
  await expect(admission.poll(async () => "third", b)).rejects.toThrow("capacity");
  await expect(admission.run(async () => "third", b)).rejects.toThrow("capacity");
  expect(await admission.run(async () => "c", from("198.51.100.3"))).toBe("c");
  first.release();
  second.release();
  await Promise.all(running);

  // A new minute forgets the spent client, including one whose work is still running.
  const late = hold();
  const lingering = admission.poll(late.work, from("198.51.100.9"));
  await admission.run(async () => undefined, from("198.51.100.9"));
  vi.setSystemTime(1800000060000);
  for (let i = 0; i < 3; i++) await admission.run(async () => undefined, a);
  await expect(admission.run(async () => undefined, a)).rejects.toThrow("capacity");
  late.release();
  await lingering;
  vi.setSystemTime(1800000120000);
  expect(await admission.run(async () => "fresh", a)).toBe("fresh");
});

test("global limits still bound everyone, and requests with no known peer only meet those", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const admission = new LoginAdmission(1, 2);
  const held = hold();
  const running = admission.poll(held.work, undefined);
  await expect(admission.poll(async () => "busy", from("203.0.113.1"))).rejects.toThrow("capacity");
  held.release();
  await running;
  await admission.run(async () => undefined, from("203.0.113.1"));
  await admission.run(async () => undefined, undefined);
  await expect(admission.run(async () => "late", from("203.0.113.2"))).rejects.toThrow("capacity");
  expect(await admission.poll(async () => "poll", from("203.0.113.2"))).toBe("poll");
});

test("per-client limits default below the global ones and must be positive integers", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const admission = LoginAdmission.fromLimits({ maxConcurrent: 8, maxPerMinute: 6 });
  const a = from("192.0.2.1");
  for (let i = 0; i < 2; i++) await admission.run(async () => undefined, a);
  await expect(admission.run(async () => undefined, a)).rejects.toThrow("capacity");
  expect(LoginAdmission.fromLimits(undefined).snapshot()).toMatchObject({
    maxConcurrentLogins: 8,
    maxLoginsPerMinute: 60,
  });
  const configured = LoginAdmission.fromLimits({
    maxConcurrent: 4,
    maxPerMinute: 10,
    maxConcurrentPerClient: 1,
    maxPerMinutePerClient: 1,
  });
  await configured.run(async () => undefined, a);
  await expect(configured.run(async () => undefined, a)).rejects.toThrow("capacity");
  for (const cap of [0, -1, 1.5, NaN]) {
    expect(() => new LoginAdmission(1, 1, { maxConcurrent: cap })).toThrow("positive");
    expect(() => new LoginAdmission(1, 1, { maxPerMinute: cap })).toThrow("positive");
  }
});
