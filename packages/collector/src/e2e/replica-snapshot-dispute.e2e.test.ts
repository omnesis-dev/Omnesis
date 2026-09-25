// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two replicas of one store disagree about an item, and neither of them ever
 * sends a tombstone: everything the gateway learns comes from the members'
 * full snapshots. The disagreement has to converge through the absence
 * ledger and the replica deletion ledger together, with the same corroboration
 * everywhere a deletion is inferred and never more than one delete-and-reset
 * cycle per item.
 *
 * The cases, each on its own item ids so no case leans on another's state:
 *
 *   1. the holder's corroborated omissions delete once and reset the sibling
 *      once; the sibling's restore is a dispute, and the holder's further
 *      omissions delete nothing and reset nobody;
 *   2. one omission by the restorer is never a verdict, naming the item again
 *      starts its clock over, and only spaced omissions past the age settle
 *      it — without the lease and without a reset;
 *   3. a deleter whose replica holds the item again withdraws: the history
 *      closes and a single omission afterwards only marks an absence;
 *   4. a lease hand-over changes nothing; the new holder's own corroborated
 *      omissions settle its dispute, and a sweep afterwards deletes nothing;
 *   5. a third member that never held the item adds its verdict but cannot
 *      settle a dispute another member keeps open;
 *   6. a gateway restart in the middle of corroboration keeps the count;
 *   7. a member sent back to bootstrap re-vouches from scratch: an item it no
 *      longer holds stops being kept alive by it, and the holder's
 *      corroborated omissions then delete it with the one allowed reset;
 *   8. with two restorers, one's matured omission leaves the item disputed
 *      and the page says so; the other's settles it;
 *   9. a lease hand-over in the middle of corroborating an absence hands the
 *      verdict to the member that corroborated last;
 *  10. a member that detaches after its snapshots earned a pending deletion
 *      leaves no ghost verdict behind;
 *  11. a detached restorer closes its dispute; the holder's corroborated
 *      omissions then delete the item, and no unrelated item is touched.
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const SOURCE = "notes-synth:shared@example.com";
const PROVIDER = "notes-synth";
/** Three spaced observations over 60ms; the gateway derives a 20ms spacing from them. */
const MIN_OBSERVATIONS = 3;
const MIN_AGE_MS = 60;
/**
 * Comfortably past the spacing the policy derives. Every timing rule the
 * gateway applies is a lower bound on its own clock, and a timer only ever
 * fires late, so load can widen these gaps but never close them.
 */
