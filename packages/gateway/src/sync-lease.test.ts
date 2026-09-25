// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { DeviceId } from "@omnesis/types";
import { SyncLeaseRegistry } from "./sync-lease.js";

const A = DeviceId("11111111-1111-4111-8111-111111111111");
const B = DeviceId("22222222-2222-4222-8222-222222222222");
const SOURCE = "gmail:maya.reeves@example.com";

function registry(opts: { ttlMs?: number; online?: Set<string> } = {}) {
  let now = 1_000_000;
  const online = opts.online ?? new Set<string>([A, B]);
  const lease = new SyncLeaseRegistry({
    ttlMs: () => opts.ttlMs ?? 60_000,
    isOnline: (id) => online.has(id),
    now: () => now,
  });
  return { lease, online, tick: (ms: number) => (now += ms) };
}

describe("SyncLeaseRegistry", () => {
  test("a free lease is granted; a live lease is refused to others and renewed for its holder", () => {
    const { lease } = registry();
    expect(lease.claim(SOURCE, A)).toMatchObject({ granted: true, holder: A });
    expect(lease.claim(SOURCE, B)).toMatchObject({ granted: false, reason: "held", holder: A });
    expect(lease.claim(SOURCE, A)).toMatchObject({ granted: true, holder: A });
    expect(lease.holderOf(SOURCE)).toMatchObject({ deviceId: A, expired: false });
  });

  test("renewal extends the holder's lease only", () => {
    const { lease, tick } = registry({ ttlMs: 1_000 });
    const first = lease.claim(SOURCE, A);
    tick(600);
    expect(lease.renew(SOURCE, B)).toBe(false);
    expect(lease.renew(SOURCE, A)).toBe(true);
    expect(lease.holderOf(SOURCE)!.expiresAt).toBeGreaterThan(first.granted ? first.expiresAt : 0);
    tick(600);
    expect(lease.holderOf(SOURCE)).toMatchObject({ deviceId: A, expired: false });
  });

  test("a lapsed lease prefers its online incumbent for one more window, then anyone", () => {
    const { lease, tick } = registry({ ttlMs: 1_000 });
    lease.claim(SOURCE, A);
    tick(1_500);
    expect(lease.holderOf(SOURCE)).toMatchObject({ deviceId: A, expired: true });
    expect(lease.claim(SOURCE, B)).toMatchObject({
      granted: false,
      reason: "incumbent",
      holder: A,
    });
    // The incumbent's own claim takes it back.
    expect(lease.claim(SOURCE, A)).toMatchObject({ granted: true, holder: A });
    tick(2_500);
    expect(lease.claim(SOURCE, B)).toMatchObject({ granted: true, holder: B });
  });

  test("an offline incumbent is not preferred", () => {
    const { lease, tick, online } = registry({ ttlMs: 1_000 });
    lease.claim(SOURCE, A);
    online.delete(A);
    tick(1_500);
    expect(lease.claim(SOURCE, B)).toMatchObject({ granted: true, holder: B });
  });

  test("a released lease carries no preference; only the holder releases", () => {
    const { lease } = registry();
    lease.claim(SOURCE, A);
    expect(lease.release(SOURCE, B)).toBe(false);
    expect(lease.release(SOURCE, A)).toBe(true);
    expect(lease.holderOf(SOURCE)).toBeNull();
    expect(lease.claim(SOURCE, B)).toMatchObject({ granted: true, holder: B });
  });

  test("releaseAll drops every lease of one device; forgetSource drops one source", () => {
    const { lease } = registry();
    lease.claim(SOURCE, A);
    lease.claim("things:local", A);
    lease.claim("apple-notes:local", B);
    lease.releaseAll(A);
    expect(lease.holderOf(SOURCE)).toBeNull();
    expect(lease.holderOf("things:local")).toBeNull();
    expect(lease.holderOf("apple-notes:local")?.deviceId).toBe(B);
    lease.forgetSource("apple-notes:local");
    expect(lease.holderOf("apple-notes:local")).toBeNull();
  });
});
