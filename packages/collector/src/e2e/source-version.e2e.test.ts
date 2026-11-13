// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every stored document carries the version of the source that wrote it.
 *
 * A host sends its source's version with each sync page and the gateway keeps,
 * per document, the highest version it was written or re-read at. These suites
 * drive real collectors against a spawned gateway and move a host between
 * builds with `setSourceVersion`, which is the only thing a real upgrade
 * changes about a page:
 *
 * - one account read at no version, then partly at version 1 and partly at
 *   version 2, with a re-read of unchanged documents raising their version
 *   while their ids and `updated_at` stay what they were;
 * - a source's own declared version reaching its documents, cursor row and
 *   first enumeration without any override, on both the document and the
 *   structured page route;
 * - two hosts of one replicated source on different builds, where the older
 *   one never lowers what the newer one wrote, and two hosts of a partitioned
 *   source whose streams keep their own versions.
 */

import "./synth-env.js";
import SqliteDatabase from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { countDocumentsBySourceVersion } from "@omnesis/gateway/src/data/repositories/DocumentRepository.js";
import { loadSourceFixtureJson, loadUniverse } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";

type Db = Parameters<typeof countDocumentsBySourceVersion>[0];

interface StoredDocument {
  id: string;
  external_id: string;
  updated_at: string;
  source_version: number;
}

/** A read of the gateway's document store; nothing here is served over HTTP. */
function withStore<T>(harness: SyntheticE2EHarness, read: (db: Db) => T): T {
  const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
  try {
    return read(db as unknown as Db);
  } finally {
    db.close();
  }
}

function documentsOf(
  harness: SyntheticE2EHarness,
  sourceId: string,
  streamId = "",
): StoredDocument[] {
  return withStore(harness, (db) =>
    db
      .prepare<[string, string], StoredDocument>(
        `SELECT id, external_id, updated_at, source_version FROM documents
          WHERE source_id = ? AND stream_id = ? ORDER BY external_id`,
      )
      .all(sourceId, streamId),
  );
}

/** What must not change when a re-read finds a document as it was. */
const identity = (documents: StoredDocument[]) =>
  documents.map(({ id, external_id, updated_at }) => ({ id, external_id, updated_at }));

function cursorRow(
  harness: SyntheticE2EHarness,
  sourceId: string,
  deviceId = "",
): { source_version: number } | undefined {
  return withStore(harness, (db) =>
    db
      .prepare<[string, string], { source_version: number }>(
        "SELECT source_version FROM sync_state WHERE source_id = ? AND device_id = ?",
      )
      .get(sourceId, deviceId),
  );
}

