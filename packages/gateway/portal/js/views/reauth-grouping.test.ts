// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
  groupExpiringSourcesByProvider,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
  groupNeedsAuthSourcesByProvider,
} from "./reauth-grouping.js";

interface MemberStatus {
  deviceId: string;
  state: string;
  providerId?: string;
  consentExpiresAt?: string;
}

function source(opts: {
  id: string;
  type?: string;
  deviceId?: string;
  deviceName?: string;
  state: string;
  providerId?: string;
  consentExpiresAt?: string;
  members?: MemberStatus[];
}) {
  return {
    id: opts.id,
    type: opts.type ?? opts.id.split(":")[0],
    deviceId: opts.deviceId ?? "dev-1",
    deviceName: opts.deviceName,
    syncStatus: {
      state: opts.state,
      providerId: opts.providerId,
      consentExpiresAt: opts.consentExpiresAt,
      members: opts.members,
    },
  };
}

describe("groupNeedsAuthSourcesByProvider", () => {
  test("returns empty list when no source needs auth", () => {
    expect(groupNeedsAuthSourcesByProvider([])).toEqual([]);
    expect(groupNeedsAuthSourcesByProvider([
      source({ id: "gmail:a@gmail.com", state: "synced", providerId: "google:a@gmail.com" }),
    ])).toEqual([]);
  });

  test("groups one needs-auth source under its provider", () => {
    const out = groupNeedsAuthSourcesByProvider([
      source({ id: "gmail:a@gmail.com", state: "needs-auth", providerId: "google:a@gmail.com" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].providerType).toBe("google");
    expect(out[0].accountId).toBe("a@gmail.com");
    expect(out[0].deviceId).toBe("dev-1");
    expect(out[0].memberScoped).toBe(false);
    expect(out[0].driverSourceType).toBe("gmail");
    expect(out[0].affectedSourceIds).toEqual(["gmail:a@gmail.com"]);
  });

  test("carries the owning device's name when the source row has it", () => {
    const out = groupNeedsAuthSourcesByProvider([
      source({
        id: "gmail:a@gmail.com",
        state: "needs-auth",
        providerId: "google:a@gmail.com",
        deviceName: "Maya-Laptop",
      }),
    ]);
    expect(out[0].deviceName).toBe("Maya-Laptop");
  });

  test("includes ALL sibling sources under affected provider+account, regardless of their own state", () => {
    // Reproduces the bug from the screenshot: only one source is in
    // needs-auth, but the other three under the same provider account
    // share the same broken refresh token. The banner must surface all
    // of them so one reauth heals the lot.
    const out = groupNeedsAuthSourcesByProvider([
      source({ id: "gmail:a@gmail.com", state: "error", providerId: "google:a@gmail.com" }),
      source({ id: "google-calendar:a@gmail.com", state: "needs-auth", providerId: "google:a@gmail.com" }),
      source({ id: "google-contacts:a@gmail.com", state: "error", providerId: "google:a@gmail.com" }),
      source({ id: "google-drive:a@gmail.com", state: "error", providerId: "google:a@gmail.com" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].affectedSourceIds).toEqual([
      "gmail:a@gmail.com",
      "google-calendar:a@gmail.com",
      "google-contacts:a@gmail.com",
      "google-drive:a@gmail.com",
    ]);
  });

  test("driverSourceType is the alphabetically-first sourceType so the choice is stable", () => {
    const out = groupNeedsAuthSourcesByProvider([
      source({ id: "google-drive:a@gmail.com", state: "needs-auth", providerId: "google:a@gmail.com" }),
      source({ id: "gmail:a@gmail.com", state: "error", providerId: "google:a@gmail.com" }),
      source({ id: "google-calendar:a@gmail.com", state: "error", providerId: "google:a@gmail.com" }),
    ]);
    expect(out[0].driverSourceType).toBe("gmail");
  });

  test("separates groups by accountId even within the same provider type", () => {
    const out = groupNeedsAuthSourcesByProvider([
      source({ id: "gmail:a@gmail.com", state: "needs-auth", providerId: "google:a@gmail.com" }),
      source({ id: "gmail:b@gmail.com", state: "needs-auth", providerId: "google:b@gmail.com" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].accountId).toBe("a@gmail.com");
    expect(out[1].accountId).toBe("b@gmail.com");
  });

  test("does NOT surface a group when no source under it is needs-auth", () => {
    // Outlook sources are all just `error` — none flipped to needs-auth.
    // The banner shouldn't appear; the user has no signal that this is
    // an auth problem (could be rate limit, network, …).
    const out = groupNeedsAuthSourcesByProvider([
      source({ id: "outlook-email:b@live.com", state: "error", providerId: "outlook:b@live.com" }),
    ]);
    expect(out).toEqual([]);
  });

  test("ignores sources without a providerId on syncStatus", () => {
    const out = groupNeedsAuthSourcesByProvider([
      { id: "orphan", type: "orphan", syncStatus: { state: "needs-auth" } },
    ]);
    expect(out).toEqual([]);
  });

  test("ignores non-array input", () => {
    // Defensive: callers may pass `undefined` during initial load.
    expect(groupNeedsAuthSourcesByProvider(undefined as unknown as never[])).toEqual([]);
    expect(groupNeedsAuthSourcesByProvider(null as unknown as never[])).toEqual([]);
  });

  test("a single status names the device that reported it before the row's owner", () => {
    // A row with no per-member entries still names a device on its status:
    // that is who has to sign in, even when the owner column says otherwise.
    const s = source({ id: "gmail:a@gmail.com", state: "needs-auth", providerId: "google:a@gmail.com", deviceId: "dev-owner" });
    s.syncStatus = { ...s.syncStatus, deviceId: "dev-reporter" } as typeof s.syncStatus;
    expect(groupNeedsAuthSourcesByProvider([s]).map((g: { deviceId: string }) => g.deviceId)).toEqual([
      "dev-reporter",
    ]);
  });

  test("groups are sorted deterministically across polls", () => {
    // Same input in different orders should yield the same group order.
    const a = groupNeedsAuthSourcesByProvider([
      source({ id: "gmail:zeta@gmail.com", state: "needs-auth", providerId: "google:zeta@gmail.com" }),
      source({ id: "gmail:alpha@gmail.com", state: "needs-auth", providerId: "google:alpha@gmail.com" }),
    ]);
    const b = groupNeedsAuthSourcesByProvider([
      source({ id: "gmail:alpha@gmail.com", state: "needs-auth", providerId: "google:alpha@gmail.com" }),
      source({ id: "gmail:zeta@gmail.com", state: "needs-auth", providerId: "google:zeta@gmail.com" }),
    ]);
    expect(a.map((g) => g.accountId)).toEqual(b.map((g) => g.accountId));
    expect(a[0].accountId).toBe("alpha@gmail.com");
  });

  describe("multi-device sources (syncStatus.members)", () => {
    const providerId = "google:a@gmail.com";

    test("a lapse on one member surfaces that member's device, not the owner", () => {
      // The owner (Maya-Laptop) syncs fine and its fresher success stands
      // for the source at the top level; only the member's own entry
      // still reads needs-auth.
      const out = groupNeedsAuthSourcesByProvider([
        source({
          id: "gmail:a@gmail.com",
          state: "synced",
          providerId,
          deviceId: "dev-laptop",
          deviceName: "Maya-Laptop",
          members: [
            { deviceId: "dev-laptop", state: "synced", providerId },
            { deviceId: "dev-studio", state: "needs-auth", providerId },
          ],
        }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].deviceId).toBe("dev-studio");
      expect(out[0].deviceName).toBeNull();
      expect(out[0].memberScoped).toBe(true);
      expect(out[0].affectedSourceIds).toEqual(["gmail:a@gmail.com"]);
    });

    test("the owning member's own lapse keeps the owner's name", () => {
      const out = groupNeedsAuthSourcesByProvider([
        source({
          id: "gmail:a@gmail.com",
          state: "needs-auth",
          providerId,
          deviceId: "dev-laptop",
          deviceName: "Maya-Laptop",
          members: [
            { deviceId: "dev-laptop", state: "needs-auth", providerId },
            { deviceId: "dev-studio", state: "synced", providerId },
          ],
        }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].deviceId).toBe("dev-laptop");
      expect(out[0].deviceName).toBe("Maya-Laptop");
      expect(out[0].memberScoped).toBe(true);
    });

    test("both members lapsed → each device lists only the sibling sources it hosts", () => {
      const members = [
        { deviceId: "dev-studio", state: "needs-auth", providerId },
        { deviceId: "dev-laptop", state: "needs-auth", providerId },
      ];
      const out = groupNeedsAuthSourcesByProvider([
        source({ id: "gmail:a@gmail.com", state: "needs-auth", providerId, deviceId: "dev-laptop", members }),
        source({ id: "google-calendar:a@gmail.com", state: "synced", providerId, deviceId: "dev-laptop" }),
      ]);
      expect(out).toHaveLength(2);
      expect(out.map((g) => g.deviceId)).toEqual(["dev-laptop", "dev-studio"]);
      expect(out[0].affectedSourceIds).toEqual([
        "gmail:a@gmail.com",
        "google-calendar:a@gmail.com",
      ]);
      expect(out[0].driverSourceType).toBe("gmail");
      expect(out[1].affectedSourceIds).toEqual(["gmail:a@gmail.com"]);
      expect(out[1].driverSourceType).toBe("gmail");
    });

    test("a member entry without its own providerId inherits the source's", () => {
      const out = groupNeedsAuthSourcesByProvider([
        source({
          id: "gmail:a@gmail.com",
          state: "synced",
          providerId,
          members: [
            { deviceId: "dev-laptop", state: "synced" },
            { deviceId: "dev-studio", state: "needs-auth" },
          ],
        }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].accountId).toBe("a@gmail.com");
      expect(out[0].deviceId).toBe("dev-studio");
    });

    test("a top-level needs-auth is not attributed to the owner when members say otherwise", () => {
      // Whatever the aggregate reads, the members are the authority on
      // which device must sign in.
      const out = groupNeedsAuthSourcesByProvider([
        source({
          id: "gmail:a@gmail.com",
          state: "needs-auth",
          providerId,
          deviceId: "dev-laptop",
          members: [
            { deviceId: "dev-laptop", state: "synced", providerId },
            { deviceId: "dev-studio", state: "needs-auth", providerId },
          ],
        }),
      ]);
      expect(out.map((g) => g.deviceId)).toEqual(["dev-studio"]);
    });
  });
});

describe("groupExpiringSourcesByProvider", () => {
  test("returns empty when no source is auth-expiring", () => {
    expect(groupExpiringSourcesByProvider([])).toEqual([]);
    expect(groupExpiringSourcesByProvider([
      source({ id: "plaid:item-1", state: "synced", providerId: "plaid:item-1" }),
    ])).toEqual([]);
  });

  test("groups an auth-expiring source and carries its consent deadline", () => {
    const out = groupExpiringSourcesByProvider([
      source({
        id: "plaid:item-1",
        state: "auth-expiring",
        providerId: "plaid:item-1",
        consentExpiresAt: "2026-07-04T00:00:00.000Z",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].providerType).toBe("plaid");
    expect(out[0].accountId).toBe("item-1");
    expect(out[0].consentExpiresAt).toBe("2026-07-04T00:00:00.000Z");
  });

  test("carries the SOONEST deadline across siblings under one provider+account", () => {
    const out = groupExpiringSourcesByProvider([
      source({
        id: "plaid-transactions:item-1",
        state: "auth-expiring",
        providerId: "plaid:item-1",
        consentExpiresAt: "2026-08-01T00:00:00.000Z",
      }),
      source({
        id: "plaid-balances:item-1",
        state: "auth-expiring",
        providerId: "plaid:item-1",
        consentExpiresAt: "2026-07-04T00:00:00.000Z",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].consentExpiresAt).toBe("2026-07-04T00:00:00.000Z");
    expect(out[0].affectedSourceIds).toEqual(["plaid-balances:item-1", "plaid-transactions:item-1"]);
  });

  test("does not surface needs-auth sources (that's the ReauthBanner's job)", () => {
    const out = groupExpiringSourcesByProvider([
      source({ id: "plaid:item-1", state: "needs-auth", providerId: "plaid:item-1" }),
    ]);
    expect(out).toEqual([]);
  });

  test("tolerates an expiring source with no deadline (no consentExpiresAt set)", () => {
    const out = groupExpiringSourcesByProvider([
      source({ id: "plaid:item-1", state: "auth-expiring", providerId: "plaid:item-1" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].consentExpiresAt).toBeUndefined();
  });

  test("an expiring member carries its own deadline on its device's group", () => {
    const out = groupExpiringSourcesByProvider([
      source({
        id: "plaid:item-1",
        state: "synced",
        providerId: "plaid:item-1",
        deviceId: "dev-laptop",
        members: [
          { deviceId: "dev-laptop", state: "synced", providerId: "plaid:item-1" },
          {
            deviceId: "dev-studio",
            state: "auth-expiring",
            providerId: "plaid:item-1",
            consentExpiresAt: "2026-07-04T00:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].deviceId).toBe("dev-studio");
    expect(out[0].consentExpiresAt).toBe("2026-07-04T00:00:00.000Z");
  });
});
