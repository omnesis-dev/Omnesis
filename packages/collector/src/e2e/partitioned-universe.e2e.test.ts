// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Partitioned sources: every device contributes its own stream.
 *
 * The `partitioned` universe puts two Android phones on one call-log source
 * declared `partitioned`. Both phones push the same day-rollup external ids
 * (each phone names its days the same way), so without streams the second
 * phone's snapshot would delete the first phone's days and the two would
 * oscillate forever. With a stream per contributing device the union is
 * the corpus: each phone's documents live in its own stream, a phone's
 * snapshot only reconciles its own stream, and a phone's "already indexed?"
 * check sees only its own documents.
 */
import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { loadSourceFixtureJson, loadUniverse } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";
import { getDocumentCount } from "./helpers.js";

const UNIVERSE = "partitioned";
const CALL_LOG = "android-call-log:android-synth-johnsmith";
const HEALTH = "health-connect:android-synth-johnsmith";
const FIXTURE_COUNT = loadSourceFixtureJson<unknown[]>(
  loadUniverse(UNIVERSE),
  "android-call-log",
  "calls.json",
).length;

describe("partitioned universe — one stream per phone", () => {
  let harness: SyntheticE2EHarness;
  let phones: readonly HarnessDevice[];

  const asDevice = async <T>(
    device: HarnessDevice,
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    const res = await fetch(`${harness.gatewayUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${device.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok)
      throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };
  const count = () => getDocumentCount(harness.gatewayUrl, harness.apiKey, CALL_LOG);
  /** Bootstrap a phone again: clear its own cursor row, then sync it. */
  const resync = async (phone: HarnessDevice) => {
    // The cursor write is fenced by the row's write epoch, like a page.
    const { wipeEpoch } = await asDevice<{ wipeEpoch: number }>(
      phone,
      `/sync-state/${encodeURIComponent(CALL_LOG)}`,
    );
    const reset = await asDevice<{ ok: boolean }>(
      phone,
      `/sync-state/${encodeURIComponent(CALL_LOG)}`,
      { method: "POST", body: JSON.stringify({ cursor: {}, writeEpoch: wipeEpoch }) },
    );
    expect(reset).toEqual({ ok: true });
    await harness.triggerSyncAndWait(CALL_LOG, 60_000, phone);
  };
  /** The external ids a phone already holds in its own stream. */
  const ownIds = async (phone: HarnessDevice, externalIds: string[]) =>
    (
      await asDevice<{ existingIds: string[] }>(phone, "/documents/exists", {
        method: "POST",
        body: JSON.stringify({ providerId: CALL_LOG, sourceId: CALL_LOG, externalIds }),
      })
    ).existingIds.sort();

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: UNIVERSE,
      // A snapshot's omissions carry a deadline. These tests are about which
      // stream a snapshot is entitled to reach, not about how long the deadline
      // is, so the evidence floor is compressed to one observation. The
      // gateway's independent post-boot deletion grace deliberately remains in
      // force; the focused snapshot-absence suite covers expiry.
      extraGatewayConfig: {
        gateway: { snapshotAbsence: { minObservations: 1, minAge: "1ms" } },
      },
    });
    await harness.start();
    phones = harness.devicesForSource(CALL_LOG);
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("both phones host the source as members of a partitioned source", async () => {
    expect(phones.map((d) => d.rosterId)).toEqual(["pixel", "pixel-old"]);
    const { items } = await harness.gatewayJson<{
      items: Array<{ id: string; members?: string[]; multiDeviceMode?: string }>;
    }>("/admin/sources");
    const row = items.find((s) => s.id === CALL_LOG);
    expect(row?.multiDeviceMode).toBe("partitioned");
    expect(row?.members).toEqual(phones.map((d) => d.deviceId));
  });

  test("each phone's days land in its own stream: the union is the corpus and neither snapshot touches the other", async () => {
    const [first, second] = phones as [HarnessDevice, HarnessDevice];
    await harness.triggerSyncAndWait(CALL_LOG, 60_000, first);
    expect(await count()).toBe(FIXTURE_COUNT);
    // The second phone names its days exactly like the first; its final
    // page carries its complete snapshot, which reconciles its stream only.
    await harness.triggerSyncAndWait(CALL_LOG, 60_000, second);
    expect(await count()).toBe(FIXTURE_COUNT * 2);
    // A phone bootstrapping again re-pushes its days onto its own stream and
    // its final snapshot reconciles that stream only: nothing changes.
    await resync(first);
    expect(await count()).toBe(FIXTURE_COUNT * 2);
  }, 180_000);

  test("a structured source keeps one stream per phone too: rows double, and a phone's deletes and snapshots stay in its stream", async () => {
    const phones = harness.devicesForSource(HEALTH);
    expect(phones.map((d) => d.rosterId)).toEqual(["pixel", "pixel-old"]);
    const [first, second] = phones as [HarnessDevice, HarnessDevice];
    const sql = async (query: string) =>
      (
        await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
          method: "POST",
          body: JSON.stringify({ sql: query }),
        })
      ).rows;
    const rows = async () => Number((await sql("SELECT COUNT(*) FROM hc_body"))[0]?.[0] ?? 0);

    await harness.triggerSyncAndWait(HEALTH, 90_000, first);
    const fromOnePhone = await rows();
    expect(fromOnePhone).toBeGreaterThan(0);
    // The second phone's rows carry the same ids as the first's; each phone's
    // stream keeps its own copy.
    await harness.triggerSyncAndWait(HEALTH, 90_000, second);
    expect(await rows()).toBe(fromOnePhone * 2);
    expect(Number((await sql("SELECT COUNT(DISTINCT _stream_id) FROM hc_body"))[0]?.[0])).toBe(2);

    // A page from one phone that tombstones one id removes that phone's row only.
    const someId = String((await sql("SELECT id FROM hc_body ORDER BY id LIMIT 1"))[0]?.[0]);
    const ingest = (phone: HarnessDevice, body: Record<string, unknown>) =>
      asDevice<{ ingested: number; deleted: number; absence?: { absent: number; marked: number } }>(
        phone,
        "/analytics/ingest",
        {
          method: "POST",
          body: JSON.stringify({ tableName: "hc_body", sourceId: HEALTH, records: [], ...body }),
        },
      );
    expect(await ingest(first, { deletedIds: [someId] })).toMatchObject({ deleted: 1 });
    expect(await rows()).toBe(fromOnePhone * 2 - 1);
    expect(Number((await sql(`SELECT COUNT(*) FROM hc_body WHERE id = '${someId}'`))[0]?.[0])).toBe(
      1,
    );

    // A phone's empty snapshot records its own stream's rows as absent and
    // nothing else. The post-boot deletion grace keeps both streams standing;
    // the response count proves only the second phone's stream was marked.
    expect(await ingest(second, { presentIds: [] })).toMatchObject({
      deleted: 0,
      absence: { absent: fromOnePhone, marked: fromOnePhone },
    });
    expect(
      await sql(
        "SELECT stream_id, COUNT(*) FROM _analytics_absences " +
          `WHERE source_id = '${HEALTH}' AND table_name = 'hc_body' ` +
          "GROUP BY stream_id ORDER BY stream_id",
      ),
    ).toEqual([[second.deviceId, fromOnePhone]]);
    expect(await rows()).toBe(fromOnePhone * 2 - 1);
  }, 240_000);

  test("a phone's snapshot reconciles its own stream only; its 'already indexed' check sees its own documents", async () => {
    const [first, second] = phones as [HarnessDevice, HarnessDevice];
    const externalIds = (
      await harness.gatewayJson<{ documents: Array<{ externalId: string }> }>(
        `/documents/recent/${encodeURIComponent(CALL_LOG)}?limit=200`,
      )
    ).documents.map((d) => d.externalId);
    const distinct = [...new Set(externalIds)].sort();
    expect(distinct).toHaveLength(FIXTURE_COUNT);
    expect(await ownIds(first, distinct)).toEqual(distinct);
    expect(await ownIds(second, distinct)).toEqual(distinct);

    // The first phone's snapshot shrinks to one day: only its other days are
    // recorded absent. During the post-boot deletion grace both streams remain
    // queryable, so the second phone cannot be mistaken for corroborating or
    // destructive evidence about the first.
    const kept = distinct[0]!;
    const reconciled = await asDevice<{ deleted: number; absence?: { absent: number } }>(
      first,
      "/documents/reconcile",
      {
        method: "POST",
        body: JSON.stringify({
          providerId: CALL_LOG,
          sourceId: CALL_LOG,
          presentExternalIds: [kept],
        }),
      },
    );
    expect(reconciled).toMatchObject({ deleted: 0, absence: { absent: FIXTURE_COUNT - 1 } });
    const absenceDb = new Database(harness.getDbPath(), { readonly: true });
    try {
      expect(
        absenceDb
          .prepare<
            [string],
            { stream_id: string; external_id: string }
          >("SELECT stream_id, external_id FROM document_absences WHERE source_id = ? ORDER BY stream_id, external_id")
          .all(CALL_LOG),
      ).toEqual(
        distinct
          .filter((externalId) => externalId !== kept)
          .map((externalId) => ({ stream_id: first.deviceId, external_id: externalId })),
      );
    } finally {
      absenceDb.close();
    }
    expect(await count()).toBe(FIXTURE_COUNT * 2);
    expect(await ownIds(first, distinct)).toEqual(distinct);
    expect(await ownIds(second, distinct)).toEqual(distinct);

    // The first phone deleting its last day deletes its own copy only; a
    // fresh bootstrap brings its days back into its stream.
    await asDevice(first, "/documents/delete", {
      method: "POST",
      body: JSON.stringify({
        providerId: CALL_LOG,
        sourceId: CALL_LOG,
        externalIds: [kept],
      }),
    });
    expect(await ownIds(first, [kept])).toEqual([]);
    expect(await ownIds(second, [kept])).toEqual([kept]);
    await resync(first);
    expect(await count()).toBe(FIXTURE_COUNT * 2);
    expect(await ownIds(first, distinct)).toEqual(distinct);

    // A privacy delete of one phone's day tombstones that phone's stream
    // only: the other phone keeps its day, and the deleting phone's next
    // bootstrap does not bring the day back.
    const firstsDay = (
      await harness.gatewayJson<{ documents: Array<{ id: string; externalId: string }> }>(
        `/documents/recent/${encodeURIComponent(CALL_LOG)}?limit=200`,
      )
    ).documents.find((d) => d.externalId === kept)!;
    const removed = await harness.gatewayFetch(`/documents/${firstsDay.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await count()).toBe(FIXTURE_COUNT * 2 - 1);
    const survivors = [await ownIds(first, [kept]), await ownIds(second, [kept])];
    expect(survivors.filter((s) => s.length === 1)).toHaveLength(1);
    const deletedPhone = survivors[0]!.length === 0 ? first : second;
    await resync(deletedPhone);
    expect(await count()).toBe(FIXTURE_COUNT * 2 - 1);
    expect(await ownIds(deletedPhone, [kept])).toEqual([]);
  }, 180_000);

  test("a per-device resync wipes one phone's stream and cursor; its bootstrap rebuilds the stream while the other phone's is untouched", async () => {
    const [first, second] = phones as [HarnessDevice, HarnessDevice];
    const distinct = [
      ...new Set(
        (
          await harness.gatewayJson<{ documents: Array<{ externalId: string }> }>(
            `/documents/recent/${encodeURIComponent(CALL_LOG)}?limit=200`,
          )
        ).documents.map((d) => d.externalId),
      ),
    ].sort();
    const secondBefore = await ownIds(second, distinct);
    expect(secondBefore.length).toBeGreaterThan(0);

    // The phones sync in-process here, not over a WS connection, so the
    // command reaches nobody; the wipe happens all the same.
    const reset = await harness.gatewayJson<{ ok: boolean; scope: string; deviceIds: string[] }>(
      `/admin/sources/${encodeURIComponent(CALL_LOG)}/resync`,
      { method: "POST", body: JSON.stringify({ deviceId: first.deviceId }) },
    );
    expect(reset).toEqual({
      ok: true,
      scope: "stream",
      deviceIds: [],
      restarting: [],
      disabled: [],
      skipped: [],
    });
    expect(await ownIds(first, distinct)).toEqual([]);
    expect(await ownIds(second, distinct)).toEqual(secondBefore);
    // Its own row is kept with no cursor, so it bootstraps rather than
    // adopting the shared row.
    const state = await asDevice<{ cursor: unknown }>(
      first,
      `/sync-state/${encodeURIComponent(CALL_LOG)}`,
    );
    expect(state.cursor).toBeNull();

    await harness.triggerSyncAndWait(CALL_LOG, 60_000, first);
    // Every day is back, including one a privacy delete had tombstoned:
    // the stream's tombstones went with the stream, as a source's do with a
    // source wipe.
    expect(await ownIds(first, distinct)).toEqual(distinct);
    expect(await ownIds(second, distinct)).toEqual(secondBefore);
    expect(await count()).toBe(FIXTURE_COUNT + secondBefore.length);
  }, 180_000);

  test("detaching a phone removes its stream from every store; the other phone's documents, tombstones and rows stay", async () => {
    const [first, second] = phones as [HarnessDevice, HarnessDevice];
    // The second phone contributes structured rows again — its own snapshot
    // cleared them earlier and its cursor sits past them, so it starts that
    // source over — and gets a privacy tombstone in its stream.
    expect(
      await harness.gatewayJson(`/admin/sources/${encodeURIComponent(HEALTH)}/resync`, {
        method: "POST",
        body: JSON.stringify({ deviceId: second.deviceId }),
      }),
    ).toEqual({
      ok: true,
      scope: "stream",
      deviceIds: [],
      restarting: [],
      disabled: [],
      skipped: [],
    });
    await harness.triggerSyncAndWait(HEALTH, 90_000, second);
    const db = new Database(harness.getDbPath(), { readonly: true });
    const countWhere = (table: string, streamId: string): number =>
      db
        .prepare<
          [string, string],
          { n: number }
        >(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id = ? AND stream_id = ?`)
        .get(CALL_LOG, streamId)!.n;
    const sql = async (query: string) =>
      (
        await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
          method: "POST",
          body: JSON.stringify({ sql: query }),
        })
      ).rows;
    const hcRows = async (streamId: string) =>
      Number(
        (await sql(`SELECT COUNT(*) FROM hc_body WHERE _stream_id = '${streamId}'`))[0]?.[0] ?? 0,
      );
    try {
      const victim = db
        .prepare<
          [string, string],
          { id: string }
        >("SELECT id FROM documents WHERE source_id = ? AND stream_id = ? ORDER BY id LIMIT 1")
        .get(CALL_LOG, second.deviceId)!;
      const secondTombstonesBefore = countWhere("removed_documents", second.deviceId);
      expect(
        (await harness.gatewayFetch(`/documents/${victim.id}`, { method: "DELETE" })).status,
      ).toBe(200);
      expect(countWhere("removed_documents", second.deviceId)).toBe(secondTombstonesBefore + 1);
      const firstDocs = countWhere("documents", first.deviceId);
      const firstTombstones = countWhere("removed_documents", first.deviceId);
      const firstRows = await hcRows(first.deviceId);
      expect(firstDocs).toBe(FIXTURE_COUNT);
      expect(await hcRows(second.deviceId)).toBeGreaterThan(0);

      for (const sourceId of [CALL_LOG, HEALTH]) {
        const detached = await harness.gatewayJson<{ members: string[] }>(
          `/admin/sources/${encodeURIComponent(sourceId)}/members/${second.deviceId}`,
          { method: "DELETE" },
        );
        expect(detached.members).toEqual([first.deviceId]);
      }

      expect(countWhere("documents", second.deviceId)).toBe(0);
      expect(countWhere("removed_documents", second.deviceId)).toBe(0);
      expect(await hcRows(second.deviceId)).toBe(0);
      expect(countWhere("documents", first.deviceId)).toBe(firstDocs);
      expect(countWhere("removed_documents", first.deviceId)).toBe(firstTombstones);
      expect(await hcRows(first.deviceId)).toBe(firstRows);
      expect(await count()).toBe(firstDocs);
    } finally {
      db.close();
    }
  }, 240_000);
});
