// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two replicas of one store disagree about an item, and the gateway converges
 * instead of oscillating.
 *
 * Two collectors host one replicated source. Replica A's view is a strict
 * subset of replica B's, and A — the lease holder — reports the item it lacks
 * as explicitly deleted on every tick, the way a trashed note re-fires. The
 * first report deletes the item and resets B, whose bootstrap restores it;
 * from then on the item is disputed: it stays, nobody is reset, and A's pages
 * still advance. The dispute survives a gateway restart and a per-member
 * resync, is visible on the source and on the member holding the item, and
 * ends only when B itself reports the deletion — or when B leaves, after
 * which A's next report lands. No unrelated item is touched at any point.
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const SOURCE = "notes-synth:shared@example.com";
const PROVIDER = "notes-synth";
const ALL = ["n-1", "n-2", "n-3", "n-4"];
/** The item A never sees; n-4 is the never-tombstoned control. */
const DISPUTED = "n-3";

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

const claim = (c: PairedCollector) =>
  asDevice<{ granted: boolean }>(c, `/sync-state/${encodeURIComponent(SOURCE)}/lease`, {
    method: "POST",
    body: "{}",
  });
const begin = async (c: PairedCollector) =>
  (
    await asDevice<{ wipeEpoch: number }>(c, `/sync-state/${encodeURIComponent(SOURCE)}/begin`, {
      method: "POST",
      body: JSON.stringify({ attemptId: randomUUID() }),
    })
  ).wipeEpoch;
const state = (c: PairedCollector) =>
  asDevice<{ cursor: unknown; lastSyncedAt: string | null; wipeEpoch: number }>(
    c,
    `/sync-state/${encodeURIComponent(SOURCE)}`,
  );
const doc = (externalId: string) => ({
  providerId: PROVIDER,
  sourceId: SOURCE,
  externalId,
  title: `Note ${externalId}`,
  content: `body ${externalId}`,
  contentHash: `h-${externalId}`,
  metadata: { documentType: "note" },
  sourceCreatedAt: "2026-02-01T10:00:00Z",
  sourceUpdatedAt: "2026-02-01T10:00:00Z",
});

interface PageResult {
  ingested: number;
  tombstonedDeleted?: number;
  deletionDisputed?: number;
  deletionDeferred?: true;
}
const page = (
  c: PairedCollector,
  body: { documents?: string[]; deletedExternalIds?: string[]; wipeEpoch?: number },
) =>
  asDevice<PageResult>(c, "/documents/with-cursor", {
    method: "POST",
    body: JSON.stringify({
      providerId: PROVIDER,
      sourceId: SOURCE,
      hasMore: false,
      cursor: { at: Date.now() },
      documents: (body.documents ?? []).map(doc),
      ...(body.deletedExternalIds ? { deletedExternalIds: body.deletedExternalIds } : {}),
      ...(body.wipeEpoch === undefined ? {} : { wipeEpoch: body.wipeEpoch }),
    }),
  });

