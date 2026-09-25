// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sync lease: one device syncs a handoff source at a time, and one
 * member is the deletion authority of a replicated source.
 *
 * Two collectors that announce the `syncLease` capability host the same
 * handoff source. The lease is claimed over HTTP the way a collector's tick
 * does; pages are committed with the collector's own token so the gateway
 * gates them as it would a real sync. A short lease TTL lets the suite watch
 * a lease lapse: the online incumbent is preferred for one more window, and
 * a sibling takes over once the incumbent is gone. A third collector that
 * never announces the capability is refused before it can join or write.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

const HANDOFF = "calendar-synth:shared@example.com";
const REPLICATED = "notes-synth:shared@example.com";
const LEASE_TTL_MS = 4_000;
/** Sleep until an absolute time, so waits anchor on a renewal instead of stacking. */
const until = (t: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, t - Date.now())));

async function bulkUpsert(c: PairedCollector, entries: Array<{ type: string; accountId: string }>) {
  const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sources: entries.map((e) => ({ ...e, enabled: true })) }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { errors: Array<{ error: string }> };
}

async function asDevice<T>(c: PairedCollector, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${c.gatewayBase}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface LeaseDecision {
  granted: boolean;
  holder?: string;
  reason?: string;
}
const claim = (c: PairedCollector, id: string) =>
  asDevice<LeaseDecision>(c, `/sync-state/${encodeURIComponent(id)}/lease`, {
    method: "POST",
    body: "{}",
  });
const release = (c: PairedCollector, id: string) =>
  asDevice<{ released: boolean }>(c, `/sync-state/${encodeURIComponent(id)}/lease`, {
    method: "DELETE",
  });
const doc = (id: string, externalId: string) => ({
  providerId: id.slice(0, id.indexOf(":")),
  sourceId: id,
  externalId,
  title: `Note ${externalId}`,
  content: `body ${externalId}`,
  contentHash: `h-${externalId}`,
  metadata: { documentType: "note" },
  sourceCreatedAt: "2026-02-01T10:00:00Z",
  sourceUpdatedAt: "2026-02-01T10:00:00Z",
});
const page = (
  c: PairedCollector,
  id: string,
  body: { documents?: unknown[]; presentExternalIds?: string[]; cursor: unknown },
) =>
  asDevice<{
    ingested: number;
    absence?: { marked: number; absent: number };
    rejected?: boolean;
    reconcileDeferred?: boolean;
  }>(c, "/documents/with-cursor", {
    method: "POST",
    body: JSON.stringify({
      providerId: id.slice(0, id.indexOf(":")),
      sourceId: id,
      hasMore: false,
      ...body,
    }),
  });

describe("the sync lease across collectors", () => {
  let harness: MultiCollectorHarness;
  let alpha: PairedCollector;
  let beta: PairedCollector;
  let legacy: PairedCollector;

  const count = async (id: string) =>
    (await harness.json<{ count: number }>(`/documents/count/${encodeURIComponent(id)}`)).count;
  const leaseHolder = async (id: string) =>
    (
      await harness.json<{ items: Array<{ id: string; leaseHolder: string | null }> }>(
        "/admin/sources",
      )
    ).items.find((s) => s.id === id)?.leaseHolder ?? null;

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      gatewayConfig: { multiDevice: { leaseTtl: `${LEASE_TTL_MS}ms` } },
    });
    await harness.start();
    const modes = { "calendar-synth": "handoff" as const, "notes-synth": "replicated" as const };
    const types = ["calendar-synth", "notes-synth"];
    alpha = await harness.addCollector({
      name: "alpha",
      hostableSourceTypes: types,
      multiDeviceModes: modes,
      syncLease: true,
    });
    beta = await harness.addCollector({
      name: "beta",
      hostableSourceTypes: types,
      multiDeviceModes: modes,
      syncLease: true,
    });
    legacy = await harness.addCollector({
      name: "legacy",
      hostableSourceTypes: types,
      multiDeviceModes: modes,
    });
    for (const c of [alpha, beta]) {
      const registered = await bulkUpsert(c, [
        { type: "calendar-synth", accountId: "shared@example.com" },
        { type: "notes-synth", accountId: "shared@example.com" },
      ]);
      expect(registered.errors).toEqual([]);
    }
    const rejected = await bulkUpsert(legacy, [
      { type: "calendar-synth", accountId: "shared@example.com" },
      { type: "notes-synth", accountId: "shared@example.com" },
    ]);
    expect(rejected.errors).toHaveLength(2);
    expect(rejected.errors.every((entry) => entry.error.includes("does not support"))).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("one collector holds a handoff source; the other's page and a legacy collector are refused", async () => {
    expect(await claim(alpha, HANDOFF)).toMatchObject({ granted: true, holder: alpha.deviceId });
    expect(await claim(beta, HANDOFF)).toMatchObject({
      granted: false,
      reason: "held",
      holder: alpha.deviceId,
    });
    expect(await leaseHolder(HANDOFF)).toBe(alpha.deviceId);

    expect(
      await page(alpha, HANDOFF, { documents: [doc(HANDOFF, "a-1")], cursor: { page: 1 } }),
    ).toMatchObject({
      ingested: 1,
    });
    expect(
      await page(beta, HANDOFF, { documents: [doc(HANDOFF, "b-1")], cursor: { page: 1 } }),
    ).toMatchObject({
      ingested: 0,
      rejected: true,
      reason: "lease",
      holder: alpha.deviceId,
    });
    await expect(
      page(legacy, HANDOFF, { documents: [doc(HANDOFF, "l-1")], cursor: { page: 1 } }),
    ).rejects.toThrow(/403/);
    expect(await count(HANDOFF)).toBe(1);
  });

  test("Sync now reaches the holder while it is online", async () => {
    const sync = await harness.json<{ ok: boolean; result?: unknown; results?: unknown[] }>(
      `/admin/sources/${encodeURIComponent(HANDOFF)}/sync`,
      { method: "POST" },
    );
    expect(sync.ok).toBe(true);
    expect(alpha.receivedCommands.some((cmd) => cmd.type === "source.sync")).toBe(true);
    expect(beta.receivedCommands.some((cmd) => cmd.type === "source.sync")).toBe(false);
  });

  test("a lapsed lease prefers its online incumbent, then passes to a sibling once the incumbent is gone", async () => {
    // The holder's pages renew the lease: half a TTL after a renewal it still holds.
    expect(await page(alpha, HANDOFF, { documents: [], cursor: { page: 2 } })).toMatchObject({
      ingested: 0,
    });
    const renewedAt = Date.now();
    await until(renewedAt + LEASE_TTL_MS * 0.5);
    expect(await claim(beta, HANDOFF)).toMatchObject({ granted: false, reason: "held" });

    // Left unrenewed it lapses; alpha is online, so beta is held off for one
    // more window after the lapse.
    await until(renewedAt + LEASE_TTL_MS * 1.5);
    expect(await claim(beta, HANDOFF)).toMatchObject({
      granted: false,
      reason: "incumbent",
      holder: alpha.deviceId,
    });
    // Once alpha is gone, beta takes the source over.
    alpha.ws.disconnect();
    await waitForCondition(
      async () => {
        const { items } = await harness.json<{ items: Array<{ id: string; online: boolean }> }>(
          "/admin/devices",
        );
        return items.find((d) => d.id === alpha.deviceId)?.online === false;
      },
      5_000,
      "alpha went offline",
    );
    expect(await claim(beta, HANDOFF)).toMatchObject({ granted: true, holder: beta.deviceId });
    expect(
      await page(beta, HANDOFF, { documents: [doc(HANDOFF, "b-2")], cursor: { page: 3 } }),
    ).toMatchObject({ ingested: 1 });
    // Release hands it over at once — no incumbent preference.
    expect(await release(beta, HANDOFF)).toEqual({ released: true });
    expect(await leaseHolder(HANDOFF)).toBeNull();
  }, 40_000);

  test("a replicated member without the lease commits its page but defers the snapshot reconcile", async () => {
    expect(await claim(beta, REPLICATED)).toMatchObject({ granted: true });
    expect(
      await page(beta, REPLICATED, {
        documents: [doc(REPLICATED, "n-1"), doc(REPLICATED, "n-2")],
        cursor: { page: 1 },
      }),
    ).toMatchObject({ ingested: 2 });
    // A collector without the lease contract never joined and cannot apply
    // documents or an authoritative snapshot through its scoped token.
    await expect(
      page(legacy, REPLICATED, {
        documents: [doc(REPLICATED, "n-1")],
        presentExternalIds: ["n-1"],
        cursor: { page: 2 },
      }),
    ).rejects.toThrow(/403/);
    expect(await count(REPLICATED)).toBe(2);
    expect(
      await page(beta, REPLICATED, { documents: [doc(REPLICATED, "n-2")], cursor: { page: 2 } }),
    ).toMatchObject({ ingested: 1 });
    // A capable member that does not hold the lease: documents land, and its
    // snapshot is not diffed at all.
    const alphaPage = await asDevice<{
      ingested: number;
      reconciledDeleted: number;
      absence?: unknown;
      reconcileDeferred?: boolean;
    }>(alpha, "/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: "notes-synth",
        sourceId: REPLICATED,
        hasMore: false,
        documents: [doc(REPLICATED, "n-3")],
        presentExternalIds: ["n-3"],
        cursor: { page: 3 },
      }),
    }).catch(() => null);
    // alpha's socket is closed but its token still works over HTTP.
    expect(alphaPage).toMatchObject({
      ingested: 1,
      reconciledDeleted: 0,
      reconcileDeferred: true,
    });
    expect(alphaPage).not.toHaveProperty("absence");
    expect(await count(REPLICATED)).toBe(3);
    // The holder's snapshot is the reconcile authority — and the corpus is
    // still whole, because a snapshot removes nothing on its own.
    expect(
      await page(beta, REPLICATED, {
        documents: [],
        presentExternalIds: ["n-3"],
        cursor: { page: 4 },
      }),
    ).toMatchObject({ absence: { absent: 2 } });
    expect(await count(REPLICATED)).toBe(3);
  }, 30_000);
});