describe("source version — one account across builds (default universe)", () => {
  const NOTES = "apple-notes:john.smith@icloud.example";
  const TASKS = "things:local";
  const CALENDAR = "google-calendar:john.smith@example.com";
  const NOTE_COUNT = loadSourceFixtureJson<unknown[]>(
    loadUniverse("default"),
    "apple-notes",
    "notes.json",
  ).length;
  const HALF = Math.floor(NOTE_COUNT / 2);

  let harness: SyntheticE2EHarness;
  let host: HarnessDevice;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "default" });
    await harness.start();
    host = harness.deviceForSource(NOTES);
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 30_000);

  /** Send the host back to `offset` of the source, keeping every stored document. */
  async function rereadFrom(offset: number): Promise<void> {
    const headers = {
      Authorization: `Bearer ${host.token}`,
      "Content-Type": "application/json",
    };
    const path = `${harness.gatewayUrl}/sync-state/${encodeURIComponent(NOTES)}`;
    const state = (await (await fetch(path, { headers })).json()) as { wipeEpoch?: number };
    const response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ cursor: { offset }, writeEpoch: state.wipeEpoch }),
    });
    expect(await response.json()).toEqual({ ok: true });
  }

  const counts = (sourceId: string) =>
    withStore(harness, (db) => countDocumentsBySourceVersion(db, sourceId));

  test("an account ends up part old and part new, and a re-read raises versions in place", async () => {
    expect(NOTE_COUNT).toBeGreaterThanOrEqual(4);

    // A host on a build that predates versions reads the whole account.
    harness.setSourceVersion(NOTES, undefined);
    await harness.triggerSyncAndWait(NOTES, 60_000);
    const original = documentsOf(harness, NOTES);
    expect(original).toHaveLength(NOTE_COUNT);
    expect(counts(NOTES)).toEqual([{ sourceVersion: 0, count: NOTE_COUNT }]);
    expect(cursorRow(harness, NOTES)).toEqual({ source_version: 0 });

    // Upgraded to version 1, it re-reads the second half: nothing changed
    // upstream, so every document comes back exactly as stored.
    harness.setSourceVersion(NOTES, 1);
    await rereadFrom(HALF);
    await harness.triggerSyncAndWait(NOTES, 60_000);
    expect(counts(NOTES)).toEqual([
      { sourceVersion: 0, count: HALF },
      { sourceVersion: 1, count: NOTE_COUNT - HALF },
    ]);
    expect(identity(documentsOf(harness, NOTES))).toEqual(identity(original));
    expect(cursorRow(harness, NOTES)).toEqual({ source_version: 1 });

    // A whole re-read at version 1 leaves no document behind at 0.
    await rereadFrom(0);
    await harness.triggerSyncAndWait(NOTES, 60_000);
    expect(counts(NOTES)).toEqual([{ sourceVersion: 1, count: NOTE_COUNT }]);

    // Upgraded again, it re-reads half: the account is half 1, half 2.
    harness.setSourceVersion(NOTES, 2);
    await rereadFrom(HALF);
    await harness.triggerSyncAndWait(NOTES, 60_000);
    const halfOld = [
      { sourceVersion: 1, count: HALF },
      { sourceVersion: 2, count: NOTE_COUNT - HALF },
    ];
    expect(counts(NOTES)).toEqual(halfOld);

    // Put back on the older build, a whole re-read lowers nothing.
    harness.setSourceVersion(NOTES, 1);
    await rereadFrom(0);
    await harness.triggerSyncAndWait(NOTES, 60_000);
    expect(counts(NOTES)).toEqual(halfOld);
    expect(cursorRow(harness, NOTES)).toEqual({ source_version: 1 });

    // Through all of it no document was replaced or touched.
    const final = documentsOf(harness, NOTES);
    expect(identity(final)).toEqual(identity(original));
    // Each document whose version rose is queued once for whoever keeps a
    // copy of it; that is every document of the account.
    const queued = withStore(harness, (db) =>
      db
        .prepare<[string], { id: string }>(
          `SELECT q.document_id AS id FROM document_filter_index_queue q
             JOIN documents d ON d.id = q.document_id WHERE d.source_id = ? ORDER BY 1`,
        )
        .all(NOTES)
        .map((row) => row.id),
    );
    expect(queued).toEqual(final.map((document) => document.id).sort());
  }, 300_000);

  test("a source's declared version reaches its documents, cursor row and first enumeration", async () => {
    await harness.triggerSyncAndWait(TASKS, 60_000);

    const tasks = counts(TASKS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.sourceVersion).toBe(1);
    expect(tasks[0]?.count).toBeGreaterThan(0);
    expect(cursorRow(harness, TASKS)).toEqual({ source_version: 1 });
    const inventories = withStore(harness, (db) =>
      db
        .prepare<[string], { min_source_version: number | null; completed: number }>(
          `SELECT min_source_version, completed_at IS NOT NULL AS completed
             FROM source_inventories WHERE source_id = ?`,
        )
        .all(TASKS),
    );
    expect(inventories).toEqual([{ min_source_version: 1, completed: 1 }]);
  }, 120_000);

  test("a source that writes rows and documents together sends its version the same way", async () => {
    await harness.triggerSyncAndWait(CALENDAR, 60_000);

    const events = counts(CALENDAR);
    expect(events).toHaveLength(1);
    expect(events[0]?.sourceVersion).toBe(1);
    expect(events[0]?.count).toBeGreaterThan(0);
    expect(cursorRow(harness, CALENDAR)).toEqual({ source_version: 1 });
  }, 120_000);

  test("a pushed document has no version", async () => {
    await harness.pushDocument({
      sourceId: "push-notes:studio",
      providerId: "push-notes:studio",
      externalId: "pushed-1",
      title: "Venue walkthrough",
      content: "Walkthrough notes for the venue booking.",
    });

    expect(counts("push-notes:studio")).toEqual([{ sourceVersion: 0, count: 1 }]);
  }, 60_000);
});

