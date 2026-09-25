// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AppleProvider } from "./provider.js";
import { AppleVoicemailSource } from "./voicemail.js";
import { appleVoicemailDocumentProfile } from "./document-profiles.js";
import { isoToCoreData } from "./epoch.js";

type Db = Database.Database;

const MORNING = isoToCoreData("2026-07-04T09:12:00.000Z");
const AFTERNOON = isoToCoreData("2026-07-04T14:03:00.000Z");
const NEXT_DAY = isoToCoreData("2026-07-05T10:00:00.000Z");

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function field(number: number, payload: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]);
}

function transcript(text: string): Buffer {
  return field(1, field(2, Buffer.from(text)));
}

function uuidBytes(id: number): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(id, 12);
  return bytes;
}

function createStore(path: string): Db {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZSTOREDMESSAGE (
      Z_PK INTEGER PRIMARY KEY,
      ZISREAD INTEGER,
      ZMAILBOXTYPE INTEGER,
      ZDATECREATED FLOAT,
      ZDATEMODIFIED FLOAT,
      ZDATEDELETED FLOAT,
      ZDURATION FLOAT,
      ZFROM VARCHAR,
      ZPROVIDER VARCHAR,
      ZRECORDUUID BLOB,
      ZTRANSCRIPTDATA BLOB
    )
  `);
  return db;
}

function insertVoicemail(
  db: Db,
  opts: {
    pk: number;
    caller?: string | null;
    created?: number;
    modified?: number;
    duration?: number;
    text?: string | null;
    mailbox?: number;
    deleted?: number | null;
    provider?: string;
    recordUuid?: Buffer;
  },
): void {
  const created = opts.created ?? MORNING;
  db.prepare(
    `INSERT INTO ZSTOREDMESSAGE
      (Z_PK, ZISREAD, ZMAILBOXTYPE, ZDATECREATED, ZDATEMODIFIED, ZDATEDELETED,
       ZDURATION, ZFROM, ZPROVIDER, ZRECORDUUID, ZTRANSCRIPTDATA)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.pk,
    opts.mailbox ?? 0,
    created,
    opts.modified ?? created,
    opts.deleted ?? null,
    opts.duration ?? 20,
    opts.caller === undefined ? "+12025550142" : opts.caller,
    opts.provider ?? "com.apple.coretelephony",
    opts.recordUuid ?? uuidBytes(opts.pk),
    opts.text === null ? null : transcript(opts.text ?? "Please send the revised notes."),
  );
}