const SPACING_MS = Math.floor(MIN_AGE_MS / MIN_OBSERVATIONS) + 15;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
const release = (c: PairedCollector) =>
  asDevice<{ released: boolean }>(c, `/sync-state/${encodeURIComponent(SOURCE)}/lease`, {
    method: "DELETE",
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
  reconcileDeferred?: true;
  absence?: { marked: number; absent: number };
}
/** One sync page, on a write epoch claimed for it the way a collector tick does. */
const page = async (
  c: PairedCollector,
  body: {
    documents?: readonly string[];
    deletedExternalIds?: readonly string[];
    presentExternalIds?: readonly string[];
  },
) => {
  const wipeEpoch = await begin(c);
  return asDevice<PageResult>(c, "/documents/with-cursor", {
    method: "POST",
    body: JSON.stringify({
      providerId: PROVIDER,
      sourceId: SOURCE,
      hasMore: false,
      cursor: { at: Date.now() },
      documents: (body.documents ?? []).map(doc),
      ...(body.deletedExternalIds ? { deletedExternalIds: body.deletedExternalIds } : {}),
      ...(body.presentExternalIds
        ? { presentExternalIds: body.presentExternalIds, observationId: randomUUID() }
        : {}),
      wipeEpoch,
    }),
  });
};

/** What a replica holds: the member's snapshot always names exactly this. */
type View = Set<string>;

describe("replicated snapshot dispute across collectors", () => {
  let harness: MultiCollectorHarness;
  let alpha: PairedCollector;
  let beta: PairedCollector;
  let gamma: PairedCollector;
  const viewA: View = new Set();
  const viewB: View = new Set();
  const viewG: View = new Set();

  /** Pair a collector that announces the replicated contract and joins the source. */
  const join = async (name: string) => {
    const c = await harness.addCollector({
      name,
      hostableSourceTypes: [PROVIDER],
      multiDeviceModes: { [PROVIDER]: "replicated" },
      syncLease: true,
    });
    const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ type: PROVIDER, accountId: "shared@example.com", enabled: true }],
      }),
    });
    expect(res.status).toBe(200);
    return c;
  };

  const readDb = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const held = (): string[] =>
    readDb((db) =>
      db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM documents WHERE source_id = ? ORDER BY external_id",
        )
        .all(SOURCE)
        .map((r) => r.external_id),
    );
  const verdicts = (externalId: string): string[] =>
    readDb((db) =>
      db
        .prepare<[string, string], { device_id: string; role: string; omissions: number }>(
          "SELECT device_id, role, omissions FROM replica_deletion_claims WHERE source_id = ? AND external_id = ? ORDER BY device_id",
        )
        .all(SOURCE, externalId)
        .map((r) => `${nameOf(r.device_id)}:${r.role}:${r.omissions}`)
        .sort(),
    );
  const absenceObservations = (externalId: string): number | undefined =>
    readDb(
      (db) =>
        db
          .prepare<
            [string, string],
            { observations: number }
          >("SELECT observations FROM document_absences WHERE source_id = ? AND external_id = ?")
          .get(SOURCE, externalId)?.observations,
    );
  const nameOf = (deviceId: string): string =>
    [alpha, beta, gamma].find((c) => c?.deviceId === deviceId)?.name ?? deviceId;
  const disputedOnSource = async () =>
    (
      await harness.json<{ items: Array<{ id: string; disputedDeletions: number }> }>(
        "/admin/sources",
      )
    ).items.find((s) => s.id === SOURCE)?.disputedDeletions;
  /** One sweep cycle: the task alternates the document and analytics planes. */
  const sweep = async () => {
    for (let i = 0; i < 2; i += 1) {
      await harness.json("/admin/background/run/absence.sweep", { method: "POST" });
    }
  };
  /** A member's full snapshot, naming exactly what its replica holds. */
  const snapshot = (c: PairedCollector, view: View) => page(c, { presentExternalIds: [...view] });
  /** A member's bootstrap after a reset: its whole replica plus its snapshot on a fresh epoch. */
  const bootstrap = async (c: PairedCollector, view: View) => {
    const result = await page(c, { documents: [...view], presentExternalIds: [...view] });
    expect(result.ingested).toBe(view.size);
    expect(await isReset(c)).toBe(false);
  };
  /** `count` spaced snapshots from one member, then wait past the age floor. */
  const corroborate = async (c: PairedCollector, view: View) => {
    const started = Date.now();
    const results: PageResult[] = [];
    for (let i = 0; i < MIN_OBSERVATIONS; i += 1) {
      if (i > 0) await sleep(SPACING_MS);
      results.push(await snapshot(c, view));
    }
    const elapsed = Date.now() - started;
    if (elapsed < MIN_AGE_MS + 5) await sleep(MIN_AGE_MS + 5 - elapsed);
    return results;
  };
  const isReset = async (c: PairedCollector) => (await state(c)).lastSyncedAt === null;

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      // The absence sweep is driven by hand through the synthetic-only run
      // route; nothing else about this gateway is synthetic.
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1" },
      gatewayConfig: {
        gateway: {
          snapshotAbsence: {
            minObservations: MIN_OBSERVATIONS,
            minAge: `${MIN_AGE_MS}ms`,
            maxMarksPerSnapshot: 200,
            deletionGrace: "1ms",
          },
        },
      },
    });
    await harness.start();
    alpha = await join("alpha");
    beta = await join("beta");
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("1. the holder's corroborated omissions delete once; the sibling's restore is a dispute", async () => {
    expect(await disputedOnSource()).toBe(0);
    for (const id of ["a-1", "a-2"]) viewA.add(id);
    for (const id of ["a-1", "a-2", "a-3", "a-4"]) viewB.add(id);
    expect(await claim(alpha)).toMatchObject({ granted: true });
    await page(alpha, { documents: [...viewA], presentExternalIds: [...viewA] });
    // The sibling contributes its whole replica; as a non-holder its snapshot
    // is set aside, its documents are not.
    expect(
      await page(beta, { documents: [...viewB], presentExternalIds: [...viewB] }),
    ).toMatchObject({ ingested: 4, reconcileDeferred: true });
    expect(held()).toEqual(["a-1", "a-2", "a-3", "a-4"]);

    // The holder never lists a-3 and a-4. Three spaced snapshots and the age
    // floor later, the sweep deletes them, resets every member, and records
    // the holder's verdict.
    await corroborate(alpha, viewA);
    expect(absenceObservations("a-3")).toBe(MIN_OBSERVATIONS);
    expect(held()).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    await sweep();
    expect(held()).toEqual(["a-1", "a-2"]);
    expect(await isReset(alpha)).toBe(true);
    expect(await isReset(beta)).toBe(true);
    expect(verdicts("a-3")).toEqual(["alpha:deleted:0"]);
    expect(verdicts("a-4")).toEqual(["alpha:deleted:0"]);

    // Both bootstrap. The sibling's replica still holds a-3 and a-4: back they
    // come, and now they are disputed.
    await bootstrap(alpha, viewA);
    await bootstrap(beta, viewB);
    expect(held()).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    expect(verdicts("a-3")).toEqual(["alpha:deleted:0", "beta:restored:0"]);
    expect(await disputedOnSource()).toBe(2);

    // The holder keeps omitting them. Two more corroborated rounds and sweeps
    // change nothing: no deletion, no reset, and the sibling's epoch stands.
    for (let round = 0; round < 2; round += 1) {
      const results = await corroborate(alpha, viewA);
      // The holder's snapshots were applied: each one saw the two absences.
      for (const result of results) expect(result.absence?.absent).toBe(2);
      await sweep();
      expect(held()).toEqual(["a-1", "a-2", "a-3", "a-4"]);
      expect(await isReset(alpha)).toBe(false);
      expect(await isReset(beta)).toBe(false);
    }
    expect(await disputedOnSource()).toBe(2);
  }, 120_000);

  test("2. the restorer's omissions settle only once corroborated; naming the item restarts its clock", async () => {
    // beta's replica loses a-3 (not a-4). One snapshot is not a verdict.
    viewB.delete("a-3");
    const first = await snapshot(beta, viewB);
    expect(first).toMatchObject({ reconcileDeferred: true, tombstonedDeleted: 0 });
    expect(held()).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    expect(verdicts("a-3")).toEqual(["alpha:deleted:0", "beta:restored:1"]);

    // A second spaced omission counts; naming a-3 again throws both away.
    await sleep(SPACING_MS);
    await snapshot(beta, viewB);
    expect(verdicts("a-3")).toEqual(["alpha:deleted:0", "beta:restored:2"]);
    viewB.add("a-3");
    await snapshot(beta, viewB);
    expect(verdicts("a-3")).toEqual(["alpha:deleted:0", "beta:restored:0"]);
    viewB.delete("a-3");

    // Corroborated: the restorer's own verdict deletes a-3 with no lease and
    // no reset; a-4 stays disputed.
    const alphaSynced = (await state(alpha)).lastSyncedAt;
    await corroborate(beta, viewB);
    expect(held()).toEqual(["a-1", "a-2", "a-4"]);
    expect(verdicts("a-3")).toEqual(["alpha:deleted:0", "beta:deleted:0"]);
    expect((await state(alpha)).lastSyncedAt).toBe(alphaSynced);
    expect(await disputedOnSource()).toBe(1);
  }, 60_000);

  test("3. a deleter whose replica holds the item again withdraws; a single omission then only marks", async () => {
    // alpha's replica gets a-4 back: alpha was its only deleter, so the
    // history closes and beta's restore row goes with it.
    viewA.add("a-4");
    await page(alpha, { documents: ["a-4"], presentExternalIds: [...viewA] });
    expect(verdicts("a-4")).toEqual([]);
    expect(await disputedOnSource()).toBe(0);

    // alpha loses it again and says so once: an ordinary absence mark, no
    // verdict, no deletion.
    viewA.delete("a-4");
    await snapshot(alpha, viewA);
    expect(held()).toEqual(["a-1", "a-2", "a-4"]);
    expect(absenceObservations("a-4")).toBe(1);
    expect(verdicts("a-4")).toEqual([]);
    // Naming it again clears the mark; the corpus is untouched throughout.
    viewA.add("a-4");
    await snapshot(alpha, viewA);
    expect(absenceObservations("a-4")).toBeUndefined();
    expect(held()).toEqual(["a-1", "a-2", "a-4"]);
  }, 60_000);

  test("4. a lease hand-over changes nothing; the new holder's corroborated omissions settle its own dispute", async () => {
    // Open a dispute on a-4 the explicit way: alpha (holder) tombstones it,
    // beta's bootstrap restores it.
    expect(await page(alpha, { deletedExternalIds: ["a-4"] })).toMatchObject({
      tombstonedDeleted: 1,
    });
    viewA.delete("a-4");
    expect(await isReset(beta)).toBe(true);
    await bootstrap(beta, viewB);
    expect(verdicts("a-4")).toEqual(["alpha:deleted:0", "beta:restored:0"]);

    // The lease moves to beta. Its snapshots as holder both mark absences and
    // count towards its restore; the ledger settles it exactly once.
    expect(await release(alpha)).toMatchObject({ released: true });
    expect(await claim(beta)).toMatchObject({ granted: true });
    viewB.delete("a-4");
    const alphaSynced = (await state(alpha)).lastSyncedAt;
    await corroborate(beta, viewB);
    expect(held()).toEqual(["a-1", "a-2"]);
    expect(verdicts("a-4")).toEqual(["alpha:deleted:0", "beta:deleted:0"]);
    expect((await state(alpha)).lastSyncedAt).toBe(alphaSynced);
    // A sweep afterwards finds nothing left to do and resets nobody.
    await sweep();
    expect(held()).toEqual(["a-1", "a-2"]);
    expect(await isReset(alpha)).toBe(false);
    expect(await isReset(beta)).toBe(false);
    expect(await disputedOnSource()).toBe(0);
  }, 60_000);

  test("5. a third member that never held the item adds a verdict but cannot settle it", async () => {
    gamma = await join("gamma");
    for (const id of ["a-1", "a-2"]) viewG.add(id);
    await bootstrap(gamma, viewG);

    // beta (holder) deletes b-1, which only alpha's replica holds.
    for (const id of ["b-1"]) {
      viewA.add(id);
      viewB.add(id);
    }
    await page(beta, { documents: ["b-1"], presentExternalIds: [...viewB] });
    viewB.delete("b-1");
    expect(await page(beta, { deletedExternalIds: ["b-1"] })).toMatchObject({
      tombstonedDeleted: 1,
    });
    await bootstrap(alpha, viewA);
    await bootstrap(gamma, viewG);
    expect(held()).toEqual(["a-1", "a-2", "b-1"]);
    expect(verdicts("b-1")).toEqual(["alpha:restored:0", "beta:deleted:0"]);

    // gamma's snapshots never name b-1, but gamma never restored it: nothing
    // to count. Its tombstone is recorded, and alpha still keeps b-1 alive.
    await corroborate(gamma, viewG);
    expect(verdicts("b-1")).toEqual(["alpha:restored:0", "beta:deleted:0"]);
    expect(await page(gamma, { deletedExternalIds: ["b-1"] })).toMatchObject({
      tombstonedDeleted: 0,
      deletionDisputed: 1,
    });
    expect(held()).toEqual(["a-1", "a-2", "b-1"]);
    expect(verdicts("b-1")).toEqual(["alpha:restored:0", "beta:deleted:0", "gamma:deleted:0"]);
    expect(await disputedOnSource()).toBe(1);
  }, 120_000);

  test("6. a gateway restart in the middle of corroboration keeps the count", async () => {
    // alpha's replica loses b-1. Two spaced omissions, then a restart.
    viewA.delete("b-1");
    await snapshot(alpha, viewA);
    await sleep(SPACING_MS);
    await snapshot(alpha, viewA);
    expect(verdicts("b-1")).toEqual(["alpha:restored:2", "beta:deleted:0", "gamma:deleted:0"]);

    await harness.restartGateway();
    expect(verdicts("b-1")).toEqual(["alpha:restored:2", "beta:deleted:0", "gamma:deleted:0"]);
    expect(held()).toEqual(["a-1", "a-2", "b-1"]);

    // The third omission, past the age floor, is the verdict — with no lease
    // held by anyone after the restart.
    await sleep(MIN_AGE_MS);
    await snapshot(alpha, viewA);
    expect(held()).toEqual(["a-1", "a-2"]);
    expect(verdicts("b-1")).toEqual(["alpha:deleted:0", "beta:deleted:0", "gamma:deleted:0"]);
    expect(await disputedOnSource()).toBe(0);
  }, 120_000);

  test("7. a member sent back to bootstrap re-vouches from scratch", async () => {
    // beta (holder again) deletes c-1, which alpha's replica holds; alpha
    // restores it.
    expect(await claim(beta)).toMatchObject({ granted: true });
    viewA.add("c-1");
    viewB.add("c-1");
    await page(beta, { documents: ["c-1"], presentExternalIds: [...viewB] });
    viewB.delete("c-1");
    expect(await page(beta, { deletedExternalIds: ["c-1"] })).toMatchObject({
      tombstonedDeleted: 1,
    });
    await bootstrap(alpha, viewA);
    await bootstrap(gamma, viewG);
    expect(verdicts("c-1")).toEqual(["alpha:restored:0", "beta:deleted:0"]);

    // The operator resyncs alpha. Its restore is withdrawn; its bootstrap no
    // longer carries c-1, so nothing keeps c-1 alive any more.
    viewA.delete("c-1");
    await harness.json(`/admin/sources/${encodeURIComponent(SOURCE)}/resync`, {
      method: "POST",
      body: JSON.stringify({ deviceId: alpha.deviceId }),
    });
    expect(await isReset(alpha)).toBe(true);
    expect(verdicts("c-1")).toEqual(["beta:deleted:0"]);
    await bootstrap(alpha, viewA);
    expect(held()).toEqual(["a-1", "a-2", "c-1"]);
    expect(verdicts("c-1")).toEqual(["beta:deleted:0"]);

    // The holder's corroborated omissions now delete it — an uncontested
    // item, so the one allowed reset happens — and every bootstrap that
    // follows leaves it gone.
    await corroborate(beta, viewB);
    await sweep();
    expect(held()).toEqual(["a-1", "a-2"]);
    expect(await isReset(alpha)).toBe(true);
    expect(await isReset(gamma)).toBe(true);
    await bootstrap(alpha, viewA);
    await bootstrap(gamma, viewG);
    expect(held()).toEqual(["a-1", "a-2"]);
    await sweep();
    expect(held()).toEqual(["a-1", "a-2"]);
    expect(await isReset(alpha)).toBe(false);
  }, 120_000);

  test("8. two restorers: one's matured omission leaves the item disputed, the other's settles it", async () => {
    // beta (holder) deletes e-1, which alpha and gamma both hold.
    for (const view of [viewA, viewB, viewG]) view.add("e-1");
    await page(beta, { documents: ["e-1"], presentExternalIds: [...viewB] });
    viewB.delete("e-1");
    expect(await page(beta, { deletedExternalIds: ["e-1"] })).toMatchObject({
      tombstonedDeleted: 1,
    });
    await bootstrap(alpha, viewA);
    await bootstrap(gamma, viewG);
    expect(verdicts("e-1")).toEqual(["alpha:restored:0", "beta:deleted:0", "gamma:restored:0"]);

    // alpha's replica loses e-1; its corroborated omissions are its verdict,
    // but gamma still holds the item, so it stays — the page reports the
    // dispute — and alpha's own row reads deleted.
    viewA.delete("e-1");
    const results = await corroborate(alpha, viewA);
    expect(results.at(-1)).toMatchObject({ deletionDisputed: 1, tombstonedDeleted: 0 });
    expect(held()).toContain("e-1");
    expect(verdicts("e-1")).toEqual(["alpha:deleted:0", "beta:deleted:0", "gamma:restored:0"]);
    expect(await disputedOnSource()).toBe(1);

    // gamma's replica loses it too: the last restorer's verdict settles it.
    viewG.delete("e-1");
    await corroborate(gamma, viewG);
    expect(held()).not.toContain("e-1");
    expect(verdicts("e-1")).toEqual(["alpha:deleted:0", "beta:deleted:0", "gamma:deleted:0"]);
    expect(await disputedOnSource()).toBe(0);
  }, 120_000);

  test("9. a lease hand-over in the middle of corroborating an absence hands the verdict on", async () => {
    // alpha holds f-1; beta (holder) never lists it. Two of beta's
    // observations, then the lease moves to gamma, which corroborates the
    // third: the sweep records gamma's verdict.
    viewA.add("f-1");
    await page(alpha, { documents: ["f-1"], presentExternalIds: [...viewA] });
    await snapshot(beta, viewB);
    await sleep(SPACING_MS);
    await snapshot(beta, viewB);
    expect(absenceObservations("f-1")).toBe(2);
    expect(await release(beta)).toMatchObject({ released: true });
    expect(await claim(gamma)).toMatchObject({ granted: true });
    await sleep(SPACING_MS);
    await snapshot(gamma, viewG);
    expect(absenceObservations("f-1")).toBe(3);
    await sleep(MIN_AGE_MS);
    await sweep();
    expect(held()).not.toContain("f-1");
    expect(verdicts("f-1")).toEqual(["gamma:deleted:0"]);
    expect(await isReset(alpha)).toBe(true);

    // alpha's bootstrap brings it back as a dispute against gamma; gamma's
    // own bootstrap holds nothing new, and the dispute stands.
    await bootstrap(alpha, viewA);
    await bootstrap(beta, viewB);
    await bootstrap(gamma, viewG);
    expect(verdicts("f-1")).toEqual(["alpha:restored:0", "gamma:deleted:0"]);
    expect(await disputedOnSource()).toBe(1);
    // Leave the lease with beta for the remaining cases.
    expect(await release(gamma)).toMatchObject({ released: true });
    expect(await claim(beta)).toMatchObject({ granted: true });
    viewA.delete("f-1");
    await corroborate(alpha, viewA);
    expect(held()).not.toContain("f-1");
  }, 120_000);

  test("10. a detached observer leaves no ghost verdict behind", async () => {
    // gamma's snapshots earn a pending deletion of g-1 (which alpha holds),
    // then gamma detaches before the sweep runs.
    viewA.add("g-1");
    await page(alpha, { documents: ["g-1"], presentExternalIds: [...viewA] });
    expect(await release(beta)).toMatchObject({ released: true });
    expect(await claim(gamma)).toMatchObject({ granted: true });
    await corroborate(gamma, viewG);
    expect(absenceObservations("g-1")).toBe(MIN_OBSERVATIONS);
    await harness.json(
      `/admin/sources/${encodeURIComponent(SOURCE)}/members/${encodeURIComponent(gamma.deviceId)}`,
      { method: "DELETE" },
    );
    await sweep();
    // The deletion still happens — its deadline was earned — but nobody's
    // verdict is recorded, so alpha's bootstrap restores an ordinary item.
    expect(held()).not.toContain("g-1");
    expect(verdicts("g-1")).toEqual([]);
    await bootstrap(alpha, viewA);
    await bootstrap(beta, viewB);
    expect(held()).toContain("g-1");
    expect(verdicts("g-1")).toEqual([]);
    expect(await disputedOnSource()).toBe(0);
    // Re-admit gamma for the final case, holding what it held before.
    gamma = await join("gamma-again");
    await bootstrap(gamma, viewG);
    expect(await claim(beta)).toMatchObject({ granted: true });
    viewA.delete("g-1");
    await corroborate(beta, viewB);
    await sweep();
    expect(held()).not.toContain("g-1");
    await bootstrap(alpha, viewA);
    await bootstrap(gamma, viewG);
  }, 180_000);

  test("11. a detached restorer closes its dispute; no unrelated item is ever touched", async () => {
    // beta (holder) deletes d-1, gamma's replica holds it; gamma restores it.
    viewB.add("d-1");
    viewG.add("d-1");
    await page(beta, { documents: ["d-1"], presentExternalIds: [...viewB] });
    viewB.delete("d-1");
    expect(await page(beta, { deletedExternalIds: ["d-1"] })).toMatchObject({
      tombstonedDeleted: 1,
    });
    await bootstrap(alpha, viewA);
    await bootstrap(gamma, viewG);
    expect(verdicts("d-1")).toEqual(["beta:deleted:0", `${gamma.name}:restored:0`]);
    expect(await disputedOnSource()).toBe(1);

    await harness.json(
      `/admin/sources/${encodeURIComponent(SOURCE)}/members/${encodeURIComponent(gamma.deviceId)}`,
      { method: "DELETE" },
    );
    expect(held()).toEqual(["a-1", "a-2", "d-1"]);
    expect(verdicts("d-1")).toEqual(["beta:deleted:0"]);
    expect(await disputedOnSource()).toBe(0);

    // With nobody left keeping d-1 alive, the holder's corroborated omissions
    // delete it. a-1 and a-2 were named by every snapshot of this suite and
    // are still here.
    await corroborate(beta, viewB);
    await sweep();
    expect(held()).toEqual(["a-1", "a-2"]);
    await bootstrap(alpha, viewA);
    expect(held()).toEqual(["a-1", "a-2"]);
  }, 120_000);
});