describe("replicated deletion dispute across collectors", () => {
  let harness: MultiCollectorHarness;
  let alpha: PairedCollector;
  let beta: PairedCollector;

  const held = (): string[] => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM documents WHERE source_id = ? ORDER BY external_id",
        )
        .all(SOURCE)
        .map((r) => r.external_id);
    } finally {
      db.close();
    }
  };
  const disputedOnSource = async () =>
    (
      await harness.json<{ items: Array<{ id: string; disputedDeletions: number }> }>(
        "/admin/sources",
      )
    ).items.find((s) => s.id === SOURCE)?.disputedDeletions;
  const memberStatus = async (c: PairedCollector) =>
    (
      await harness.json<{
        members?: Array<{
          deviceId: string;
          restoredClaims?: number;
          notices?: Array<{ kind: string; severity: string; title: string }>;
        }>;
      }>(`/admin/sync/status/${encodeURIComponent(SOURCE)}`)
    ).members?.find((m) => m.deviceId === c.deviceId);
  /** B bootstraps its whole replica on a fresh epoch, the way a reset member does. */
  const bootstrapBeta = async () => {
    const epoch = await begin(beta);
    expect(await page(beta, { documents: ALL, wipeEpoch: epoch })).toMatchObject({ ingested: 4 });
    return epoch;
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    const modes = { [PROVIDER]: "replicated" as const };
    alpha = await harness.addCollector({
      name: "alpha",
      hostableSourceTypes: [PROVIDER],
      multiDeviceModes: modes,
      syncLease: true,
    });
    beta = await harness.addCollector({
      name: "beta",
      hostableSourceTypes: [PROVIDER],
      multiDeviceModes: modes,
      syncLease: true,
    });
    for (const c of [alpha, beta]) {
      const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [{ type: PROVIDER, accountId: "shared@example.com", enabled: true }],
        }),
      });
      expect(res.status).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("one delete-and-reset cycle, then the item is disputed and nothing churns", async () => {
    // The gateway answers status from its main thread and writes the ledger
    // from its writer: read the status first, so a dispute recorded later
    // must be visible to a reader that has already looked.
    expect(await disputedOnSource()).toBe(0);
    expect(await page(beta, { documents: ALL })).toMatchObject({ ingested: 4 });
    expect(await claim(alpha)).toMatchObject({ granted: true });
    expect(await page(alpha, { documents: ["n-1", "n-2"] })).toMatchObject({ ingested: 2 });

    let resets = 0;
    let betaEpoch = (await state(beta)).wipeEpoch;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const result = await page(alpha, { documents: ["n-1"], deletedExternalIds: [DISPUTED] });
      if ((await state(beta)).lastSyncedAt === null) {
        resets += 1;
        expect(result).toMatchObject({ tombstonedDeleted: 1 });
        expect(held()).toEqual(["n-1", "n-2", "n-4"]);
        betaEpoch = await bootstrapBeta();
      } else {
        expect(result).toMatchObject({ ingested: 1, tombstonedDeleted: 0, deletionDisputed: 1 });
        expect((await state(beta)).wipeEpoch).toBe(betaEpoch);
      }
      expect(held()).toEqual(ALL);
    }
    expect(resets).toBe(1);

    expect(await disputedOnSource()).toBe(1);
    expect(await memberStatus(beta)).toMatchObject({ restoredClaims: 1 });
    expect(await memberStatus(alpha)).not.toHaveProperty("restoredClaims");
    // The restorer's own notice names the member that deleted, by device name.
    const betaDispute = (await memberStatus(beta))?.notices?.filter(
      (n) => n.kind === "replica-dispute",
    );
    expect(betaDispute).toHaveLength(1);
    expect(betaDispute![0]).toMatchObject({ severity: "info" });
    expect(betaDispute![0]!.title).toBe("Keeping 1 item that alpha no longer has");
    expect((await memberStatus(alpha))?.notices?.some((n) => n.kind === "replica-dispute")).toBe(
      false,
    );
  }, 60_000);

  test("the dispute survives a gateway restart and a per-member resync", async () => {
    await harness.restartGateway();
    // The lease is in-memory and gone with the old process; the ledger is not.
    expect(await claim(alpha)).toMatchObject({ granted: true });
    const betaEpoch = (await state(beta)).wipeEpoch;
    expect(await page(alpha, { deletedExternalIds: [DISPUTED] })).toMatchObject({
      tombstonedDeleted: 0,
      deletionDisputed: 1,
    });
    expect((await state(beta)).lastSyncedAt).not.toBeNull();
    expect((await state(beta)).wipeEpoch).toBe(betaEpoch);
    expect(held()).toEqual(ALL);

    await harness.json(`/admin/sources/${encodeURIComponent(SOURCE)}/resync`, {
      method: "POST",
      body: JSON.stringify({ deviceId: beta.deviceId }),
    });
    expect((await state(beta)).lastSyncedAt).toBeNull();
    await bootstrapBeta();
    expect(await page(alpha, { deletedExternalIds: [DISPUTED] })).toMatchObject({
      tombstonedDeleted: 0,
      deletionDisputed: 1,
    });
    expect(held()).toEqual(ALL);
    expect(await disputedOnSource()).toBe(1);
  }, 120_000);

  test("the restorer's own report settles the item: no lease, no reset", async () => {
    const alphaBefore = await state(alpha);
    const betaEpoch = (await state(beta)).wipeEpoch;
    const settled = await page(beta, { deletedExternalIds: [DISPUTED], wipeEpoch: betaEpoch });
    expect(settled).toMatchObject({ tombstonedDeleted: 1 });
    expect(settled).not.toHaveProperty("deletionDeferred");
    expect(settled).not.toHaveProperty("deletionDisputed");
    expect(held()).toEqual(["n-1", "n-2", "n-4"]);
    expect(await state(alpha)).toEqual(alphaBefore);
    expect(await disputedOnSource()).toBe(0);
    expect(await memberStatus(beta)).not.toHaveProperty("restoredClaims");
  }, 60_000);

  test("a member detaching deletes nothing and closes the dispute; the next fresh report lands", async () => {
    // Open a new dispute: B holds the item again while A's deletion still
    // stands, so A's next report is disputed at once — no delete, no reset.
    const betaEpoch = (await state(beta)).wipeEpoch;
    expect(await page(beta, { documents: [DISPUTED], wipeEpoch: betaEpoch })).toMatchObject({
      ingested: 1,
    });
    expect(await page(alpha, { deletedExternalIds: [DISPUTED] })).toMatchObject({
      tombstonedDeleted: 0,
      deletionDisputed: 1,
    });
    expect((await state(beta)).lastSyncedAt).not.toBeNull();
    expect(held()).toEqual(ALL);
    expect(await disputedOnSource()).toBe(1);

    await harness.json(
      `/admin/sources/${encodeURIComponent(SOURCE)}/members/${encodeURIComponent(beta.deviceId)}`,
      { method: "DELETE" },
    );
    expect(held()).toEqual(ALL);
    expect(await disputedOnSource()).toBe(0);

    // The only replica left says the item is gone, and there is nobody to
    // reset.
    expect(await page(alpha, { deletedExternalIds: [DISPUTED] })).toMatchObject({
      tombstonedDeleted: 1,
    });
    expect(held()).toEqual(["n-1", "n-2", "n-4"]);
    expect((await state(alpha)).lastSyncedAt).not.toBeNull();
  }, 60_000);
});