describe("AppleVoicemailSource", () => {
  let directory: string;
  let dbPath: string;
  let db: Db;
  let provider: AppleProvider;
  let source: AppleVoicemailSource;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "apple-voicemail-test-"));
    dbPath = join(directory, "FaceTimeMessageStore-local.sqlitedb");
    db = createStore(dbPath);
    provider = new AppleProvider({
      notesDbPath: join(directory, "missing-notes"),
      remindersDirPath: join(directory, "missing-reminders"),
      imessageDbPath: join(directory, "missing-imessage"),
      contactsDirPath: join(directory, "missing-contacts"),
      calendarDbPath: join(directory, "missing-calendar"),
      callLogDbPath: join(directory, "missing-call-log"),
      voicemailDbPath: dbPath,
      accountId: "owner@example.com",
    });
    await provider.initialize();
    await provider.authenticate();
    source = new AppleVoicemailSource(provider, {
      sourceId: "apple-voicemail:owner@example.com",
      providerId: "apple:owner@example.com",
      phoneRegion: "GB",
    });
  });

  afterEach(async () => {
    db.close();
    await provider.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  test("exposes the voicemail DB and WAL as watch paths", () => {
    expect(source.watchPaths).toEqual([dbPath, `${dbPath}-wal`]);
  });

  test("bootstrap aggregates transcripts and normalized caller identities into a day doc", async () => {
    insertVoicemail(db, {
      pk: 1,
      caller: "+1 (202) 555-0142",
      created: MORNING,
      duration: 21,
      text: "The project review moved to Tuesday.",
    });
    insertVoicemail(db, {
      pk: 2,
      caller: "+1 (202) 555-0199",
      created: AFTERNOON,
      duration: 39,
      text: "Please send the revised notes.",
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    const [document] = result.documents;
    expect(document.externalId).toBe("voicemail:2026-07-04");
    expect(document.metadata).toMatchObject({
      documentType: "voicemail",
      rollingAggregate: true,
      extra: { voicemailCount: 2, totalDurationSeconds: 60, transcriptCount: 2 },
    });
    expect(document.content).toContain("The project review moved to Tuesday.");
    expect(document.content).toContain("Please send the revised notes.");
    expect(document.metadata.people).toEqual(
      expect.arrayContaining([
        { role: "participant", emails: ["owner@example.com"] },
        { role: "participant", phones: ["+12025550142"] },
        { role: "participant", phones: ["+12025550199"] },
      ]),
    );
  });

  test("two Mac stores converge on voicemail identity despite different local row ids", async () => {
    const stableRecordUuid = uuidBytes(77);
    insertVoicemail(db, {
      pk: 7,
      recordUuid: stableRecordUuid,
      caller: "+1 (202) 555-0142",
      created: MORNING,
      modified: AFTERNOON,
      duration: 21,
      text: "The project review moved to Tuesday.",
    });
    const replicaPath = join(directory, "FaceTimeMessageStore-replica.sqlitedb");
    const replicaDb = createStore(replicaPath);
    insertVoicemail(replicaDb, {
      pk: 700,
      recordUuid: stableRecordUuid,
      caller: "+1 (202) 555-0142",
      created: MORNING,
      modified: AFTERNOON,
      duration: 21,
      text: "The project review moved to Tuesday.",
    });
    const replicaProvider = new AppleProvider({
      notesDbPath: join(directory, "missing-notes-replica"),
      remindersDirPath: join(directory, "missing-reminders-replica"),
      imessageDbPath: join(directory, "missing-imessage-replica"),
      contactsDirPath: join(directory, "missing-contacts-replica"),
      calendarDbPath: join(directory, "missing-calendar-replica"),
      callLogDbPath: join(directory, "missing-call-log-replica"),
      voicemailDbPath: replicaPath,
      accountId: "owner@example.com",
    });
    try {
      await replicaProvider.initialize();
      await replicaProvider.authenticate();
      const replicaSource = new AppleVoicemailSource(replicaProvider, {
        sourceId: "apple-voicemail:owner@example.com",
        providerId: "apple:owner@example.com",
        phoneRegion: "GB",
      });
      const first = await source.sync(null);
      const second = await replicaSource.sync(null);
      expect(first.documents.map((document) => document.externalId)).toEqual([
        "voicemail:2026-07-04",
      ]);
      expect(second.documents).toEqual(first.documents);
      expect(first.presentExternalIds).toEqual(["voicemail:2026-07-04"]);
      expect(second.presentExternalIds).toEqual(first.presentExternalIds);
      expect((first.documents[0].metadata.extra?.voicemails as Array<{ id: string }>)[0]?.id).toBe(
        "00000000-0000-0000-0000-00000000004d",
      );
    } finally {
      replicaDb.close();
      await replicaProvider.disconnect();
    }
  });

  test("emits every role and field declared by its document profile", async () => {
    insertVoicemail(db, { pk: 1 });
    const [document] = (await source.sync(null)).documents;
    expect(appleVoicemailDocumentProfile.documentTypes).toContain(document.metadata.documentType);
    expect(new Set(document.metadata.people?.map((person) => person.role))).toEqual(
      new Set(appleVoicemailDocumentProfile.personRoles),
    );
    expect(appleVoicemailDocumentProfile.metadataFields?.map((field) => field.path)).toEqual([
      "extra.voicemailCount",
      "extra.totalDurationSeconds",
      "extra.transcriptCount",
    ]);
  });

  test("incremental sync emits only changed day docs and suppresses unchanged days", async () => {
    insertVoicemail(db, { pk: 1 });
    insertVoicemail(db, { pk: 2, created: NEXT_DAY });
    const first = await source.sync(null);
    expect((await source.sync(first.cursor)).documents).toEqual([]);

    insertVoicemail(db, { pk: 3, created: AFTERNOON, text: "The venue is the example workshop." });
    const incremental = await source.sync(first.cursor);
    expect(incremental.documents).toHaveLength(1);
    expect(incremental.documents[0].externalId).toBe("voicemail:2026-07-04");
    expect(incremental.documents[0].metadata.extra?.voicemailCount).toBe(2);
  });

  test("an unread-to-read metadata change re-emits its day document", async () => {
    insertVoicemail(db, { pk: 1 });
    const first = await source.sync(null);
    db.prepare("UPDATE ZSTOREDMESSAGE SET ZISREAD = 1, ZDATEMODIFIED = ? WHERE Z_PK = 1").run(
      AFTERNOON,
    );
    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(
      (second.documents[0].metadata.extra?.voicemails as Array<{ isRead: boolean }>)[0].isRead,
    ).toBe(true);
  });

  test("snapshot IDs remove a day after its last voicemail is deleted", async () => {
    insertVoicemail(db, { pk: 1 });
    const first = await source.sync(null);
    expect(first.presentExternalIds).toEqual(["voicemail:2026-07-04"]);
    expect(first.issues).toEqual([]);

    db.prepare("UPDATE ZSTOREDMESSAGE SET ZDATEDELETED = ? WHERE Z_PK = 1").run(AFTERNOON);
    const second = await source.sync(first.cursor);
    expect(second.presentExternalIds).toEqual([]);
  });

  test("excludes junk, trash, non-carrier rows, and rows before the cutoff", async () => {
    insertVoicemail(db, { pk: 1, mailbox: 1 });
    insertVoicemail(db, { pk: 2, provider: "com.example.voicemail" });
    insertVoicemail(db, { pk: 3, created: MORNING });
    insertVoicemail(db, { pk: 4, created: NEXT_DAY });
    const cutoffSource = new AppleVoicemailSource(provider, {
      sourceId: "apple-voicemail:owner@example.com",
      providerId: "apple:owner@example.com",
      dataCutoff: "2026-07-05T00:00:00.000Z",
    });
    const result = await cutoffSource.sync(null);
    expect(result.documents.map((document) => document.externalId)).toEqual([
      "voicemail:2026-07-05",
    ]);
  });

  test("keeps transcript-less and malformed-transcript voicemail without inventing a person", async () => {
    insertVoicemail(db, { pk: 1, caller: "Private", text: null });
    insertVoicemail(db, { pk: 2, caller: null, created: AFTERNOON });
    db.prepare("UPDATE ZSTOREDMESSAGE SET ZTRANSCRIPTDATA = ? WHERE Z_PK = 2").run(
      Buffer.from([0x0a, 0x80]),
    );
    const [document] = (await source.sync(null)).documents;
    expect(document.content).toContain("Transcript not available");
    expect(document.metadata.extra?.transcriptCount).toBe(0);
    expect(document.metadata.people).toEqual([
      { role: "participant", emails: ["owner@example.com"] },
    ]);
  });

  test("a malformed record UUID does not block other voicemail", async () => {
    insertVoicemail(db, { pk: 1 });
    insertVoicemail(db, { pk: 2, created: AFTERNOON });
    db.prepare("UPDATE ZSTOREDMESSAGE SET ZRECORDUUID = ? WHERE Z_PK = 1").run(Buffer.from([1, 2]));
    const [document] = (await source.sync(null)).documents;
    const voicemails = document.metadata.extra?.voicemails as Array<{ id?: string }>;
    expect(voicemails).toHaveLength(2);
    expect(voicemails[0].id).toBeUndefined();
    expect(voicemails[1].id).toBe("00000000-0000-0000-0000-000000000002");
  });

  test("wrong SQLite storage classes fail safely without advancing the snapshot", async () => {
    insertVoicemail(db, { pk: 1 });
    db.prepare("UPDATE ZSTOREDMESSAGE SET ZFROM = ? WHERE Z_PK = 1").run(Buffer.from([1, 2]));
    await expect(source.sync(null)).rejects.toThrow(/malformed data.*caller/);
  });

  // A host with no voicemail store has nothing to read and nothing to fix, so
  // it syncs nothing — and claims nothing about what is still there, which is
  // what keeps the voicemails already indexed from being swept.
  test("an absent database sweeps nothing and reports nothing", async () => {
    const absentProvider = new AppleProvider({
      notesDbPath: join(directory, "missing-notes-3"),
      remindersDirPath: join(directory, "missing-reminders-3"),
      imessageDbPath: join(directory, "missing-imessage-3"),
      contactsDirPath: join(directory, "missing-contacts-3"),
      calendarDbPath: join(directory, "missing-calendar-3"),
      callLogDbPath: join(directory, "missing-call-log-3"),
      voicemailDbPath: join(directory, "missing-voicemail-3.sqlitedb"),
      accountId: "owner@example.com",
    });
    await absentProvider.authenticate();
    const absentSource = new AppleVoicemailSource(absentProvider, {
      sourceId: "apple-voicemail:owner@example.com",
      providerId: "apple:owner@example.com",
    });

    const result = await absentSource.sync({
      daySignatures: { "voicemail:2026-07-04": "previous" },
    });

    expect(result.documents).toEqual([]);
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    await absentProvider.disconnect();
  });

  // A store whose schema this provider has not been taught is named as such,
  // rather than syncing nothing for a reason nobody can see. Reporting it also
  // rules out the sweep: an error carries no snapshot, so the voicemails
  // already indexed cannot be mistaken for deleted.
  test("an unsupported database schema is reported, and sweeps nothing", async () => {
    const badPath = join(directory, "unsupported.sqlitedb");
    const badDb = new Database(badPath);
    badDb.exec("CREATE TABLE ZSTOREDMESSAGE (Z_PK INTEGER PRIMARY KEY)");
    badDb.close();
    const badProvider = new AppleProvider({
      notesDbPath: join(directory, "missing-notes-2"),
      remindersDirPath: join(directory, "missing-reminders-2"),
      imessageDbPath: join(directory, "missing-imessage-2"),
      contactsDirPath: join(directory, "missing-contacts-2"),
      calendarDbPath: join(directory, "missing-calendar-2"),
      callLogDbPath: join(directory, "missing-call-log-2"),
      voicemailDbPath: badPath,
      accountId: "owner@example.com",
    });

    // A schema this provider has not been taught is the Voicemail source's
    // problem, not the whole provider's: authentication is about access.
    await expect(badProvider.authenticate()).resolves.toBeUndefined();

    const badSource = new AppleVoicemailSource(badProvider, {
      sourceId: "apple-voicemail:owner@example.com",
      providerId: "apple:owner@example.com",
    });
    await expect(
      badSource.sync({ daySignatures: { "voicemail:2026-07-04": "previous" } }),
    ).rejects.toThrow(/unsupported schema/);
    await badProvider.disconnect();
  });
});
