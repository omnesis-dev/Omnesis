// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
type Db = Database.Database;

import { createDatabase } from "../../db.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { dayKeyFor } from "./day.js";
import { buildNotesDayDocument } from "./upsert.js";
import { insertNoteEntry, type NoteEntry } from "./storage.js";
import { bootOmnesisNotes, type OmnesisNotesRuntime } from "./wiring.js";
import type { DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("bootOmnesisNotes", () => {
  let dbPath: string;
  let db: Db;
  let gate: WriteGate;
  let runtime: OmnesisNotesRuntime;
  let ingested: DocumentInput[][];
  let deleted: Array<{ providerId: string; sourceId: string; externalIds: string[] }>;

  /** Boot a runtime against the shared db with the standard test stubs. */
  function boot(overrides: { writeGate?: WriteGate } = {}): OmnesisNotesRuntime {
    return bootOmnesisNotes({
      writeGate: overrides.writeGate ?? gate,
      readDb: db,
      ingest: async (docs) => {
        ingested.push(docs);
      },
      // Deletes for real (via the direct gate) so day-doc-drop tests can
      // observe the documents table, while also recording each call.
      deleteByIds: async (providerId, sourceId, externalIds) => {
        deleted.push({ providerId, sourceId, externalIds });
        await gate.deleteDocuments(providerId, sourceId, externalIds);
      },
      debounceMs: 0,
    });
  }

  test("retains authenticated principal metadata through capture and day projection", async () => {
    const captureContext = {
      principalId: "principal-1",
      principalName: "Fictional notebook",
      grantId: "grant-1",
      grantRevision: 1,
      credentialId: "credential-1",
      oauthClientId: "client-1",
      requestId: "request-1",
    };
    const entry = await runtime.capture({
      text: "Plan the fictional garden",
      surface: "mcp",
      captureContext,
    });
    expect(runtime.listDay(entry.day)[0]?.captureContext).toEqual(captureContext);
    await runtime.flushAll();
    const document = ingested.flat().find((doc) => doc.externalId === entry.day);
    expect(document?.content).toContain(" · mcp · Fictional notebook");
    expect(document?.metadata.addressedEntries?.[0]?.captureContext).toEqual(captureContext);
  });

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    gate = directWriteGate(db);
    ingested = [];
    deleted = [];
    runtime = boot();
  });

  afterEach(async () => {
    await runtime.flushAll();
    runtime.dispose();
    db.close();
    cleanupDb(dbPath);
  });

  test("capture writes a ledger row and projects the day document", async () => {
    const entry = await runtime.capture({ text: "  Book the piano tuner  ", surface: "cli" });
    expect(entry.text).toBe("Book the piano tuner"); // trimmed
    expect(entry.day).toBe(dayKeyFor(entry.capturedAt));
    expect(entry.updatedAt).toBe(entry.capturedAt);

    const row = db
      .prepare<
        [string],
        { text: string; day: string; surface: string }
      >("SELECT text, day, surface FROM note_entries WHERE id = ?")
      .get(entry.id);
    expect(row).toEqual({ text: "Book the piano tuner", day: entry.day, surface: "cli" });

    await runtime.flushAll();
    expect(ingested).toHaveLength(1);
    const doc = ingested[0]![0]!;
    expect(doc).toMatchObject({
      sourceId: "omnesis-notes",
      providerId: "system",
      externalId: entry.day,
    });
    expect(doc.metadata.addressedToAgent).toBe(true);
    expect(doc.content).toContain("Book the piano tuner");
  });

  test("capture stores location and folds the place name into the day document", async () => {
    const entry = await runtime.capture({
      text: "Idea for the pitch",
      surface: "ios-siri",
      latitude: 48.8566,
      longitude: 2.3522,
      placeName: "Paris",
    });
    expect(entry.latitude).toBeCloseTo(48.8566, 4);
    expect(entry.longitude).toBeCloseTo(2.3522, 4);
    expect(entry.placeName).toBe("Paris");

    const row = db
      .prepare<
        [string],
        { latitude: number; longitude: number; place_name: string }
      >("SELECT latitude, longitude, place_name FROM note_entries WHERE id = ?")
      .get(entry.id);
    expect(row).toMatchObject({ place_name: "Paris" });
    expect(row!.latitude).toBeCloseTo(48.8566, 4);

    await runtime.flushAll();
    expect(ingested[0]![0]!.content).toContain("· Paris");
  });

  test("capture without a location leaves the coordinate columns null", async () => {
    const entry = await runtime.capture({ text: "No fix here", surface: "cli" });
    expect(entry.latitude).toBeNull();
    expect(entry.longitude).toBeNull();
    expect(entry.placeName).toBeNull();
  });

  test("capture with an explicit capturedAt keys the entry on that local day", async () => {
    const capturedAt = new Date(2026, 5, 1, 10, 30).toISOString(); // local June 1st
    const entry = await runtime.capture({ text: "Backfilled thought", capturedAt });
    expect(entry.day).toBe(dayKeyFor(capturedAt));
    expect(runtime.listDay(entry.day).map((e) => e.id)).toEqual([entry.id]);
  });

  test("capture uses the device offset for its day and records first gateway receipt", async () => {
    const entry = await runtime.capture({
      text: "Cross-midnight travel note",
      capturedAt: "2026-08-14T23:30:00.000Z",
      capturedTimeZoneId: "Europe/Helsinki",
      capturedUtcOffsetSeconds: 10_800,
    });
    expect(entry.day).toBe("2026-08-15");
    expect(entry.capturedTimeZoneId).toBe("Europe/Helsinki");
    expect(entry.capturedUtcOffsetSeconds).toBe(10_800);
    expect(Number.isNaN(Date.parse(entry.receivedAt!))).toBe(false);
  });

  test("capture canonicalizes capturedAt to UTC ISO; stored instants sort lexically", async () => {
    // An offset timestamp is stored as its UTC equivalent…
    const middle = await runtime.capture({
      text: "middle",
      capturedAt: "2026-06-15T09:30:00+05:30",
    });
    expect(middle.capturedAt).toBe("2026-06-15T04:00:00.000Z");
    expect(middle.updatedAt).toBe("2026-06-15T04:00:00.000Z");

    // …so it orders correctly among neighbors captured with different
    // offset representations (SQLite compares the strings lexically).
    const before = await runtime.capture({
      text: "before",
      capturedAt: "2026-06-15T03:59:00.000Z",
    });
    const after = await runtime.capture({
      text: "after",
      capturedAt: "2026-06-15T09:31:00+05:30",
    });
    const rows = db
      .prepare<
        [string, string, string],
        { text: string }
      >("SELECT text FROM note_entries WHERE id IN (?, ?, ?) ORDER BY captured_at, id")
      .all(before.id, middle.id, after.id);
    expect(rows.map((r) => r.text)).toEqual(["before", "middle", "after"]);
  });

  test("capture rejects blank text", async () => {
    await expect(runtime.capture({ text: "   " })).rejects.toThrow(/must not be empty/);
  });

  test("a burst of captures on one day coalesces into one day document", async () => {
    const a = await runtime.capture({ text: "First" });
    await runtime.capture({ text: "Second" });
    await runtime.flushAll();
    // debounceMs 0 can fire between captures; every ingested doc targets
    // the same externalId and the final one carries both entries.
    const last = ingested.at(-1)![0]!;
    expect(last.externalId).toBe(a.day);
    expect(last.content).toContain("First");
    expect(last.content).toContain("Second");
    expect(last.metadata.extra).toEqual({ entryCount: 2 });
  });

  test("capture with a client id is idempotent — a retry returns the stored entry, no duplicate", async () => {
    const id = randomUUID();
    const first = await runtime.capture({ id, text: "Book the dentist" });
    expect(first.id).toBe(id);
    await runtime.flushAll();
    ingested.length = 0;

    // Identical retry (e.g. the first response timed out client-side).
    const retry = await runtime.capture({ id, text: "Book the dentist" });
    expect(retry).toEqual(first);
    expect(runtime.listDay(first.day)).toHaveLength(1);

    // The retry enqueues no re-render — nothing changed.
    await runtime.flushAll();
    expect(ingested).toHaveLength(0);
  });

  test("duplicate capture fails transiently rather than inventing a second receipt time", async () => {
    const raced = boot({ writeGate: { ...gate, appendNoteEntry: async () => false } });
    const id = randomUUID();

    await expect(raced.capture({ id, text: "Retry after a lost response" })).rejects.toThrow(
      /not visible yet; retry/,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_entries WHERE id = ?").get(id)).toEqual({
      n: 0,
    });

    await raced.flushAll();
    raced.dispose();
  });

  test("edit rewrites the entry and re-enqueues its day; unknown id → null", async () => {
    const entry = await runtime.capture({ text: "Call the notary" });
    await runtime.flushAll();
    ingested.length = 0;

    const edited = await runtime.edit(entry.id, "Call the notary about the deed");
    expect(edited?.text).toBe("Call the notary about the deed");
    expect(edited?.updatedAt >= entry.updatedAt).toBe(true);

    await runtime.flushAll();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]![0]!.content).toContain("Call the notary about the deed");

    expect(await runtime.edit("unknown-id", "x")).toBeNull();
  });

  test("edit returns null when the write reports no row (deleted between read and write)", async () => {
    const entry = await runtime.capture({ text: "Racy note" });
    // The ledger UPDATE can race a concurrent delete of the same row —
    // model that by making the write report zero changed rows.
    const raced = boot({ writeGate: { ...gate, updateNoteEntry: async () => false } });
    expect(await raced.edit(entry.id, "never lands")).toBeNull();
    await raced.flushAll();
    raced.dispose();
    // The original text is untouched and no re-render was enqueued for it.
    expect(runtime.listDay(entry.day).map((e) => e.text)).toEqual(["Racy note"]);
  });

  test("remove drops the row; removing the last entry deletes the day document", async () => {
    const entry = await runtime.capture({ text: "Ephemeral thought" });
    await runtime.flushAll();

    // Materialize the day doc in the real DB so the delete path has a row
    // to remove (the stub ingest doesn't write documents).
    await gate.upsertDocuments(ingested.at(-1)!);
    const docCount = (): number =>
      (
        db
          .prepare<
            [],
            { n: number }
          >("SELECT COUNT(*) AS n FROM documents WHERE source_id = 'omnesis-notes'")
          .get() as { n: number }
      ).n;
    expect(docCount()).toBe(1);

    expect(await runtime.remove(entry.id)).toBe(true);
    await runtime.flushAll();
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_entries").get()).toEqual({ n: 0 });
    expect(docCount()).toBe(0);
    // The delete went through the injected DocumentService-style path.
    expect(deleted).toEqual([
      { providerId: "system", sourceId: "omnesis-notes", externalIds: [entry.day] },
    ]);

    expect(await runtime.remove(entry.id)).toBe(false);
  });

  test("listDay defaults to today", async () => {
    const entry = await runtime.capture({ text: "Today's note" });
    expect(runtime.listDay().map((e) => e.id)).toEqual([entry.id]);
    expect(runtime.listDay("1999-01-01")).toEqual([]);
  });

  test("boot seeds the source display meta in the background (flushAll awaits it)", async () => {
    await runtime.flushAll();
    const row = db
      .prepare<
        [],
        { label: string }
      >("SELECT label FROM sync_state WHERE source_id = 'omnesis-notes'")
      .get();
    expect(row?.label).toBe("Notes");
  });

  test("boot reconciliation projects a stranded ledger row and drops a stale day doc", async () => {
    // A ledger row with no projected document (a capture that crashed
    // inside the debounce window).
    const strandedDay = "2026-01-02";
    const strandedEntry: NoteEntry = {
      id: randomUUID(),
      day: strandedDay,
      capturedAt: "2026-01-02T09:00:00.000Z",
      updatedAt: "2026-01-02T09:00:00.000Z",
      text: "Stranded by a crash",
      surface: null,
      deviceId: null,
      latitude: null,
      longitude: null,
      placeName: null,
      capturedTimeZoneId: null,
      capturedUtcOffsetSeconds: null,
      receivedAt: null,
    };
    insertNoteEntry(db, strandedEntry);

    // A projected day doc whose ledger rows are gone (a crashed
    // delete-last-entry).
    const staleDay = "2025-12-31";
    await gate.upsertDocuments([
      buildNotesDayDocument(staleDay, [
        {
          ...strandedEntry,
          id: randomUUID(),
          day: staleDay,
          capturedAt: "2025-12-31T09:00:00.000Z",
        },
      ]),
    ]);

    const rebooted = boot();
    await rebooted.flushAll();
    rebooted.dispose();

    // The stranded day got projected…
    expect(ingested.flat().map((d) => d.externalId)).toContain(strandedDay);
    // …and the stale doc got dropped through the delete path.
    expect(deleted).toEqual([
      { providerId: "system", sourceId: "omnesis-notes", externalIds: [staleDay] },
    ]);
    const staleCount = db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM documents WHERE source_id = 'omnesis-notes' AND external_id = ?")
      .get(staleDay);
    expect(staleCount?.n).toBe(0);
  });
});
