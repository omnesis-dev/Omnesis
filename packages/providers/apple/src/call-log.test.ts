// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
type Db = Database.Database;
import { SourceId, ProviderId } from "@omnesis/types";
import { AppleProvider } from "./provider.js";
import { AppleCallLogSource } from "./call-log.js";
import { appleCallLogDocumentProfile } from "./document-profiles.js";
import { validateAppleCallLogSyncCursor } from "./types.js";
import { isoToCoreData } from "./epoch.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Core Data timestamps (seconds since 2001-01-01 UTC)
const TS_2026_07_04_09H = isoToCoreData("2026-07-04T09:12:00.000Z");
const TS_2026_07_04_14H = isoToCoreData("2026-07-04T14:03:00.000Z");
const TS_2026_07_05_10H = isoToCoreData("2026-07-05T10:00:00.000Z");

/** Create a test SQLite database mimicking CallHistory.storedata's ZCALLRECORD schema. */
function createTestDb(dbPath: string): Db {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ZCALLRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZUNIQUE_ID VARCHAR,
      ZADDRESS VARCHAR,
      ZNAME VARCHAR,
      ZDATE TIMESTAMP,
      ZDURATION FLOAT DEFAULT 0,
      ZORIGINATED INTEGER DEFAULT 0,
      ZANSWERED INTEGER DEFAULT 0,
      ZDISCONNECTED_CAUSE INTEGER,
      ZSERVICE_PROVIDER VARCHAR,
      ZCALLTYPE INTEGER,
      ZCALL_CATEGORY INTEGER
    );
  `);
  return db;
}

function insertCall(
  db: Db,
  opts: {
    pk: number;
    uniqueId?: string;
    address?: string | null;
    name?: string | null;
    date?: number;
    duration?: number;
    originated?: number;
    answered?: number;
    disconnectedCause?: number | null;
    serviceProvider?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO ZCALLRECORD
     (Z_PK, ZUNIQUE_ID, ZADDRESS, ZNAME, ZDATE, ZDURATION, ZORIGINATED, ZANSWERED, ZDISCONNECTED_CAUSE, ZSERVICE_PROVIDER)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.pk,
    opts.uniqueId ?? `call-uuid-${opts.pk}`,
    opts.address === undefined ? "+15550100142" : opts.address,
    opts.name ?? null,
    opts.date === undefined ? TS_2026_07_04_09H : opts.date,
    opts.duration ?? 0,
    opts.originated ?? 0,
    opts.answered ?? 0,
    opts.disconnectedCause ?? null,
    opts.serviceProvider === undefined ? "com.apple.Telephony" : opts.serviceProvider,
  );
}

describe("AppleCallLogSource", () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Db;
  let provider: AppleProvider;
  let source: AppleCallLogSource;

  function makeProvider(accountId: string, callLogDbPath = dbPath): AppleProvider {
    return new AppleProvider({
      notesDbPath: join(tmpDir, "nonexistent-notes"),
      remindersDirPath: join(tmpDir, "nonexistent-reminders"),
      imessageDbPath: join(tmpDir, "nonexistent-imessage"),
      contactsDirPath: join(tmpDir, "nonexistent-contacts"),
      calendarDbPath: join(tmpDir, "nonexistent-calendar"),
      callLogDbPath,
      voicemailDbPath: join(tmpDir, "nonexistent-voicemail"),
      accountId,
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-call-log-test-"));
    dbPath = join(tmpDir, "CallHistory.storedata");
    testDb = createTestDb(dbPath);

    provider = makeProvider("test@icloud.com");
    await provider.initialize();
    await provider.authenticate();
    source = new AppleCallLogSource(provider, {
      sourceId: "apple-call-log:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
  });

  afterEach(async () => {
    testDb.close();
    await provider.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("apple-call-log:test@icloud.com"));
    expect(source.providerId).toBe(ProviderId("apple:test@icloud.com"));
  });

  test("exposes the DB and its WAL as watchPaths", () => {
    expect(source.watchPaths).toEqual([dbPath, `${dbPath}-wal`]);
  });

  test("returns empty result when no calls", async () => {
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("bootstrap builds one day-document aggregating every call that day", async () => {
    insertCall(testDb, {
      pk: 1,
      address: "+15550100142",
      name: "Maya Reeves",
      date: TS_2026_07_04_09H,
      duration: 720,
      originated: 1,
      serviceProvider: "com.apple.FaceTime",
    });
    insertCall(testDb, {
      pk: 2,
      address: "+15550100199",
      date: TS_2026_07_04_14H,
      duration: 0,
      originated: 0,
      answered: 0,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0];
    expect(doc.externalId).toBe("call-log:2026-07-04");
    expect(doc.title).toBe("Calls — 2026-07-04");
    expect(doc.metadata.documentType).toBe("call-log");
    expect(doc.metadata.rollingAggregate).toBe(true);
    expect(doc.metadata.extra?.callCount).toBe(2);
    expect(doc.content).toContain("**Total:** 2 calls");
    expect(doc.content).toContain("Outgoing FaceTime → Maya Reeves, 12m");
    expect(doc.content).toContain("Incoming Phone ←");
    expect(doc.content).toContain(", missed");
  });

  // The declared profile is what subscription compilation reads when it turns
  // "when I spend more than an hour on calls in a day" into a document
  // predicate, so each declared role and path has to be something a day
  // document really carries. The final assertion re-lists the declared paths,
  // so adding one without proving the normalizer emits it fails here.
  test("emits every person role and metadata field the document profile declares", async () => {
    insertCall(testDb, {
      pk: 1,
      address: "+15550100142",
      name: "Maya Reeves",
      date: TS_2026_07_04_09H,
      duration: 600,
      originated: 1,
    });
    insertCall(testDb, {
      pk: 2,
      address: "+15550100199",
      date: TS_2026_07_04_14H,
      duration: 0,
      originated: 0,
      answered: 0,
    });

    const [doc] = (await source.sync(null)).documents;

    expect(appleCallLogDocumentProfile.documentTypes).toContain(doc.metadata.documentType);
    expect(new Set(doc.metadata.people?.map((p) => p.role))).toEqual(
      new Set(appleCallLogDocumentProfile.personRoles),
    );
    expect(doc.metadata.extra?.callCount).toBe(2);
    // Only the connected call contributes; the missed one adds nothing.
    expect(doc.metadata.extra?.totalDurationSeconds).toBe(600);
    // Every day document carries an empty tag array, so `tags` is deliberately
    // absent from the declaration.
    expect(doc.metadata.tags).toEqual([]);
    expect(appleCallLogDocumentProfile.metadataFields?.map((f) => f.path)).toEqual([
      "extra.callCount",
      "extra.totalDurationSeconds",
    ]);
  });

  test("syncStructured emits one apple_call_log analytics row per raw call, not per day", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    insertCall(testDb, { pk: 2, date: TS_2026_07_04_14H, uniqueId: "call-uuid-2" });

    const result = await source.syncStructured(null);
    expect(tablesWritten(result)).toEqual(["apple_call_log"]);
    const records = rowsFor(result, "apple_call_log");
    expect(records).toHaveLength(2);
    expect(result.documents).toHaveLength(1);
    expect(records.map((r) => r.id).sort()).toEqual(["call-uuid-1", "call-uuid-2"]);
  });

  test("two Mac stores converge on call documents and analytics despite different local row ids", async () => {
    const calls = [
      {
        uniqueId: "cloud-call-a",
        address: "+15550100142",
        name: "Maya Reeves",
        date: TS_2026_07_04_09H,
        duration: 720,
        originated: 1,
        answered: 0,
        serviceProvider: "com.apple.FaceTime",
      },
      {
        uniqueId: "cloud-call-b",
        address: "+15550100199",
        name: "Jamie Lopez",
        date: TS_2026_07_04_14H,
        duration: 90,
        originated: 0,
        answered: 1,
        serviceProvider: "com.apple.Telephony",
      },
    ];
    insertCall(testDb, { pk: 1, ...calls[0] });
    insertCall(testDb, { pk: 2, ...calls[1] });
    const replicaPath = join(tmpDir, "CallHistory-replica.storedata");
    const replicaDb = createTestDb(replicaPath);
    insertCall(replicaDb, { pk: 700, ...calls[0] });
    insertCall(replicaDb, { pk: 400, ...calls[1] });
    const replicaProvider = makeProvider("test@icloud.example", replicaPath);
    try {
      await replicaProvider.initialize();
      await replicaProvider.authenticate();
      const firstSource = new AppleCallLogSource(provider, {
        sourceId: "apple-call-log:test@icloud.example",
        providerId: "apple:test@icloud.example",
      });
      const replicaSource = new AppleCallLogSource(replicaProvider, {
        sourceId: "apple-call-log:test@icloud.example",
        providerId: "apple:test@icloud.example",
      });
      const first = await firstSource.syncStructured(null);
      const second = await replicaSource.syncStructured(null);
      const byId = (records: Record<string, unknown>[]) =>
        [...records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const byExternalId = <T extends { externalId: string }>(documents: T[]) =>
        [...documents].sort((a, b) => a.externalId.localeCompare(b.externalId));

      expect(tablesWritten(first)).toEqual(["apple_call_log"]);
      const firstRecords = rowsFor(first, "apple_call_log");
      const secondRecords = rowsFor(second, "apple_call_log");
      expect(byId(firstRecords).map((record) => record.id)).toEqual([
        "cloud-call-a",
        "cloud-call-b",
      ]);
      expect(byId(secondRecords)).toEqual(byId(firstRecords));
      expect(byExternalId(second.documents ?? [])).toEqual(byExternalId(first.documents ?? []));
      expect(first.presentExternalIds).toEqual(["call-log:2026-07-04"]);
      expect(second.presentExternalIds).toEqual(first.presentExternalIds);
      expect(second.cursor).not.toEqual(first.cursor);
    } finally {
      replicaDb.close();
      await replicaProvider.disconnect();
    }
  });

  test("classifies incoming missed vs answered via ZANSWERED", async () => {
    insertCall(testDb, { pk: 1, originated: 0, answered: 1, duration: 90 });
    const result = await source.syncStructured(null);
    expect(rowsFor(result, "apple_call_log")[0]).toMatchObject({
      direction: "incoming",
      connected: true,
    });

    testDb.exec("DELETE FROM ZCALLRECORD");
    insertCall(testDb, { pk: 2, originated: 0, answered: 0, duration: 0, uniqueId: "call-uuid-2" });
    const result2 = await source.syncStructured(null);
    expect(rowsFor(result2, "apple_call_log")[0]).toMatchObject({
      direction: "incoming",
      connected: false,
    });
  });

  test("outgoing calls use duration, not ZANSWERED, to determine connected (verified empirically)", async () => {
    // Real-world nuance: outgoing calls have ZANSWERED=0 even when they
    // connected and had substantial talk time — duration is authoritative.
    insertCall(testDb, { pk: 1, originated: 1, answered: 0, duration: 122 });
    const result = await source.syncStructured(null);
    expect(rowsFor(result, "apple_call_log")[0]).toMatchObject({
      direction: "outgoing",
      connected: true,
    });

    testDb.exec("DELETE FROM ZCALLRECORD");
    insertCall(testDb, { pk: 2, originated: 1, answered: 0, duration: 0, uniqueId: "call-uuid-2" });
    const result2 = await source.syncStructured(null);
    expect(rowsFor(result2, "apple_call_log")[0]).toMatchObject({
      direction: "outgoing",
      connected: false,
    });
  });

  test("incoming calls answered on another device render distinctly, not as missed or 0s", async () => {
    // Answered on the iPhone: the Mac's row shows ZANSWERED = 1 with no
    // talk time and ZDISCONNECTED_CAUSE = 1.
    insertCall(testDb, {
      pk: 1,
      address: "+14155552671",
      name: "Tara Quinn",
      date: TS_2026_07_04_09H,
      duration: 0,
      originated: 0,
      answered: 1,
      disconnectedCause: 1,
    });

    const result = await source.syncStructured(null);
    expect(rowsFor(result, "apple_call_log")[0]).toMatchObject({
      direction: "incoming",
      connected: true,
    });

    const docs = result.documents ?? [];
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.content).toContain("Incoming Phone ← Tara Quinn (answered on another device)");
    expect(doc.content).not.toContain("missed");
    expect(doc.content).not.toContain("Tara Quinn, 0s");
    expect(doc.metadata.extra?.callCount).toBe(1);
    expect(doc.metadata.extra?.totalDurationSeconds).toBe(0);
    const entry = (doc.metadata.extra?.calls as Array<Record<string, unknown>>)[0];
    expect(entry).toMatchObject({ connected: true, answeredElsewhere: true });
  });

  test("incoming answered calls with no disconnect cause keep the plain duration rendering", async () => {
    insertCall(testDb, {
      pk: 1,
      name: "Noah Kim",
      date: TS_2026_07_04_09H,
      duration: 0,
      originated: 0,
      answered: 1,
      disconnectedCause: null,
    });

    const result = await source.syncStructured(null);
    expect(rowsFor(result, "apple_call_log")[0]).toMatchObject({
      direction: "incoming",
      connected: true,
    });
    const docs = result.documents ?? [];
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain("Incoming Phone ← Noah Kim, 0s");
    const entry = (docs[0].metadata.extra?.calls as Array<Record<string, unknown>>)[0];
    expect(entry).toMatchObject({ connected: true, answeredElsewhere: false });
  });

  test("answered-elsewhere calls with no local audio add nothing to the day total", async () => {
    insertCall(testDb, {
      pk: 1,
      name: "Tara Quinn",
      date: TS_2026_07_04_09H,
      duration: 0,
      originated: 0,
      answered: 1,
      disconnectedCause: 1,
    });
    insertCall(testDb, {
      pk: 2,
      uniqueId: "call-uuid-2",
      name: "Noah Kim",
      date: TS_2026_07_04_14H,
      duration: 120,
      originated: 0,
      answered: 1,
      disconnectedCause: null,
    });

    const result = await source.sync(null);
    const [doc] = result.documents;
    expect(doc.metadata.extra?.callCount).toBe(2);
    expect(doc.metadata.extra?.totalDurationSeconds).toBe(120);
    expect(doc.content).toContain("**Total:** 2 calls, 2m");
  });

  test("answered-elsewhere calls keep their local seconds in the line and total", async () => {
    // A handoff race can leave a few seconds of local audio on the row —
    // shown in the line and counted, never silently dropped.
    insertCall(testDb, {
      pk: 1,
      name: "Tara Quinn",
      date: TS_2026_07_04_09H,
      duration: 4,
      originated: 0,
      answered: 1,
      disconnectedCause: 1,
    });
    insertCall(testDb, {
      pk: 2,
      uniqueId: "call-uuid-2",
      name: "Noah Kim",
      date: TS_2026_07_04_14H,
      duration: 120,
      originated: 0,
      answered: 1,
      disconnectedCause: null,
    });

    const result = await source.sync(null);
    const [doc] = result.documents;
    expect(doc.content).toContain("Incoming Phone ← Tara Quinn (answered on another device, 4s)");
    expect(doc.metadata.extra?.totalDurationSeconds).toBe(124);
    expect(doc.content).toContain("**Total:** 2 calls, 2m 4s");
  });

  test("incoming missed calls stay missed even with a disconnect cause", async () => {
    insertCall(testDb, {
      pk: 1,
      name: "Noah Kim",
      date: TS_2026_07_04_09H,
      duration: 0,
      originated: 0,
      answered: 0,
      disconnectedCause: 1,
    });

    const result = await source.syncStructured(null);
    expect(rowsFor(result, "apple_call_log")[0]).toMatchObject({
      direction: "incoming",
      connected: false,
    });
    const docs = result.documents ?? [];
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain("Incoming Phone ← Noah Kim, missed");
    expect(docs[0].content).not.toContain("another device");
  });

  test("outgoing calls are never labeled answered-elsewhere", async () => {
    insertCall(testDb, { pk: 1, originated: 1, answered: 0, duration: 60, disconnectedCause: 1 });

    const result = await source.sync(null);
    expect(result.documents[0].content).toContain("Outgoing Phone →");
    expect(result.documents[0].content).not.toContain("another device");
  });

  test("parses an email-shaped ZADDRESS (FaceTime/Apple ID) as an email peer mention", async () => {
    insertCall(testDb, {
      pk: 1,
      address: "jamie.lopez@example.com",
      serviceProvider: "com.apple.FaceTime",
    });
    const result = await source.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    expect(people.some((p) => p.emails?.includes("jamie.lopez@example.com"))).toBe(true);
  });

  test("uses ZISO_COUNTRY_CODE for a national-format call peer", async () => {
    testDb.exec("ALTER TABLE ZCALLRECORD ADD COLUMN ZISO_COUNTRY_CODE VARCHAR");
    insertCall(testDb, { pk: 1, address: "07700 000000", name: "Priya Nair" });
    testDb.prepare("UPDATE ZCALLRECORD SET ZISO_COUNTRY_CODE = 'gb' WHERE Z_PK = 1").run();

    const result = await source.sync(null);
    expect(result.documents[0].metadata.people).toContainEqual({
      role: "participant",
      name: "Priya Nair",
      phones: ["+447700000000"],
    });
  });

  test("falls back to the captured collector region when call metadata is absent", async () => {
    insertCall(testDb, { pk: 1, address: "020 7123 4567", name: "Robin Vale" });
    source = new AppleCallLogSource(provider, {
      sourceId: "apple-call-log:test@icloud.com",
      providerId: "apple:test@icloud.com",
      phoneRegion: "GB",
    });

    const result = await source.sync(null);
    expect(result.documents[0].metadata.people).toContainEqual({
      role: "participant",
      name: "Robin Vale",
      phones: ["+442071234567"],
    });
  });

  test("parses a phone-shaped ZADDRESS and normalizes it to E.164", async () => {
    // International format (`+`-prefixed) so normalization doesn't depend on
    // the test machine's system locale for region-guessing. Note: NANP's
    // reserved-fictional "555" block and Ofcom's reserved "07700 900xxx"
    // block are both rejected as invalid by libphonenumber-js's strict
    // validation (verified) — this placeholder uses a format that validates.
    insertCall(testDb, { pk: 1, address: "+1 415 555 2671" });
    const result = await source.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    expect(people.some((p) => p.phones?.includes("+14155552671"))).toBe(true);
  });

  test("null ZADDRESS calls render without a peer mention but don't crash", async () => {
    insertCall(testDb, { pk: 1, address: null });
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Unknown");
  });

  test("stamps self as a participant via Pattern A (email account id)", async () => {
    insertCall(testDb, { pk: 1 });
    const result = await source.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    expect(people).toContainEqual({ role: "participant", emails: ["test@icloud.com"] });
  });

  test("does not stamp self for a non-email account id", async () => {
    const localProvider = makeProvider("local");
    await localProvider.initialize();
    await localProvider.authenticate();
    const localSource = new AppleCallLogSource(localProvider, {
      sourceId: "apple-call-log:local",
      providerId: "apple:local",
    });
    insertCall(testDb, { pk: 1 });

    const result = await localSource.sync(null);
    const people = result.documents[0].metadata.people ?? [];
    expect(people.some((p) => p.emails?.includes("local"))).toBe(false);
    await localProvider.disconnect();
  });

  test("a day spanning two sync cycles rebuilds the FULL day, not just the new slice", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H, address: "+15550100142" });
    const first = await source.sync(null);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0].metadata.extra?.callCount).toBe(1);

    // A second call lands on the SAME date, later.
    insertCall(testDb, {
      pk: 2,
      date: TS_2026_07_04_14H,
      address: "+15550100199",
      uniqueId: "call-uuid-2",
    });
    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(1);
    // Must reflect BOTH calls — proves the day was re-read from the DB in
    // full, not rebuilt from only this cycle's incremental slice.
    expect(second.documents[0].metadata.extra?.callCount).toBe(2);
  });

  test("a new call reconciles canonical day documents and preserves unchanged content hashes", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    const first = await source.sync(null);
    expect(first.documents.map((d) => d.externalId)).toEqual(["call-log:2026-07-04"]);

    insertCall(testDb, { pk: 2, date: TS_2026_07_05_10H, uniqueId: "call-uuid-2" });
    const second = await source.sync(first.cursor);
    expect(second.documents.map((d) => d.externalId)).toEqual([
      "call-log:2026-07-04",
      "call-log:2026-07-05",
    ]);
    expect(second.documents[0].contentHash).toBe(first.documents[0].contentHash);
  });

  test("picks up a backdated call (past ZDATE) via the insertion high-water mark", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_05_10H });
    const first = await source.sync(null);
    expect(first.documents).toHaveLength(1);

    // iCloud call-history sync backfilling an offline period: a call lands
    // with a ZDATE BEFORE the watermark — a pure modification-watermark
    // walk would miss it; the Z_PK insertion high-water mark sweeps it.
    insertCall(testDb, { pk: 2, date: TS_2026_07_04_09H, uniqueId: "call-uuid-2" });
    const second = await source.sync(first.cursor);
    expect(second.documents.map((d) => d.externalId)).toEqual([
      "call-log:2026-07-04",
      "call-log:2026-07-05",
    ]);
  });

  test("a rebuilt database (Z_PK regression) triggers a full re-bootstrap", async () => {
    for (let i = 1; i <= 3; i++) {
      insertCall(testDb, { pk: i, uniqueId: `call-uuid-${i}`, date: TS_2026_07_04_09H + i });
    }
    const first = await source.sync(null);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0].metadata.extra?.callCount).toBe(3);

    // ZCALLRECORD has no AUTOINCREMENT (verified — no sqlite_sequence table
    // exists), so a rebuild is detected by the table's max Z_PK regressing
    // below our high-water mark, not by a dedicated sequence counter.
    testDb.exec("DELETE FROM ZCALLRECORD");
    for (let i = 1; i <= 2; i++) {
      insertCall(testDb, {
        pk: i,
        uniqueId: `rebuilt-call-uuid-${i}`,
        date: TS_2026_07_05_10H + i,
      });
    }

    const second = await source.sync(first.cursor);
    const ids = second.documents.map((d) => d.externalId).sort();
    expect(ids).toEqual(["call-log:2026-07-05"]);
    expect(second.documents[0].metadata.extra?.callCount).toBe(2);
  });

  test("dataCutoff excludes pre-cutoff calls from a rebuilt day-document even when the day straddles the cutoff", async () => {
    const cutoffSource = new AppleCallLogSource(provider, {
      sourceId: "apple-call-log:test@icloud.com",
      providerId: "apple:test@icloud.com",
      dataCutoff: "2026-07-04T12:00:00.000Z",
    });

    // Same day, straddling the mid-day cutoff: one call before, one after.
    insertCall(testDb, {
      pk: 1,
      uniqueId: "call-uuid-1",
      date: isoToCoreData("2026-07-04T09:00:00.000Z"),
    });
    insertCall(testDb, {
      pk: 2,
      uniqueId: "call-uuid-2",
      date: isoToCoreData("2026-07-04T15:00:00.000Z"),
    });

    const result = await cutoffSource.sync(null);
    expect(result.documents).toHaveLength(1);
    // Only the post-cutoff call should be reflected — the pre-cutoff call
    // must not leak into the rebuilt day-document's content/extra even
    // though both calls share a calendar day.
    expect(result.documents[0].metadata.extra?.callCount).toBe(1);
  });

  test("no-op incremental cycle emits no documents and no snapshot", async () => {
    insertCall(testDb, { pk: 1 });
    const first = await source.sync(null);
    expect(first.presentExternalIds).toEqual(["call-log:2026-07-04"]);

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(0);
    expect(second.presentExternalIds).toBeUndefined();
  });

  test("day summaries include the final fractional millisecond without taking next midnight", async () => {
    const midnight = isoToCoreData("2026-07-05T00:00:00.000Z");
    insertCall(testDb, { pk: 1, date: midnight - 0.0005 });
    insertCall(testDb, { pk: 2, date: midnight, uniqueId: "midnight-call" });
    const page = await source.sync(null);
    expect(page.documents.map((d) => [d.externalId, d.metadata.extra?.callCount])).toEqual([
      ["call-log:2026-07-04", 1],
      ["call-log:2026-07-05", 1],
    ]);
    expect(page.presentExternalIds).toHaveLength(2);
  });

  test("deleting one call rebuilds the surviving day's document without deleting analytics", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    insertCall(testDb, { pk: 2, date: TS_2026_07_04_14H, uniqueId: "call-uuid-2" });
    const first = await source.syncStructured(null);
    expect(first.documents?.[0].metadata.extra?.callCount).toBe(2);
    testDb.prepare("DELETE FROM ZCALLRECORD WHERE Z_PK = 1").run();

    const second = await source.syncStructured(first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents?.[0].metadata.extra?.callCount).toBe(1);
    expect(rowsFor(second, "apple_call_log")).toEqual([]);
    expect(second.presentExternalIds).toEqual(["call-log:2026-07-04"]);
  });

  test("same-key timestamp-preserving replacement and content updates rebuild day documents", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    insertCall(testDb, { pk: 2, date: TS_2026_07_04_14H, uniqueId: "call-uuid-2" });
    const first = await source.sync(null);
    testDb
      .prepare("UPDATE ZCALLRECORD SET ZNAME = ?, ZDURATION = ? WHERE Z_PK = 1")
      .run("fictional caller", 127);
    const changed = await source.sync(first.cursor);
    expect(changed.documents).toHaveLength(1);
    expect(changed.documents[0].contentHash).not.toBe(first.documents[0].contentHash);
    expect(changed.documents[0].content).toContain("fictional caller");
    testDb.prepare("DELETE FROM ZCALLRECORD WHERE Z_PK = 1").run();
    insertCall(testDb, {
      pk: 1,
      date: TS_2026_07_04_09H,
      uniqueId: "replacement-call",
      address: "replacement@example.com",
    });
    const replaced = await source.sync(changed.cursor);
    expect(replaced.documents[0].content).toContain("replacement@example.com");
    expect(replaced.documents[0].content).not.toContain("fictional caller");
    expect((await source.sync(replaced.cursor)).documents).toEqual([]);
  });

  test("moving a call to an older day reconciles both day membership and content", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_05_10H });
    const first = await source.sync(null);
    testDb.prepare("UPDATE ZCALLRECORD SET ZDATE = ? WHERE Z_PK = 1").run(TS_2026_07_04_09H);
    const moved = await source.sync(first.cursor);
    expect(moved.documents.map((d) => d.externalId)).toEqual(["call-log:2026-07-04"]);
    expect(moved.presentExternalIds).toEqual(["call-log:2026-07-04"]);
  });

  test("legacy completed cursors heal canonical content even when their saved signature matches", async () => {
    insertCall(testDb, { pk: 1 });
    const first = await source.sync(null);
    const legacy = { ...first.cursor, dayReconciliationComplete: undefined };
    const healed = await source.sync(legacy);
    expect(healed.documents).toHaveLength(1);
    expect(healed.presentExternalIds).toEqual(["call-log:2026-07-04"]);
    expect(validateAppleCallLogSyncCursor(healed.cursor)).not.toBeNull();
  });

  test("bounded day pages resume legacy in-flight cursors, retry exactly and restart after a change behind the keyset", async () => {
    for (let i = 0; i < 105; i++)
      insertCall(testDb, {
        pk: i + 1,
        date: TS_2026_07_04_09H + i * 86400,
        uniqueId: `day-call-${i}`,
      });
    const analyticsPage = await source.syncStructured(null);
    expect(analyticsPage.documents).toEqual([]);
    // A legacy analytics page includes its accumulated dates and no new phase fields.
    const legacy = { ...analyticsPage.cursor, affectedDates: ["2026-07-04"] };
    const first = await source.syncStructured(legacy);
    expect(first.documents).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.presentExternalIds).toBeUndefined();
    const retry = await source.syncStructured(legacy);
    expect(retry).toEqual(first);
    expect(JSON.stringify(first.cursor).length).toBeLessThan(1024);
    testDb
      .prepare("UPDATE ZCALLRECORD SET ZNAME = ? WHERE Z_PK = 1")
      .run("updated fictional caller");
    const restarted = await source.syncStructured(first.cursor);
    expect(restarted.documents).toHaveLength(100);
    expect(restarted.documents?.[0].content).toContain("updated fictional caller");
    expect(restarted.presentExternalIds).toBeUndefined();
    expect(rowsFor(restarted, "apple_call_log")).toEqual([]);
    const final = await source.syncStructured(restarted.cursor);
    expect(final.documents).toHaveLength(5);
    expect(final.presentExternalIds).toHaveLength(105);
    expect(final.hasMore).toBe(false);
    expect((await source.sync(final.cursor)).documents).toEqual([]);
  });

  test("a failed day read publishes neither documents nor absence and the same cursor retries", async () => {
    insertCall(testDb, { pk: 1 });
    const first = await source.sync(null);
    testDb.prepare("UPDATE ZCALLRECORD SET ZNAME = ? WHERE Z_PK = 1").run("retry fictional caller");
    const db = provider.getCallLogDb()!;
    const prepare = db.prepare.bind(db);
    const fail = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("ORDER BY ZDATE ASC")) throw new Error("synthetic read failure");
      return prepare(sql);
    });
    await expect(source.sync(first.cursor)).rejects.toThrow("synthetic read failure");
    fail.mockRestore();
    const retry = await source.sync(first.cursor);
    expect(retry.documents[0].content).toContain("retry fictional caller");
    expect(retry.presentExternalIds).toEqual(["call-log:2026-07-04"]);
  });

  test("concurrent WAL writes cannot mix a day body with another snapshot generation", async () => {
    testDb.pragma("journal_mode = WAL");
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    insertCall(testDb, { pk: 2, date: TS_2026_07_05_10H, uniqueId: "call-uuid-2" });
    const first = await source.sync(null);
    testDb
      .prepare("UPDATE ZCALLRECORD SET ZNAME = ? WHERE Z_PK = 1")
      .run("before concurrent delete");
    const db = provider.getCallLogDb()!;
    const prepare = db.prepare.bind(db);
    let deleted = false;
    const duringRead = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!deleted && sql.includes("ORDER BY ZDATE ASC")) {
        deleted = true;
        testDb.prepare("DELETE FROM ZCALLRECORD WHERE Z_PK = 1").run();
      }
      return prepare(sql);
    });
    const pinned = await source.sync(first.cursor);
    duringRead.mockRestore();
    expect(pinned.documents[0].metadata.extra?.callCount).toBe(1);
    expect(pinned.documents[0].content).toContain("before concurrent delete");
    expect(pinned.presentExternalIds).toHaveLength(2);
    const settled = await source.sync(pinned.cursor);
    expect(settled.documents.map((d) => d.externalId)).toEqual(["call-log:2026-07-05"]);
    expect(settled.presentExternalIds).toEqual(["call-log:2026-07-05"]);
  });

  test("a whole day disappearing (all its calls deleted) is removed via snapshot reconciliation", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    insertCall(testDb, { pk: 2, date: TS_2026_07_05_10H, uniqueId: "call-uuid-2" });
    const first = await source.sync(null);
    expect(first.presentExternalIds?.sort()).toEqual([
      "call-log:2026-07-04",
      "call-log:2026-07-05",
    ]);

    // No delete tombstone on ZCALLRECORD — physically remove the row.
    testDb.prepare(`DELETE FROM ZCALLRECORD WHERE Z_PK = 1`).run();

    const second = await source.sync(first.cursor);
    // The 07-04 day-document is gone from the snapshot entirely (its only
    // call was deleted) — the gateway's generic reconciliation deletes it.
    expect(second.presentExternalIds).toEqual(["call-log:2026-07-05"]);
  });

  test("paginates beyond PAGE_SIZE for the analytics rows", async () => {
    for (let i = 1; i <= 101; i++) {
      insertCall(testDb, {
        pk: i,
        uniqueId: `call-uuid-${i}`,
        date: TS_2026_07_04_09H + i,
      });
    }

    const page1 = await source.syncStructured(null);
    const page1Records = rowsFor(page1, "apple_call_log");
    expect(page1Records).toHaveLength(100);
    expect(page1.hasMore).toBe(true);
    expect(page1.documents).toHaveLength(0); // no rebuild mid-cycle

    const page2 = await source.syncStructured(page1.cursor);
    const page2Records = rowsFor(page2, "apple_call_log");
    expect(page2Records).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.documents).toHaveLength(1); // rebuild fires on the final page

    const ids = new Set([...page1Records, ...page2Records].map((r) => r.id));
    expect(ids.size).toBe(101);
  });

  test("DB unavailable: sync is a no-op that preserves the cursor and emits no snapshot", async () => {
    insertCall(testDb, { pk: 1 });
    const first = await source.sync(null);

    const missing = new AppleProvider({
      notesDbPath: join(tmpDir, "nonexistent-notes"),
      remindersDirPath: join(tmpDir, "nonexistent-reminders"),
      imessageDbPath: join(tmpDir, "nonexistent-imessage"),
      contactsDirPath: join(tmpDir, "nonexistent-contacts"),
      calendarDbPath: join(tmpDir, "nonexistent-calendar"),
      callLogDbPath: join(tmpDir, "nonexistent-call-log"),
      voicemailDbPath: join(tmpDir, "nonexistent-voicemail"),
      accountId: "test@icloud.com",
    });
    await missing.initialize();
    await missing.authenticate();
    const missingSource = new AppleCallLogSource(missing, {
      sourceId: "apple-call-log:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });

    const result = await missingSource.sync(first.cursor);
    expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    expect((await source.sync(result.cursor)).issues).toEqual([]);
    expect((await missingSource.syncStructured(first.cursor)).issues).toEqual(result.issues);
    expect(result.documents).toHaveLength(0);
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.cursor).toEqual(first.cursor);
    expect(result.hasMore).toBe(false);
    await missing.disconnect();
  });

  test("cursor validator round-trips produced cursors and rejects junk", async () => {
    insertCall(testDb, { pk: 1 });
    const result = await source.sync(null);

    expect(validateAppleCallLogSyncCursor(result.cursor)).not.toBeNull();
    expect(validateAppleCallLogSyncCursor({ lastModifiedTimestamp: 123 })).not.toBeNull();
    expect(validateAppleCallLogSyncCursor({ lastModifiedTimestamp: "123" })).toBeNull();
    expect(validateAppleCallLogSyncCursor({})).toBeNull();
    expect(
      validateAppleCallLogSyncCursor({
        lastModifiedTimestamp: 0,
        dayReconciliation: { afterDay: "invalid", signature: "hash" },
      }),
    ).toBeNull();
    expect(
      validateAppleCallLogSyncCursor({
        lastModifiedTimestamp: 0,
        dayReconciliation: { afterDay: "", signature: 1 },
      }),
    ).toBeNull();
    expect(
      validateAppleCallLogSyncCursor({
        lastModifiedTimestamp: 0,
        dayReconciliationComplete: "yes",
      }),
    ).toBeNull();
  });

  test("sourceCreatedAt/sourceUpdatedAt span the whole day", async () => {
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    const result = await source.sync(null);
    expect(result.documents[0].sourceCreatedAt).toBe("2026-07-04T00:00:00.000Z");
    expect(result.documents[0].sourceUpdatedAt).toBe("2026-07-04T23:59:59.999Z");
  });

  test("dataCutoff excludes calls before the cutoff", async () => {
    const cutoffSource = new AppleCallLogSource(provider, {
      sourceId: "apple-call-log:test@icloud.com",
      providerId: "apple:test@icloud.com",
      dataCutoff: "2026-07-05T00:00:00.000Z",
    });
    insertCall(testDb, { pk: 1, date: TS_2026_07_04_09H });
    insertCall(testDb, { pk: 2, date: TS_2026_07_05_10H, uniqueId: "call-uuid-2" });

    const result = await cutoffSource.sync(null);
    expect(result.documents.map((d) => d.externalId)).toEqual(["call-log:2026-07-05"]);
  });
});