describe("source version — several hosts of one source (replicated universe)", () => {
  const TASKS = "things:local";
  const SCREEN_TIME = "screen-time:john.smith@icloud.example";

  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "replicated" });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 30_000);

  const counts = (sourceId: string, streamId?: string) =>
    withStore(harness, (db) => countDocumentsBySourceVersion(db, sourceId, streamId));

  test("replicated: the host on the older build never lowers what the newer one wrote", async () => {
    const [newer, older] = harness.devicesForSource(TASKS) as [HarnessDevice, HarnessDevice];
    harness.setSourceVersion(TASKS, 2, newer);
    harness.setSourceVersion(TASKS, 1, older);

    await harness.triggerSyncAndWait(TASKS, 90_000, older);
    const written = documentsOf(harness, TASKS);
    expect(written.length).toBeGreaterThan(0);
    expect(counts(TASKS)).toEqual([{ sourceVersion: 1, count: written.length }]);

    // The newer host holds the same replica: its read changes no document and
    // raises every version.
    await harness.triggerSyncAndWait(TASKS, 90_000, newer);
    const raised = [{ sourceVersion: 2, count: written.length }];
    expect(counts(TASKS)).toEqual(raised);
    expect(identity(documentsOf(harness, TASKS))).toEqual(identity(written));

    // The older host is sent back to the start and reads everything again.
    await harness.gatewayJson(`/admin/sources/${encodeURIComponent(TASKS)}/resync`, {
      method: "POST",
      body: JSON.stringify({ deviceId: older.deviceId }),
    });
    await harness.triggerSyncAndWait(TASKS, 90_000, older);

    expect(counts(TASKS)).toEqual(raised);
    expect(identity(documentsOf(harness, TASKS))).toEqual(identity(written));
    expect(cursorRow(harness, TASKS, newer.deviceId)).toEqual({ source_version: 2 });
    expect(cursorRow(harness, TASKS, older.deviceId)).toEqual({ source_version: 1 });
  }, 300_000);

  test("partitioned: each host's stream carries the version of the build that host runs", async () => {
    const [first, second] = harness.devicesForSource(SCREEN_TIME) as [HarnessDevice, HarnessDevice];
    harness.setSourceVersion(SCREEN_TIME, 2, first);
    harness.setSourceVersion(SCREEN_TIME, undefined, second);

    await harness.triggerSyncAndWait(SCREEN_TIME, 90_000, first);
    await harness.triggerSyncAndWait(SCREEN_TIME, 90_000, second);

    const inFirst = documentsOf(harness, SCREEN_TIME, first.deviceId).length;
    const inSecond = documentsOf(harness, SCREEN_TIME, second.deviceId).length;
    expect(inFirst).toBeGreaterThan(0);
    expect(inSecond).toBeGreaterThan(0);
    expect(counts(SCREEN_TIME, first.deviceId)).toEqual([{ sourceVersion: 2, count: inFirst }]);
    expect(counts(SCREEN_TIME, second.deviceId)).toEqual([{ sourceVersion: 0, count: inSecond }]);
    expect(counts(SCREEN_TIME)).toEqual([
      { sourceVersion: 0, count: inSecond },
      { sourceVersion: 2, count: inFirst },
    ]);
    expect(cursorRow(harness, SCREEN_TIME, first.deviceId)).toEqual({ source_version: 2 });
    expect(cursorRow(harness, SCREEN_TIME, second.deviceId)).toEqual({ source_version: 0 });
  }, 300_000);
});
