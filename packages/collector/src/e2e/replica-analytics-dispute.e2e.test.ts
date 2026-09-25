// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two replicas of one store disagree about a structured row. Analytics rows
 * live in DuckDB while the replica deletion ledger lives in SQLite, so the
 * same rule that keeps documents from oscillating has to hold across the two
 * stores: one delete-and-reset cycle per row, a restore is a dispute, and a
 * dispute is settled only by its restorers — by tombstone or by corroborated
 * omission — never by the sweep, never with another reset.
 *
 * Every page here is sent the way a collector tick sends it: rows and
 * tombstones on a fresh write epoch, then the cursor, then the snapshot.
 *
 *   1. the holder's tombstone deletes once and resets the sibling once; the
 *      sibling's bootstrap restore is a dispute the holder's repeated
 *      tombstones cannot delete or reset;
 *   2. a fresh deletion a member without the lease names is deferred, and the
 *      rows of the same page still land;
 *   3. the restorer's own tombstone settles the dispute without the lease and
 *      without a reset;
 *   4. with no tombstones at all, the holder's corroborated omissions delete
 *      through the sweep once — as the holder's verdict — and reset every
 *      member once; the restored rows are disputed, further sweeps leave them,
 *      one restorer omission never settles, and spaced ones past the age do;
 *   5. a gateway restart in the middle of corroboration keeps the count;
 *   6. a detached restorer closes its dispute; the holder's next tombstone
 *      lands with nobody to reset, and no unrelated row is ever touched;
 *   7. after a lease hand-over the new holder is a restorer, and its own
 *      corroborated omissions settle its dispute;
 *   8. an absence a detached member's snapshots earned still deletes when
 *      swept, but carries nobody's verdict.
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const SOURCE = "notes-synth:shared@example.com";
const PROVIDER = "notes-synth";
const TABLE = "replica_counters";
const NAMESPACE = `analytics:${TABLE}`;
const MIN_OBSERVATIONS = 3;
/**
 * Wide enough that one multi-request tick (begin, page, cursor, snapshot)
 * fits inside the derived spacing even under load, so a back-to-back snapshot
 * is reliably "too soon" to count.
 */
const MIN_AGE_MS = 300;
/**
 * Comfortably past the spacing the policy derives (age / observations); load
 * can only widen the gaps. Spread over the observations after the first so
 * the last of `MIN_OBSERVATIONS` spaced snapshots also clears the age floor.
 */
const SPACING_MS = Math.floor(MIN_AGE_MS / (MIN_OBSERVATIONS - 1)) + 15;

const schema = {
  tableName: TABLE,
  displayName: "Replica counters",
  description: "Synthetic counters shared by two replicas",
  columns: [
    { name: "id", type: "VARCHAR", description: "Counter id" },
    { name: "value", type: "INTEGER", description: "Counter value" },
  ],
  primaryKey: ["id"],
};

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
const finish = (c: PairedCollector, writeEpoch: number) =>
  asDevice<{ ok: boolean }>(c, `/sync-state/${encodeURIComponent(SOURCE)}`, {
    method: "POST",
    body: JSON.stringify({ cursor: { at: Date.now() }, writeEpoch }),
  });
const state = (c: PairedCollector) =>
  asDevice<{ lastSyncedAt: string | null; wipeEpoch: number }>(
    c,
    `/sync-state/${encodeURIComponent(SOURCE)}`,
  );

interface IngestResult {
  ingested: number;
  deleted: number;
  deletionDisputed?: number;
  deletionDeferred?: true;
  absence?: { marked: number; absent: number };
}
interface Tick {
  page?: IngestResult;
  snapshot?: IngestResult;
}
/** One collector tick: rows and tombstones on a fresh epoch, the cursor, then the snapshot. */
const tick = async (
  c: PairedCollector,
  body: {
    rows?: readonly string[];
    deletedIds?: readonly string[];
    presentIds?: readonly string[];
  },
): Promise<Tick> => {
  const writeEpoch = await begin(c);
  const out: Tick = {};
  if ((body.rows?.length ?? 0) > 0 || (body.deletedIds?.length ?? 0) > 0) {
    out.page = await asDevice<IngestResult>(c, "/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: TABLE,
        sourceId: SOURCE,
        schema,
        records: (body.rows ?? []).map((id) => ({ id, value: 1 })),
        ...(body.deletedIds ? { deletedIds: body.deletedIds } : {}),
        writeEpoch,
      }),
    });
  }
  await finish(c, writeEpoch);
  if (body.presentIds) {
    out.snapshot = await asDevice<IngestResult>(c, "/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: TABLE,
        sourceId: SOURCE,
        records: [],
        presentIds: body.presentIds,
        observationId: randomUUID(),
        writeEpoch,
      }),
    });
  }
  return out;
};

type View = Set<string>;

describe("replicated analytics dispute across collectors", () => {
  let harness: MultiCollectorHarness;
  let alpha: PairedCollector;
  let beta: PairedCollector;
  let gamma: PairedCollector;
  const viewA: View = new Set();
  const viewB: View = new Set();

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
  const nameOf = (deviceId: string): string =>
    [alpha, beta, gamma].find((c) => c?.deviceId === deviceId)?.name ?? deviceId;
  const verdicts = (id: string): string[] =>
    readDb((db) =>
      db
        .prepare<[string, string, string], { device_id: string; role: string; omissions: number }>(
          "SELECT device_id, role, omissions FROM replica_deletion_claims WHERE namespace = ? AND source_id = ? AND external_id = ?",
        )
        .all(NAMESPACE, SOURCE, id)
        .map((r) => `${nameOf(r.device_id)}:${r.role}:${r.omissions}`)
        .sort(),
    );
  const held = async (): Promise<string[]> =>
    (
      await harness.json<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({ sql: `SELECT id FROM ${TABLE} ORDER BY id` }),
      })
    ).rows.map((row) => String(row[0]));
  const disputedOnSource = async () =>
    (
      await harness.json<{ items: Array<{ id: string; disputedDeletions: number }> }>(
        "/admin/sources",
      )
    ).items.find((s) => s.id === SOURCE)?.disputedDeletions;
  const memberStatus = async (c: PairedCollector) =>
    (
      await harness.json<{ members?: Array<{ deviceId: string; restoredClaims?: number }> }>(
        `/admin/sync/status/${encodeURIComponent(SOURCE)}`,
      )
    ).members?.find((m) => m.deviceId === c.deviceId);
  /** One sweep cycle: the task alternates the document and analytics planes. */
  const sweep = async () => {
    for (let i = 0; i < 2; i += 1) {
      await harness.json("/admin/background/run/absence.sweep", { method: "POST" });
    }
  };
  const isReset = async (c: PairedCollector) => (await state(c)).lastSyncedAt === null;
  /** A member's bootstrap after a reset: its whole replica plus its snapshot on a fresh epoch. */
  const bootstrap = async (c: PairedCollector, view: View) => {
    const result = await tick(c, { rows: [...view], presentIds: [...view] });
    expect(result.page?.ingested).toBe(view.size);
    expect(await isReset(c)).toBe(false);
    return result;
  };
  /** `MIN_OBSERVATIONS` spaced snapshot ticks from one member, then past the age floor. */
  const corroborate = async (c: PairedCollector, view: View) => {
    const started = Date.now();
    const results: Tick[] = [];
    for (let i = 0; i < MIN_OBSERVATIONS; i += 1) {
      if (i > 0) await sleep(SPACING_MS);
      results.push(await tick(c, { presentIds: [...view] }));
    }
    const elapsed = Date.now() - started;
    if (elapsed < MIN_AGE_MS + 5) await sleep(MIN_AGE_MS + 5 - elapsed);
    return results;
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
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

  test("1. the holder's tombstone deletes and resets once; the sibling's restore is a dispute", async () => {
    for (const id of ["c-1", "c-2"]) viewA.add(id);
    for (const id of ["c-1", "c-2", "c-3", "c-4"]) viewB.add(id);
    expect(await claim(alpha)).toMatchObject({ granted: true });
    await tick(alpha, { rows: [...viewA], presentIds: [...viewA] });
    // The sibling contributes its whole replica; as a non-holder its
    // snapshot is not reconciled, its rows are kept.
    const joined = await tick(beta, { rows: [...viewB], presentIds: [...viewB] });
    expect(joined.page).toMatchObject({ ingested: 4 });
    expect(joined.snapshot).not.toHaveProperty("absence");
    expect(await held()).toEqual(["c-1", "c-2", "c-3", "c-4"]);
    expect(await disputedOnSource()).toBe(0);

    // Cycle one: the holder's tombstone deletes c-3 and resets the sibling.
    const first = await tick(alpha, { deletedIds: ["c-3"] });
    expect(first.page).toMatchObject({ deleted: 1 });
    expect(await held()).toEqual(["c-1", "c-2", "c-4"]);
    expect(await isReset(beta)).toBe(true);
    expect(await isReset(alpha)).toBe(false);
    expect(verdicts("c-3")).toEqual(["alpha:deleted:0"]);

    // The sibling bootstraps and puts c-3 back: disputed.
    await bootstrap(beta, viewB);
    expect(await held()).toEqual(["c-1", "c-2", "c-3", "c-4"]);
    expect(verdicts("c-3")).toEqual(["alpha:deleted:0", "beta:restored:0"]);
    expect(await disputedOnSource()).toBe(1);
    expect(await memberStatus(beta)).toMatchObject({ restoredClaims: 1 });
    expect(await memberStatus(alpha)).not.toHaveProperty("restoredClaims");

    // Two more holder tombstones: recorded, stripped, nobody reset, no churn.
    const betaEpoch = (await state(beta)).wipeEpoch;
    for (let round = 0; round < 2; round += 1) {
      const repeat = await tick(alpha, { deletedIds: ["c-3"] });
      expect(repeat.page).toMatchObject({ deleted: 0, deletionDisputed: 1 });
      expect(repeat.page).not.toHaveProperty("deletionDeferred");
      expect(await isReset(beta)).toBe(false);
      expect((await state(beta)).wipeEpoch).toBe(betaEpoch);
    }
    expect(await held()).toEqual(["c-1", "c-2", "c-3", "c-4"]);
    expect(await disputedOnSource()).toBe(1);
  }, 60_000);

  test("2. a fresh deletion the non-holder names is deferred; its rows still land", async () => {
    viewB.add("c-5");
    const result = await tick(beta, { rows: ["c-5"], deletedIds: ["c-4"] });
    expect(result.page).toMatchObject({ ingested: 1, deleted: 0, deletionDeferred: true });
    expect(await held()).toEqual(["c-1", "c-2", "c-3", "c-4", "c-5"]);
    expect(verdicts("c-4")).toEqual([]);
    expect(await isReset(alpha)).toBe(false);
  }, 30_000);

  test("3. the restorer's own tombstone settles the dispute: no lease, no reset", async () => {
    viewB.delete("c-3");
    const alphaSynced = (await state(alpha)).lastSyncedAt;
    const settle = await tick(beta, { deletedIds: ["c-3"] });
    expect(settle.page).toMatchObject({ deleted: 1 });
    expect(settle.page).not.toHaveProperty("deletionDeferred");
    expect(settle.page).not.toHaveProperty("deletionDisputed");
    expect(await held()).toEqual(["c-1", "c-2", "c-4", "c-5"]);
    expect(verdicts("c-3")).toEqual(["alpha:deleted:0", "beta:deleted:0"]);
    expect((await state(alpha)).lastSyncedAt).toBe(alphaSynced);
    expect(await disputedOnSource()).toBe(0);
    expect(await memberStatus(beta)).not.toHaveProperty("restoredClaims");
  }, 30_000);

  test("4. snapshots alone: the sweep deletes once as the holder's verdict; restorers settle by corroborated omission", async () => {
    // The holder never lists c-4 and c-5. Its corroborated omissions delete
    // them through the sweep, reset every member, and record its verdict.
    const results = await corroborate(alpha, viewA);
    for (const result of results) expect(result.snapshot?.absence?.absent).toBe(2);
    expect(await held()).toEqual(["c-1", "c-2", "c-4", "c-5"]);
    await sweep();
    expect(await held()).toEqual(["c-1", "c-2"]);
    expect(await isReset(alpha)).toBe(true);
    expect(await isReset(beta)).toBe(true);
    expect(verdicts("c-4")).toEqual(["alpha:deleted:0"]);
    expect(verdicts("c-5")).toEqual(["alpha:deleted:0"]);

    // Both bootstrap; the sibling's replica still holds c-4 and c-5.
    await bootstrap(alpha, viewA);
    await bootstrap(beta, viewB);
    expect(await held()).toEqual(["c-1", "c-2", "c-4", "c-5"]);
    expect(verdicts("c-4")).toEqual(["alpha:deleted:0", "beta:restored:0"]);
    expect(await disputedOnSource()).toBe(2);

    // The holder keeps omitting them: further sweeps delete nothing and
    // reset nobody.
    await corroborate(alpha, viewA);
    await sweep();
    expect(await held()).toEqual(["c-1", "c-2", "c-4", "c-5"]);
    expect(await isReset(alpha)).toBe(false);
    expect(await isReset(beta)).toBe(false);
    expect(await disputedOnSource()).toBe(2);

    // The restorer's replica loses c-4. One omission is not a verdict; a
    // second too soon does not count; naming it again starts over.
    viewB.delete("c-4");
    const once = await tick(beta, { presentIds: [...viewB] });
    expect(once.snapshot).toMatchObject({ deleted: 0 });
    expect(verdicts("c-4")).toEqual(["alpha:deleted:0", "beta:restored:1"]);
    await tick(beta, { presentIds: [...viewB] });
    expect(verdicts("c-4")).toEqual(["alpha:deleted:0", "beta:restored:1"]);
    viewB.add("c-4");
    await tick(beta, { presentIds: [...viewB] });
    expect(verdicts("c-4")).toEqual(["alpha:deleted:0", "beta:restored:0"]);
    expect(await held()).toEqual(["c-1", "c-2", "c-4", "c-5"]);

    // Spaced omissions past the age settle c-4 — without the lease, without a
    // reset; c-5, still named, stays disputed.
    viewB.delete("c-4");
    const settled = await corroborate(beta, viewB);
    expect(settled.at(-1)?.snapshot).toMatchObject({ deleted: 1 });
    expect(await held()).toEqual(["c-1", "c-2", "c-5"]);
    expect(verdicts("c-4")).toEqual(["alpha:deleted:0", "beta:deleted:0"]);
    expect(verdicts("c-5")).toEqual(["alpha:deleted:0", "beta:restored:0"]);
    expect(await isReset(alpha)).toBe(false);
    expect(await isReset(beta)).toBe(false);
    expect(await disputedOnSource()).toBe(1);
  }, 120_000);

  test("5. a gateway restart mid-corroboration keeps the count", async () => {
    viewB.delete("c-5");
    await tick(beta, { presentIds: [...viewB] });
    expect(verdicts("c-5")).toEqual(["alpha:deleted:0", "beta:restored:1"]);

    await harness.restartGateway();
    expect(await claim(alpha)).toMatchObject({ granted: true });
    expect(verdicts("c-5")).toEqual(["alpha:deleted:0", "beta:restored:1"]);
    expect(await held()).toEqual(["c-1", "c-2", "c-5"]);

    await sleep(SPACING_MS);
    await tick(beta, { presentIds: [...viewB] });
    expect(verdicts("c-5")).toEqual(["alpha:deleted:0", "beta:restored:2"]);
    await sleep(Math.max(SPACING_MS, MIN_AGE_MS + 5));
    const last = await tick(beta, { presentIds: [...viewB] });
    expect(last.snapshot).toMatchObject({ deleted: 1 });
    expect(await held()).toEqual(["c-1", "c-2"]);
    expect(verdicts("c-5")).toEqual(["alpha:deleted:0", "beta:deleted:0"]);
    expect(await disputedOnSource()).toBe(0);
  }, 60_000);

  test("6. a detached restorer closes its dispute; the next tombstone lands with nobody to reset", async () => {
    // A fresh deletion by the holder, restored by the sibling's bootstrap.
    viewB.add("c-6");
    const betaEpoch = (await state(beta)).wipeEpoch;
    await tick(beta, { rows: ["c-6"] });
    expect(await held()).toEqual(["c-1", "c-2", "c-6"]);
    expect((await tick(alpha, { deletedIds: ["c-6"] })).page).toMatchObject({ deleted: 1 });
    expect(await isReset(beta)).toBe(true);
    expect((await state(beta)).wipeEpoch).toBeGreaterThan(betaEpoch);
    await bootstrap(beta, viewB);
    expect(await held()).toEqual(["c-1", "c-2", "c-6"]);
    expect((await tick(alpha, { deletedIds: ["c-6"] })).page).toMatchObject({
      deleted: 0,
      deletionDisputed: 1,
    });
    expect(await disputedOnSource()).toBe(1);

    await harness.json(
      `/admin/sources/${encodeURIComponent(SOURCE)}/members/${encodeURIComponent(beta.deviceId)}`,
      { method: "DELETE" },
    );
    // Detaching deletes nothing; the dispute is closed.
    expect(await held()).toEqual(["c-1", "c-2", "c-6"]);
    expect(await disputedOnSource()).toBe(0);
    expect(verdicts("c-6")).toEqual(["alpha:deleted:0"]);

    // The only replica left says the row is gone, and there is nobody to reset.
    expect((await tick(alpha, { deletedIds: ["c-6"] })).page).toMatchObject({ deleted: 1 });
    expect(await held()).toEqual(["c-1", "c-2"]);
    expect(await isReset(alpha)).toBe(false);
  }, 60_000);

  test("7. after a hand-over the new holder is a restorer; its own corroborated omissions settle its dispute", async () => {
    gamma = await join("gamma");
    const viewG = new Set(["c-1", "c-2", "c-7"]);
    await tick(gamma, { rows: [...viewG], presentIds: [...viewG] });
    expect(await held()).toEqual(["c-1", "c-2", "c-7"]);
    // The holder deletes the row gamma's replica holds; gamma restores it.
    expect((await tick(alpha, { deletedIds: ["c-7"] })).page).toMatchObject({ deleted: 1 });
    expect(await isReset(gamma)).toBe(true);
    await bootstrap(gamma, viewG);
    expect(verdicts("c-7")).toEqual(["alpha:deleted:0", "gamma:restored:0"]);
    expect(await disputedOnSource()).toBe(1);

    // Hand-over: gamma now holds the lease — holder and restorer at once.
    await release(alpha);
    expect(await claim(gamma)).toMatchObject({ granted: true });

    // Its replica loses the row. Its snapshots are now reconciled AND count
    // on its restored row; the matured omission is its verdict and settles
    // the dispute without resetting anyone.
    viewG.delete("c-7");
    const results = await corroborate(gamma, viewG);
    expect(results.at(-1)?.snapshot).toMatchObject({ deleted: 1 });
    expect(await held()).toEqual(["c-1", "c-2"]);
    expect(verdicts("c-7")).toEqual(["alpha:deleted:0", "gamma:deleted:0"]);
    expect(await isReset(alpha)).toBe(false);
    expect(await disputedOnSource()).toBe(0);
  }, 120_000);

  test("8. a detached observer's earned absences carry no verdict when swept", async () => {
    // gamma, holding the lease, stops naming c-2: three spaced snapshots
    // mark the absence in its name — then it detaches before the sweep acts.
    await corroborate(gamma, new Set(["c-1"]));
    expect(await held()).toEqual(["c-1", "c-2"]);
    await harness.json(
      `/admin/sources/${encodeURIComponent(SOURCE)}/members/${encodeURIComponent(gamma.deviceId)}`,
      { method: "DELETE" },
    );
    await sweep();
    // The corroborated absence still deletes and still resets the survivor,
    // but no verdict is recorded in the departed device's name.
    expect(await held()).toEqual(["c-1"]);
    expect(verdicts("c-2")).toEqual([]);
    expect(await isReset(alpha)).toBe(true);

    // The survivor's bootstrap restores the row as a plain contribution — no
    // ghost to dispute, nothing flagged.
    await bootstrap(alpha, new Set(["c-1", "c-2"]));
    expect(await held()).toEqual(["c-1", "c-2"]);
    expect(verdicts("c-2")).toEqual([]);
    expect(await disputedOnSource()).toBe(0);
  }, 120_000);
});
