// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SourceId } from "@omnesis/types";
import { AppleContactsSource } from "./contacts.js";
import { AppleProvider } from "./provider.js";
import { appleContactsDocumentProfile } from "./document-profiles.js";

const CORE_DATA_EPOCH = new Date("2001-01-01T00:00:00Z").getTime();

function toCoreData(date: Date): number {
  return (date.getTime() - CORE_DATA_EPOCH) / 1000;
}

function createTestDb(dbPath: string): Db {
  const db = new Database(dbPath);

  db.prepare(
    `
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER DEFAULT 22,
      Z_OPT INTEGER DEFAULT 1,
      ZFIRSTNAME TEXT,
      ZLASTNAME TEXT,
      ZMIDDLENAME TEXT,
      ZORGANIZATION TEXT,
      ZDEPARTMENT TEXT,
      ZJOBTITLE TEXT,
      ZNICKNAME TEXT,
      ZCREATIONDATE REAL,
      ZMODIFICATIONDATE REAL,
      ZUNIQUEID TEXT,
      ZCONTAINERWHERECONTACTISME INTEGER
    )
  `,
  ).run();

  db.prepare(
    `
    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER DEFAULT 11,
      Z_OPT INTEGER DEFAULT 1,
      ZOWNER INTEGER,
      Z22_OWNER INTEGER DEFAULT 22,
      ZADDRESS TEXT,
      ZLABEL TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0,
      ZIOSLEGACYIDENTIFIER INTEGER,
      ZISPRIMARY INTEGER,
      ZISPRIVATE INTEGER,
      ZADDRESSNORMALIZED TEXT,
      ZUNIQUEID TEXT
    )
  `,
  ).run();

  db.prepare(
    `
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER DEFAULT 15,
      Z_OPT INTEGER DEFAULT 1,
      ZOWNER INTEGER,
      Z22_OWNER INTEGER DEFAULT 22,
      ZFULLNUMBER TEXT,
      ZLABEL TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0,
      ZIOSLEGACYIDENTIFIER INTEGER,
      ZISPRIMARY INTEGER,
      ZISPRIVATE INTEGER,
      ZAREACODE TEXT,
      ZCOUNTRYCODE TEXT,
      ZEXTENSION TEXT,
      ZLASTFOURDIGITS TEXT,
      ZLOCALNUMBER TEXT,
      ZUNIQUEID TEXT
    )
  `,
  ).run();

  db.prepare(
    `
    CREATE TABLE ZABCDDELETEDRECORDLOG (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER DEFAULT 10,
      Z_OPT INTEGER DEFAULT 1,
      ZCONTAINER INTEGER,
      ZDELETEDRECORDUNIQUEID TEXT,
      ZUNIQUEID TEXT
    )
  `,
  ).run();

  // Optional auxiliary tables — apple-contacts-missing-fields fix joins
  // these to surface address / URL / social / date fields. The source uses
  // safeSelect so a test DB that drops these tables still works.
  db.prepare(
    `
    CREATE TABLE ZABCDPOSTALADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZSTREET TEXT,
      ZCITY TEXT,
      ZSTATE TEXT,
      ZZIPCODE TEXT,
      ZCOUNTRYNAME TEXT,
      ZLABEL TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0
    )
  `,
  ).run();

  db.prepare(
    `
    CREATE TABLE ZABCDURLADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZURL TEXT,
      ZLABEL TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0
    )
  `,
  ).run();

  db.prepare(
    `
    CREATE TABLE ZABCDSOCIALPROFILE (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZSERVICENAME TEXT,
      ZUSERNAME TEXT,
      ZURL TEXT,
      ZLABEL TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0
    )
  `,
  ).run();

  db.prepare(
    `
    CREATE TABLE ZABCDDATE (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZVALUE REAL,
      ZLABEL TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0
    )
  `,
  ).run();

  return db;
}

function insertContact(
  db: Db,
  pk: number,
  opts: {
    firstName?: string;
    lastName?: string;
    middleName?: string;
    organization?: string;
    department?: string;
    jobTitle?: string;
    nickname?: string;
    uniqueId: string;
    creationDate: Date;
    modificationDate: Date;
    isMe?: boolean;
  },
) {
  db.prepare(
    `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZLASTNAME, ZMIDDLENAME, ZORGANIZATION, ZDEPARTMENT, ZJOBTITLE, ZNICKNAME, ZCREATIONDATE, ZMODIFICATIONDATE, ZUNIQUEID, ZCONTAINERWHERECONTACTISME)
     VALUES (?, 22, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pk,
    opts.firstName ?? null,
    opts.lastName ?? null,
    opts.middleName ?? null,
    opts.organization ?? null,
    opts.department ?? null,
    opts.jobTitle ?? null,
    opts.nickname ?? null,
    toCoreData(opts.creationDate),
    toCoreData(opts.modificationDate),
    opts.uniqueId,
    opts.isMe ? 1 : null,
  );
}

function insertEmail(db: Db, pk: number, ownerPk: number, address: string, label?: string) {
  db.prepare(
    `INSERT INTO ZABCDEMAILADDRESS (Z_PK, ZOWNER, ZADDRESS, ZLABEL, ZORDERINGINDEX)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(pk, ownerPk, address, label ?? null);
}

function insertPhone(
  db: Db,
  pk: number,
  ownerPk: number,
  fullNumber: string,
  label?: string,
  countryCode?: string,
) {
  db.prepare(
    `INSERT INTO ZABCDPHONENUMBER
       (Z_PK, ZOWNER, ZFULLNUMBER, ZLABEL, ZCOUNTRYCODE, ZORDERINGINDEX)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(pk, ownerPk, fullNumber, label ?? null, countryCode ?? null);
}

function insertDeleted(db: Db, pk: number, uniqueId: string) {
  db.prepare(
    `INSERT INTO ZABCDDELETEDRECORDLOG (Z_PK, ZDELETEDRECORDUNIQUEID)
     VALUES (?, ?)`,
  ).run(pk, uniqueId);
}

function insertAddress(
  db: Db,
  pk: number,
  ownerPk: number,
  opts: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    label?: string;
  },
) {
  db.prepare(
    `INSERT INTO ZABCDPOSTALADDRESS (Z_PK, ZOWNER, ZSTREET, ZCITY, ZSTATE, ZZIPCODE, ZCOUNTRYNAME, ZLABEL)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pk,
    ownerPk,
    opts.street ?? null,
    opts.city ?? null,
    opts.state ?? null,
    opts.zip ?? null,
    opts.country ?? null,
    opts.label ?? null,
  );
}

function insertUrl(db: Db, pk: number, ownerPk: number, url: string, label?: string) {
  db.prepare(`INSERT INTO ZABCDURLADDRESS (Z_PK, ZOWNER, ZURL, ZLABEL) VALUES (?, ?, ?, ?)`).run(
    pk,
    ownerPk,
    url,
    label ?? null,
  );
}

function insertSocial(
  db: Db,
  pk: number,
  ownerPk: number,
  opts: { service?: string; username?: string; url?: string; label?: string },
) {
  db.prepare(
    `INSERT INTO ZABCDSOCIALPROFILE (Z_PK, ZOWNER, ZSERVICENAME, ZUSERNAME, ZURL, ZLABEL)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    pk,
    ownerPk,
    opts.service ?? null,
    opts.username ?? null,
    opts.url ?? null,
    opts.label ?? null,
  );
}

function insertDate(db: Db, pk: number, ownerPk: number, when: Date, label: string) {
  db.prepare(`INSERT INTO ZABCDDATE (Z_PK, ZOWNER, ZVALUE, ZLABEL) VALUES (?, ?, ?, ?)`).run(
    pk,
    ownerPk,
    toCoreData(when),
    label,
  );
}

describe("AppleContactsSource", () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: Db;
  let provider: AppleProvider;
  let source: AppleContactsSource;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-test-"));
    dbPath = join(tmpDir, "AddressBook-v22.abcddb");
    testDb = createTestDb(dbPath);

    // Insert test contacts
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);

    insertContact(testDb, 1, {
      firstName: "John",
      lastName: "Smith",
      uniqueId: "UUID-001:ABPerson",
      creationDate: yesterday,
      modificationDate: yesterday,
    });
    insertEmail(testDb, 1, 1, "john@example.com", "_$!<Home>!$_");
    insertEmail(testDb, 2, 1, "john.smith@work.com", "_$!<Work>!$_");
    insertPhone(testDb, 1, 1, "+1 212 555 1234", "_$!<Mobile>!$_");

    insertContact(testDb, 2, {
      firstName: "Jane",
      lastName: "Doe",
      organization: "Acme Corp",
      jobTitle: "Engineer",
      uniqueId: "UUID-002:ABPerson",
      creationDate: yesterday,
      modificationDate: now,
    });
    insertEmail(testDb, 3, 2, "jane@acme.com");
    insertPhone(testDb, 2, 2, "+44 7700 000000");

    insertContact(testDb, 3, {
      organization: "No Name Inc",
      uniqueId: "UUID-003:ABPerson",
      creationDate: yesterday,
      modificationDate: yesterday,
    });
    // Give UUID-003 a phone so it survives the empty-card skip — the
    // assertion below confirms an org-only name is still used as the title.
    insertPhone(testDb, 3, 3, "+1 415 555 7777", "_$!<Work>!$_");

    insertContact(testDb, 4, {
      firstName: "Me",
      lastName: "Myself",
      uniqueId: "UUID-ME:ABPerson",
      creationDate: yesterday,
      modificationDate: yesterday,
      isMe: true,
    });

    // Insert a group record (Z_ENT != 22) — should be skipped
    testDb
      .prepare(
        `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZCREATIONDATE, ZMODIFICATIONDATE, ZUNIQUEID)
       VALUES (99, 24, 'Group', ?, ?, 'UUID-GROUP')`,
      )
      .run(toCoreData(yesterday), toCoreData(yesterday));

    // Close the test DB so the source can open it readonly
    testDb.close();

    provider = new AppleProvider({
      contactsDirPath: dirname(dbPath),
      accountId: "test@icloud.com",
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("bootstrap sync returns all contacts", async () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);

    // Should have 4 person contacts, not the group
    expect(result.documents.length).toBe(4);
    expect(result.hasMore).toBe(false);
    expect(result.progress?.phase).toBe("bootstrap");
    expect(result.progress?.total).toBe(4);
  });

  test("contact has correct metadata structure", async () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);

    const john = result.documents.find((d) => d.title === "John Smith");
    expect(john).toBeDefined();
    expect(john!.metadata.documentType).toBe("contact");
    expect(john!.metadata.people).toBeDefined();
    expect(john!.metadata.people!.length).toBe(1);

    const person = john!.metadata.people![0];
    expect(person.role).toBe("contact");
    expect(person.name).toBe("John Smith");
    expect(person.emails).toEqual(["john@example.com", "john.smith@work.com"]);
    expect(person.phones).toEqual(["+12125551234"]);
  });

  test("contact with only organization uses org as name", async () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);

    const org = result.documents.find((d) => d.title === "No Name Inc");
    expect(org).toBeDefined();
    expect(org!.metadata.people![0].name).toBe("No Name Inc");
  });

  test("me contact is flagged in extra", async () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);

    const me = result.documents.find((d) => d.title === "Me Myself");
    expect(me).toBeDefined();
    expect(me!.metadata.extra!.isMe).toBe(true);
  });

  test("incremental sync returns only modified contacts", async () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const bootstrap = await source.sync(null);
    const cursor = bootstrap.cursor;

    // Reopen DB to add a new contact
    const db = new Database(dbPath);
    const future = new Date(Date.now() + 86400000);
    insertContact(db, 5, {
      firstName: "New",
      lastName: "Contact",
      uniqueId: "UUID-005:ABPerson",
      creationDate: future,
      modificationDate: future,
    });
    insertPhone(db, 5, 5, "+1 212 555 9999");
    db.close();

    const incremental = await source.sync(cursor);
    expect(incremental.documents.length).toBe(1);
    expect(incremental.documents[0].title).toBe("New Contact");
    expect(incremental.progress).toBeUndefined();
  });

  test("deletion detection works", async () => {
    const db = new Database(dbPath);
    insertDeleted(db, 1, "UUID-DELETED:ABPerson");
    db.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);
    expect(result.deletedExternalIds).toContain("UUID-DELETED:ABPerson");
  });

  test("content includes email and phone with labels", async () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);

    const john = result.documents.find((d) => d.title === "John Smith");
    expect(john!.content).toContain("**Email (Home):** john@example.com");
    expect(john!.content).toContain("**Email (Work):** john.smith@work.com");
    expect(john!.content).toContain("**Phone (Mobile):** +1 212 555 1234");
  });

  test("source id includes account", () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    expect(source.id).toBe(SourceId("apple-contacts:test@icloud.com"));
  });

  test("source has watch paths", () => {
    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    expect(source.watchPaths.length).toBeGreaterThan(0);
  });

  test("surfaces postal addresses, URLs, social profiles, birthdays, custom dates", async () => {
    // Reproduces apple-contacts-missing-fields: previously every aux table
    // was silently dropped, so the rendered card was just name + org +
    // emails + phones + nickname.
    const reopen = new Database(dbPath);
    insertContact(reopen, 100, {
      firstName: "Maya",
      lastName: "Reeves",
      organization: "Stellar Sound",
      uniqueId: "UUID-100:ABPerson",
      creationDate: new Date("2024-01-01T00:00:00Z"),
      modificationDate: new Date("2024-01-02T00:00:00Z"),
    });
    insertEmail(reopen, 990, 100, "maya.reeves@example.com", "_$!<Home>!$_");
    insertAddress(reopen, 991, 100, {
      street: "10 Downing St",
      city: "London",
      zip: "SW1A 2AA",
      country: "United Kingdom",
      label: "_$!<Home>!$_",
    });
    insertUrl(reopen, 992, 100, "https://maya.example.com", "_$!<Home>!$_");
    insertSocial(reopen, 993, 100, {
      service: "LinkedIn",
      username: "mreeves",
      url: "https://linkedin.com/in/mreeves",
    });
    insertDate(reopen, 994, 100, new Date("1992-04-15T00:00:00Z"), "_$!<Birthday>!$_");
    insertDate(reopen, 995, 100, new Date("2010-06-20T00:00:00Z"), "Anniversary");
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);
    const maya = result.documents.find((d) => d.title === "Maya Reeves")!;
    expect(maya).toBeDefined();

    expect(maya.content).toContain("10 Downing St");
    expect(maya.content).toContain("London");
    expect(maya.content).toContain("https://maya.example.com");
    expect(maya.content).toContain("LinkedIn");
    expect(maya.content).toContain("1992-04-15");

    const extra = maya.metadata.extra as Record<string, any>;
    expect(extra.addresses).toBeDefined();
    expect(extra.addresses).toHaveLength(1);
    expect(extra.addresses[0].street).toBe("10 Downing St");
    expect(extra.urls).toEqual([{ label: "Home", url: "https://maya.example.com" }]);
    expect(extra.socialProfiles).toHaveLength(1);
    expect(extra.socialProfiles[0].service).toBe("LinkedIn");
    expect(extra.birthday).toBe("1992-04-15");
    expect(extra.dates).toHaveLength(2);
  });

  test("region inference from address country: French address + bare-national French phone normalizes to E.164", async () => {
    // Reproduces the region-inference case: a French contact
    // with a bare-national-format phone like "06 39 98 00 33" used to
    // drop entirely because normalizePhone fell through to the system
    // locale → "US" chain without ever knowing the contact lived in
    // France. Now the provider feeds the address country as a region
    // hint, so the phone parses to +33639980033.
    const reopen = new Database(dbPath);
    insertContact(reopen, 250, {
      firstName: "Jamie",
      lastName: "Lopez",
      uniqueId: "UUID-250:ABPerson",
      creationDate: new Date("2024-04-01T00:00:00Z"),
      modificationDate: new Date("2024-04-02T00:00:00Z"),
    });
    insertAddress(reopen, 1250, 250, {
      street: "10 rue de Rivoli",
      city: "Paris",
      zip: "75001",
      country: "France",
      label: "_$!<Home>!$_",
    });
    insertPhone(reopen, 1251, 250, "06 39 98 00 33", "_$!<Mobile>!$_");
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);
    const jamie = result.documents.find((d) => d.title === "Jamie Lopez");
    expect(jamie).toBeDefined();

    // Body keeps the user-typed raw form.
    expect(jamie!.content).toContain("06 39 98 00 33");

    // Mention has the E.164 form thanks to region inference from the
    // French address.
    const person = jamie!.metadata.people![0];
    expect(person.phones).toEqual(["+33639980033"]);
  });

  test("per-number country metadata wins over address and collector defaults", async () => {
    const reopen = new Database(dbPath);
    insertContact(reopen, 350, {
      firstName: "Priya",
      lastName: "Nair",
      uniqueId: "UUID-350:ABPerson",
      creationDate: new Date("2024-04-05T00:00:00Z"),
      modificationDate: new Date("2024-04-06T00:00:00Z"),
    });
    insertAddress(reopen, 1353, 350, { country: "France" });
    insertPhone(reopen, 1354, 350, "07700 000000", "_$!<Mobile>!$_", "gb");
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
      phoneRegion: "US",
    });
    const result = await source.sync(null);
    const priya = result.documents.find((d) => d.title === "Priya Nair");
    expect(priya?.metadata.people?.[0].phones).toEqual(["+447700000000"]);
  });

  test("collector phone region handles an address-less national number", async () => {
    const reopen = new Database(dbPath);
    insertContact(reopen, 351, {
      firstName: "Robin",
      lastName: "Vale",
      uniqueId: "UUID-351:ABPerson",
      creationDate: new Date("2024-04-07T00:00:00Z"),
      modificationDate: new Date("2024-04-08T00:00:00Z"),
    });
    insertPhone(reopen, 1355, 351, "020 7123 4567");
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
      phoneRegion: "GB",
    });
    const result = await source.sync(null);
    const robin = result.documents.find((d) => d.title === "Robin Vale");
    expect(robin?.metadata.people?.[0].phones).toEqual(["+442071234567"]);
  });

  test("region inference: contact with no address still uses existing fallback chain (E.164 input works)", async () => {
    // Sanity check the no-address path: an explicitly-international
    // (+33...) phone parses fine without any region hint thanks to the
    // "starts with +" branch of normalizePhone. This keeps the
    // address-less case working for downstream callers.
    const reopen = new Database(dbPath);
    insertContact(reopen, 251, {
      firstName: "No",
      lastName: "Address",
      uniqueId: "UUID-251:ABPerson",
      creationDate: new Date("2024-04-03T00:00:00Z"),
      modificationDate: new Date("2024-04-04T00:00:00Z"),
    });
    insertPhone(reopen, 1252, 251, "+33639980033", "_$!<Mobile>!$_");
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);
    const noAddr = result.documents.find((d) => d.title === "No Address");
    expect(noAddr).toBeDefined();
    expect(noAddr!.metadata.people![0].phones).toEqual(["+33639980033"]);
  });

  test("region inference: unknown country name falls through to system-locale fallback (no error)", async () => {
    // Atlantis isn't in the ISO-2 map, so countryNameToISO2 returns
    // undefined. The provider passes no hint, the existing fallback
    // chain (system locale → "US") still runs, and an E.164-prefixed
    // input still works fine. This pins the "graceful degradation"
    // behavior so future map shrinks/expansions can't silently break
    // these contacts.
    const reopen = new Database(dbPath);
    insertContact(reopen, 252, {
      firstName: "Atlantean",
      lastName: "Contact",
      uniqueId: "UUID-252:ABPerson",
      creationDate: new Date("2024-04-05T00:00:00Z"),
      modificationDate: new Date("2024-04-06T00:00:00Z"),
    });
    insertAddress(reopen, 1253, 252, {
      country: "Atlantis",
      label: "_$!<Home>!$_",
    });
    insertPhone(reopen, 1254, 252, "+12125551234", "_$!<Mobile>!$_");
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);
    const atlantean = result.documents.find((d) => d.title === "Atlantean Contact");
    expect(atlantean).toBeDefined();
    expect(atlantean!.metadata.people![0].phones).toEqual(["+12125551234"]);
  });

  test("body↔mention phone invariant: rendered phone has matching E.164 in metadata.people", async () => {
    // Contact with a "00"-prefixed (international-access-code) phone — the
    // E.123 IDD style. This input shape previously dropped silently when
    // normalizePhone didn't recognize "00" as equivalent to "+". The fix
    // landed in core; this test pins the body↔mention contract on
    // the Apple Contacts side: every phone rendered in the markdown must
    // also appear as a valid E.164 string in metadata.people[0].phones.
    //
    // Uses a French mobile in IDD form (00 33 6 39 98 00 33) — the
    // canonical regression case from people-utils.test.ts. The original
    // bug-report number "00 7 700 000 258" is malformed per libphonenumber
    // (only 9 digits after +7 instead of 10) and tests `null` separately
    // in core.
    const reopen = new Database(dbPath);
    insertContact(reopen, 200, {
      firstName: "Pierre",
      lastName: "Dubois",
      uniqueId: "UUID-200:ABPerson",
      creationDate: new Date("2024-02-01T00:00:00Z"),
      modificationDate: new Date("2024-02-02T00:00:00Z"),
    });
    insertPhone(reopen, 996, 200, "00 33 6 39 98 00 33", "_$!<Mobile>!$_");
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);
    const pierre = result.documents.find((d) => d.title === "Pierre Dubois");
    expect(pierre).toBeDefined();

    // The raw phone string MUST appear in the rendered body.
    expect(pierre!.content).toContain("00 33 6 39 98 00 33");

    // And the same logical number MUST appear in metadata.people[0].phones
    // as a non-empty E.164 string. This is the body↔mention invariant: if
    // the body shows a phone, the mention must too — otherwise downstream
    // people-resolution misses the link.
    const person = pierre!.metadata.people![0];
    expect(person.phones).toBeDefined();
    expect(person.phones!.length).toBeGreaterThan(0);
    const e164 = person.phones![0];
    expect(typeof e164).toBe("string");
    expect(e164.startsWith("+")).toBe(true);

    // Cross-check that body-rendered phone and E.164 mention are the same
    // logical number: strip non-digits from both, drop the leading "00"
    // IDD prefix from the body version (E.123 equivalent of "+"), and the
    // remaining digits must match exactly.
    const bodyDigits = "00 33 6 39 98 00 33".replace(/\D/g, "");
    const bodyDigitsNoIntlPrefix = bodyDigits.replace(/^00/, "");
    const e164Digits = e164.replace(/\D/g, "");
    expect(e164Digits).toBe(bodyDigitsNoIntlPrefix);
    expect(e164).toBe("+33639980033");
  });

  test("skip empty card when contact has no email/phone/address/URL/social/date and isMe=false", async () => {
    // Reproduces the production audit on 2026-05-05: Apple syncs a 'me'
    // record across multiple iCloud containers as completely empty
    // duplicates. We drop those (isMe=false + zero identifying data) but
    // the cursor must still advance over them.
    const localDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-skip-empty-test-"));
    const localDbPath = join(localDir, "AddressBook-v22.abcddb");
    const localDb = createTestDb(localDbPath);
    insertContact(localDb, 1, {
      firstName: "Empty",
      lastName: "Card",
      uniqueId: "UUID-EMPTY:ABPerson",
      creationDate: new Date("2024-03-01T00:00:00Z"),
      modificationDate: new Date("2024-03-02T00:00:00Z"),
    });
    localDb.close();

    const localProvider = new AppleProvider({
      contactsDirPath: dirname(localDbPath),
      accountId: "skip@icloud.com",
    });
    const localSource = new AppleContactsSource(localProvider, {
      sourceId: "apple-contacts:skip@icloud.com",
      providerId: "apple:skip@icloud.com",
    });
    const result = await localSource.sync(null);

    // Empty non-me card was skipped — zero documents emitted.
    expect(result.documents.length).toBe(0);

    // But the cursor MUST still advance over it, otherwise we'd loop
    // forever re-fetching the same empty rows.
    const cursor = result.cursor as { lastModifiedTimestamp?: number };
    expect(cursor.lastModifiedTimestamp).toBeGreaterThan(0);

    rmSync(localDir, { recursive: true, force: true });
  });

  test("do NOT skip empty card when isMe=true", async () => {
    // The 'me' record is special — even with no data attached it's a
    // useful anchor for downstream people-resolution.
    const localDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-skip-empty-me-test-"));
    const localDbPath = join(localDir, "AddressBook-v22.abcddb");
    const localDb = createTestDb(localDbPath);
    insertContact(localDb, 1, {
      firstName: "Empty",
      lastName: "Me",
      uniqueId: "UUID-EMPTY-ME:ABPerson",
      creationDate: new Date("2024-03-01T00:00:00Z"),
      modificationDate: new Date("2024-03-02T00:00:00Z"),
      isMe: true,
    });
    localDb.close();

    const localProvider = new AppleProvider({
      contactsDirPath: dirname(localDbPath),
      accountId: "skipme@icloud.com",
    });
    const localSource = new AppleContactsSource(localProvider, {
      sourceId: "apple-contacts:skipme@icloud.com",
      providerId: "apple:skipme@icloud.com",
    });
    const result = await localSource.sync(null);

    expect(result.documents.length).toBe(1);
    expect(result.documents[0].metadata.extra!.isMe).toBe(true);

    rmSync(localDir, { recursive: true, force: true });
  });

  test("do NOT skip card when there's at least one phone", async () => {
    // Sanity check that the skip predicate isn't over-eager: a single
    // phone is enough to keep the card.
    const localDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-skip-empty-phone-test-"));
    const localDbPath = join(localDir, "AddressBook-v22.abcddb");
    const localDb = createTestDb(localDbPath);
    insertContact(localDb, 1, {
      firstName: "Has",
      lastName: "Phone",
      uniqueId: "UUID-HAS-PHONE:ABPerson",
      creationDate: new Date("2024-03-01T00:00:00Z"),
      modificationDate: new Date("2024-03-02T00:00:00Z"),
    });
    insertPhone(localDb, 1, 1, "+1 415 555 0000");
    localDb.close();

    const localProvider = new AppleProvider({
      contactsDirPath: dirname(localDbPath),
      accountId: "phone@icloud.com",
    });
    const localSource = new AppleContactsSource(localProvider, {
      sourceId: "apple-contacts:phone@icloud.com",
      providerId: "apple:phone@icloud.com",
    });
    const result = await localSource.sync(null);

    expect(result.documents.length).toBe(1);
    expect(result.documents[0].title).toBe("Has Phone");

    rmSync(localDir, { recursive: true, force: true });
  });

  test("missing aux tables (older macOS) degrade gracefully", async () => {
    // Drop the aux tables to simulate an older schema; sync should still
    // produce a doc with just the core fields.
    const reopen = new Database(dbPath);
    reopen.exec(
      "DROP TABLE ZABCDPOSTALADDRESS; DROP TABLE ZABCDURLADDRESS; DROP TABLE ZABCDSOCIALPROFILE; DROP TABLE ZABCDDATE;",
    );
    reopen.close();

    source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
    const result = await source.sync(null);
    expect(result.documents.length).toBeGreaterThan(0);
    // No aux fields, just core ones.
    const first = result.documents[0];
    const extra = first.metadata.extra as Record<string, any>;
    expect(extra.addresses).toBeUndefined();
    expect(extra.urls).toBeUndefined();
  });
});

describe("AppleContactsSource — snapshot reconciliation", () => {
  let tmpDir: string;
  let dbPath: string;
  let provider: AppleProvider;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-snapshot-test-"));
    dbPath = join(tmpDir, "AddressBook-v22.abcddb");
    const db = createTestDb(dbPath);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);

    insertContact(db, 1, {
      firstName: "Alice",
      uniqueId: "uuid-alice",
      creationDate: yesterday,
      modificationDate: yesterday,
    });
    insertContact(db, 2, {
      firstName: "Bob",
      uniqueId: "uuid-bob",
      creationDate: yesterday,
      modificationDate: yesterday,
    });
    insertContact(db, 3, {
      firstName: "Carol",
      uniqueId: "uuid-carol",
      creationDate: yesterday,
      modificationDate: yesterday,
    });

    db.close();
    provider = new AppleProvider({
      contactsDirPath: dirname(dbPath),
      accountId: "snap@icloud.com",
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Every id the page vouched for, in whichever shape it used. */
  const vouchedIds = (result: {
    presentExternalIds?: string[];
    presentClaims?: { partition: string; ids: string[] }[];
  }): string[] =>
    [
      ...new Set([
        ...(result.presentExternalIds ?? []),
        ...(result.presentClaims ?? []).flatMap((c) => c.ids),
      ]),
    ].sort();

  test("a complete read vouches for the whole source, not book by book", async () => {
    const source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:snap@icloud.com",
      providerId: "apple:snap@icloud.com",
    });

    const result = await source.sync(null);
    expect(result.hasMore).toBe(false);
    expect(vouchedIds(result)).toEqual(["uuid-alice", "uuid-bob", "uuid-carol"]);
  });

  test("soft-deleted contacts (in ZABCDDELETEDRECORDLOG) are excluded from the snapshot even if they still appear in ZABCDRECORD", async () => {
    // Tombstone Bob via ZABCDDELETEDRECORDLOG (the path that's empty on
    // iCloud-backed Macs, but works on local-only Macs — test exercise).
    const db = new Database(dbPath);
    insertDeleted(db, 1, "uuid-bob");
    db.close();

    const source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:snap@icloud.com",
      providerId: "apple:snap@icloud.com",
    });

    const result = await source.sync(null);
    expect(result.deletedExternalIds).toContain("uuid-bob");
    expect(vouchedIds(result)).toEqual(["uuid-alice", "uuid-carol"]);
  });

  test("hard-deleted contact (gone from ZABCDRECORD with no tombstone) is missing from the snapshot — gateway will reconcile", async () => {
    // Hard-delete Carol — no row left, no tombstone log entry.
    const db = new Database(dbPath);
    db.prepare("DELETE FROM ZABCDRECORD WHERE ZUNIQUEID = ?").run("uuid-carol");
    db.close();

    const source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:snap@icloud.com",
      providerId: "apple:snap@icloud.com",
    });

    const result = await source.sync(null);
    // Carol's UUID isn't in deletedExternalIds (no tombstone) but the
    // snapshot omits it — the gateway-side diff will catch the deletion.
    expect(result.deletedExternalIds).not.toContain("uuid-carol");
    expect(result.presentExternalIds).toBeDefined();
    expect(vouchedIds(result)).not.toContain("uuid-carol");
  });

  test("a partial page vouches for nothing — only the final page claims", async () => {
    // Insert 150 contacts to force pagination (PAGE_SIZE = 100). One
    // transaction, so the fixture costs a single commit rather than 150.
    const db = new Database(dbPath);
    const future = new Date(Date.now() + 86400000);
    db.transaction(() => {
      for (let i = 0; i < 150; i++) {
        insertContact(db, 100 + i, {
          firstName: `Bulk${i}`,
          uniqueId: `uuid-bulk-${i}`,
          creationDate: future,
          modificationDate: future,
        });
      }
    })();
    db.close();

    const source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:snap@icloud.com",
      providerId: "apple:snap@icloud.com",
    });

    // First page returns hasMore=true. Snapshot must NOT be emitted on
    // partial pages — it would race with subsequent pages and look like
    // a complete enum prematurely.
    const page1 = await source.sync(null);
    expect(page1.hasMore).toBe(true);
    expect(page1.presentClaims).toBeUndefined();
    expect(page1.presentExternalIds).toBeUndefined();

    // Drain remaining pages. Final one emits the snapshot.
    let cursor = page1.cursor;
    let lastResult = page1;
    let safety = 10;
    while (lastResult.hasMore && safety-- > 0) {
      lastResult = await source.sync(cursor);
      cursor = lastResult.cursor;
    }
    expect(lastResult.hasMore).toBe(false);
    expect(lastResult.presentExternalIds).toBeDefined();
    expect(vouchedIds(lastResult).length).toBeGreaterThan(100);
  });
});

describe("AppleContactsSource — boundary-tied pagination", () => {
  let tmpDir: string;
  let dbPath: string;
  let provider: AppleProvider;

  const TIED_COUNT = 150;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-tie-test-"));
    dbPath = join(tmpDir, "AddressBook-v22.abcddb");
    const db = createTestDb(dbPath);

    // Bulk address-book import: >PAGE_SIZE (100) contacts all written with
    // the IDENTICAL modificationDate, as iCloud activation / import does.
    // Each carries a phone so it survives the empty-card skip and is emitted
    // as a real document. The whole load runs in one transaction — otherwise
    // every row is its own commit, and 300 fsyncs make this hook slower than
    // the hook timeout on a busy machine.
    const shared = new Date("2030-01-01T00:00:00Z");
    db.transaction(() => {
      for (let i = 0; i < TIED_COUNT; i++) {
        insertContact(db, 1 + i, {
          firstName: `Member${i}`,
          uniqueId: `uuid-tie-${String(i).padStart(3, "0")}`,
          creationDate: shared,
          modificationDate: shared,
        });
        insertPhone(db, 1 + i, 1 + i, `+1 555 010 ${String(1000 + i).slice(-4)}`);
      }
    })();

    db.close();
    provider = new AppleProvider({
      contactsDirPath: dirname(dbPath),
      accountId: "tie@icloud.com",
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("emits every contact across pages when more than PAGE_SIZE share the boundary timestamp", async () => {
    const source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:tie@icloud.com",
      providerId: "apple:tie@icloud.com",
    });

    const emitted = new Set<string>();
    let result = await source.sync(null);
    for (const doc of result.documents) emitted.add(doc.externalId);

    let safety = 20;
    while (result.hasMore && safety-- > 0) {
      result = await source.sync(result.cursor);
      for (const doc of result.documents) emitted.add(doc.externalId);
    }

    expect(result.hasMore).toBe(false);

    // The union of documents across all pages must cover all tied contacts.
    // With a scalar `> modificationDate` cursor, the contacts past position
    // PAGE_SIZE that share the boundary timestamp are dropped (only ~100 of
    // 150 are emitted); the composite (modificationDate, uniqueId) cursor
    // resumes mid-timestamp and emits all of them.
    const expectedIds = Array.from(
      { length: TIED_COUNT },
      (_, i) => `uuid-tie-${String(i).padStart(3, "0")}`,
    );
    for (const id of expectedIds) {
      expect(emitted.has(id)).toBe(true);
    }
    expect(emitted.size).toBe(TIED_COUNT);
  });
});

// The declared profile is what subscription compilation reads when it turns
// "when a card at my employer changes" into a document predicate, so each
// declared role and path has to be something a synced card really carries. The
// final assertion re-lists the declared paths, so adding one without proving
// the normalizer emits it fails here.
describe("AppleContactsSource — declared document profile", () => {
  let tmpDir: string;
  let provider: AppleProvider;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-profile-test-"));
    const dbPath = join(tmpDir, "AddressBook-v22.abcddb");
    const db = createTestDb(dbPath);
    const when = new Date("2024-03-08T00:00:00Z");

    insertContact(db, 1, {
      firstName: "Sarah",
      lastName: "Mendez",
      organization: "Acme Corp",
      jobTitle: "Engineer",
      department: "Instrumentation",
      uniqueId: "uuid-profile-contact",
      creationDate: when,
      modificationDate: when,
    });
    insertEmail(db, 1, 1, "sarah.mendez@example.com");

    db.close();
    provider = new AppleProvider({
      contactsDirPath: dirname(dbPath),
      accountId: "test@icloud.com",
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("emits every person role and metadata field the document profile declares", async () => {
    const source = new AppleContactsSource(provider, {
      sourceId: "apple-contacts:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });

    const [doc] = (await source.sync(null)).documents;

    expect(appleContactsDocumentProfile.documentTypes).toContain(doc.metadata.documentType);
    expect(new Set(doc.metadata.people?.map((p) => p.role))).toEqual(
      new Set(appleContactsDocumentProfile.personRoles),
    );
    expect(doc.metadata.extra?.organization).toBe("Acme Corp");
    expect(doc.metadata.extra?.jobTitle).toBe("Engineer");
    expect(doc.metadata.extra?.department).toBe("Instrumentation");
    expect(doc.metadata.extra?.isMe).toBe(false);
    expect(appleContactsDocumentProfile.metadataFields?.map((f) => f.path)).toEqual([
      "extra.organization",
      "extra.jobTitle",
      "extra.department",
      "extra.isMe",
    ]);
  });
});

describe("AppleContactsSource — partial address-book reads", () => {
  let tmpDir: string;
  let goodStore: string;
  let brokenStore: string;
  let provider: AppleProvider;

  function seed(dbPath: string, entries: Array<{ pk: number; name: string; uniqueId: string }>) {
    rmSync(dbPath, { force: true });
    const db = createTestDb(dbPath);
    const when = new Date(Date.now() - 86400000);
    for (const e of entries) {
      insertContact(db, e.pk, {
        firstName: e.name,
        uniqueId: e.uniqueId,
        creationDate: when,
        modificationDate: when,
      });
      insertEmail(db, e.pk, e.pk, `${e.name.toLowerCase()}@example.com`);
    }
    db.close();
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-partial-test-"));
    const sources = join(tmpDir, "Sources");
    goodStore = join(sources, "store-one", "AddressBook-v22.abcddb");
    brokenStore = join(sources, "store-two", "AddressBook-v22.abcddb");
    mkdirSync(dirname(goodStore), { recursive: true });
    mkdirSync(dirname(brokenStore), { recursive: true });
    seed(goodStore, [
      { pk: 1, name: "Maya", uniqueId: "uuid-maya" },
      { pk: 2, name: "Jamie", uniqueId: "uuid-jamie" },
    ]);
    seed(brokenStore, [
      { pk: 1, name: "David", uniqueId: "uuid-david" },
      { pk: 2, name: "Sarah", uniqueId: "uuid-sarah" },
    ]);
    provider = new AppleProvider({
      contactsDirPath: tmpDir,
      accountId: "partial@example.com",
    });
  });

  afterEach(async () => {
    await provider.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function newSource(p: AppleProvider): AppleContactsSource {
    return new AppleContactsSource(p, {
      sourceId: "apple-contacts:partial@example.com",
      providerId: "apple:partial@example.com",
    });
  }

  /** Replace a store's file with bytes SQLite refuses to open. */
  function corrupt(path: string) {
    writeFileSync(path, "not a sqlite database at all");
  }

  /**
   * The books this cycle vouched for individually, by key.
   *
   * Empty on a complete read: that vouches for the whole source through
   * `presentExternalIds`, which reaches every document rather than only the
   * ones stamped with a book this cycle happened to name.
   */
  const books = (r: { presentClaims?: { partition: string }[] }): string[] =>
    (r.presentClaims ?? []).map((c) => c.partition).sort();
  /** Every id vouched for, in whichever shape the cycle used. */
  const vouched = (r: {
    presentExternalIds?: string[];
    presentClaims?: { ids: string[] }[];
  }): string[] =>
    [
      ...new Set([
        ...(r.presentExternalIds ?? []),
        ...(r.presentClaims ?? []).flatMap((c) => c.ids),
      ]),
    ].sort();

  test("both address books readable — the read vouches for the whole source", async () => {
    // Not book by book. A complete read is the strongest thing this source can
    // say, and the only shape that reaches a contact stored before the source
    // ever named a book — or one whose book has been renamed by a re-signed
    // account or a restored backup.
    const result = await newSource(provider).sync(null);
    expect(result.hasMore).toBe(false);
    expect(books(result)).toEqual([]);
    expect(result.presentExternalIds?.sort()).toEqual([
      "uuid-david",
      "uuid-jamie",
      "uuid-maya",
      "uuid-sarah",
    ]);
  });

  test("an address book that fails to open takes only itself out of the claim", async () => {
    corrupt(brokenStore);
    const result = await newSource(provider).sync(null);

    // The readable store's contacts still sync — a degraded read is not a
    // failed one.
    expect(result.documents.map((d) => d.externalId).sort()).toEqual(["uuid-jamie", "uuid-maya"]);
    // And it still vouches for itself. The book that would not open is simply
    // not claimed, so nothing in it is evidence of anything. Withholding the
    // whole snapshot protects it too, and pays with the readable book's
    // deletion detection for as long as the other stays broken.
    expect(books(result)).toEqual(["store-one"]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    expect(vouched(result)).toEqual(["uuid-jamie", "uuid-maya"]);
  });

  test("a document carries the book it was read from, or the claim names nothing", async () => {
    const result = await newSource(provider).sync(null);
    const byId = new Map(result.documents.map((d) => [d.externalId, d.partitionKey]));
    expect(byId.get("uuid-maya")).toBe("store-one");
    expect(byId.get("uuid-david")).toBe("store-two");
  });

  test("an address book that will not open at all withholds the snapshot too", async () => {
    // The other degraded-read test corrupts the file, so SQLite opens it and
    // fails on the first query. This one makes the open itself fail — the
    // shape of a Full-Disk-Access denial, which is how the classification
    // `openAppleDb` returns is meant to be used rather than discarded.
    rmSync(brokenStore, { force: true });
    mkdirSync(brokenStore, { recursive: true });

    const result = await newSource(provider).sync(null);

    expect(result.documents.map((d) => d.externalId).sort()).toEqual(["uuid-jamie", "uuid-maya"]);
    expect(books(result)).toEqual(["store-one"]);
  });

  test("an address book directory with no database file yet is a gap, not an absence", async () => {
    // An account mid-download: the `Sources/<uuid>/` directory is there, the
    // database is not. Dropping it before the enumeration sees it is the same
    // instruction to delete its contacts as a failed open would be.
    rmSync(brokenStore, { force: true });

    const result = await newSource(provider).sync(null);

    expect(result.documents.map((d) => d.externalId).sort()).toEqual(["uuid-jamie", "uuid-maya"]);
    expect(books(result)).toEqual(["store-one"]);
  });

  test("the skipped address book is named in a warning, not swallowed", async () => {
    corrupt(brokenStore);
    // WARN goes to console.warn (see @omnesis/core's logger). An operator
    // reading the collector log has to be able to tell "nothing to delete"
    // apart from "I could not look".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await newSource(provider).sync(null);
      expect(books(result)).toEqual(["store-one"]);
      const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(lines).toContain("store-two");
      expect(lines).toContain("Snapshot withheld");
    } finally {
      warn.mockRestore();
    }
  });

  test("a store that comes back is picked up, and the snapshot completes again", async () => {
    corrupt(brokenStore);
    const source = newSource(provider);

    const degraded = await source.sync(null);
    expect(books(degraded)).toEqual(["store-one"]);

    // Restore the store. A partially-opened set must not be sticky for the
    // process lifetime — the next cycle rescans and recovers.
    seed(brokenStore, [
      { pk: 1, name: "David", uniqueId: "uuid-david" },
      { pk: 2, name: "Sarah", uniqueId: "uuid-sarah" },
    ]);

    const recovered = await source.sync(degraded.cursor);
    // Back to vouching for everything, which is what repairs the documents a
    // degraded cycle's claims could not reach.
    expect(books(recovered)).toEqual([]);
    expect(vouched(recovered)).toEqual(["uuid-david", "uuid-jamie", "uuid-maya", "uuid-sarah"]);
    expect(recovered.issues).toEqual([]);
    // The recovered store's contacts must also be ingested, not merely
    // enumerated: a snapshot signature computed over the survivors alone
    // cannot notice that a store returned.
    expect(recovered.documents.map((d) => d.externalId).sort()).toEqual([
      "uuid-david",
      "uuid-sarah",
    ]);
  });

  test("a deletion in a readable book is detected while another book is broken", async () => {
    const source = newSource(provider);
    // Healthy cycle: both books vouch for themselves.
    const healthy = await source.sync(null);
    expect(vouched(healthy)).toHaveLength(4);

    // A contact is hard-deleted while one store is unreadable — the deletion
    // is simply not detected this cycle.
    const db = new Database(goodStore);
    db.prepare("DELETE FROM ZABCDRECORD WHERE ZUNIQUEID = ?").run("uuid-maya");
    db.close();
    await provider.disconnect();
    corrupt(brokenStore);
    const degraded = await source.sync(healthy.cursor);
    // This is the change: the deletion happened in the book that IS readable,
    // so it is claimed away this cycle rather than waiting on the other book's
    // repair. The broken book is simply not claimed.
    expect(books(degraded)).toEqual(["store-one"]);
    expect(vouched(degraded)).toEqual(["uuid-jamie"]);

    // And once the read is whole again the source vouches for all of it.
    await provider.disconnect();
    seed(brokenStore, [
      { pk: 1, name: "David", uniqueId: "uuid-david" },
      { pk: 2, name: "Sarah", uniqueId: "uuid-sarah" },
    ]);
    const repaired = await source.sync(degraded.cursor);
    expect(books(repaired)).toEqual([]);
    expect(vouched(repaired)).not.toContain("uuid-maya");
    expect(vouched(repaired)).toEqual(["uuid-david", "uuid-jamie", "uuid-sarah"]);
  });
});

describe("AppleContactsSource — what the cheap snapshot signature must notice", () => {
  let tmpDir: string;
  let dbPath: string;
  let provider: AppleProvider;

  const YESTERDAY = new Date(Date.now() - 86400000);
  const LAST_WEEK = new Date(Date.now() - 7 * 86400000);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-contacts-signature-test-"));
    dbPath = join(tmpDir, "AddressBook-v22.abcddb");
    provider = new AppleProvider({
      contactsDirPath: dirname(dbPath),
      accountId: "sig@example.com",
    });
  });

  afterEach(async () => {
    await provider.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const newSource = () =>
    new AppleContactsSource(provider, {
      sourceId: "apple-contacts:sig@example.com",
      providerId: "apple:sig@example.com",
    });

  const withDb = (fn: (db: Db) => void) => {
    const db = new Database(dbPath);
    fn(db);
    db.close();
  };

  test("an equal-count exchange of contacts still re-enumerates the snapshot", async () => {
    // The collision the cheap signature has to survive. One contact leaves the
    // address book in the same cycle another joins it, carrying the same
    // modification date — a contact restored from iCloud below the incremental
    // watermark. The count returns to its previous value and
    // MAX(modificationDate) stays pinned by an unrelated contact, so a
    // signature of those two terms alone is unchanged, the enumeration is
    // skipped, and the departed contact is stranded in the corpus. MAX(Z_PK)
    // is what moves: the store's primary keys are monotone, so a row that
    // ever existed raises the maximum permanently.
    createTestDb(dbPath).close();
    withDb((db) => {
      insertContact(db, 1, {
        firstName: "Jamie",
        uniqueId: "uuid-jamie",
        creationDate: LAST_WEEK,
        modificationDate: LAST_WEEK,
      });
      insertContact(db, 2, {
        firstName: "Doomed",
        uniqueId: "uuid-doomed",
        creationDate: LAST_WEEK,
        modificationDate: LAST_WEEK,
      });
      // Pins MAX(modificationDate) so the exchange below cannot move it.
      insertContact(db, 3, {
        firstName: "Maya",
        uniqueId: "uuid-maya",
        creationDate: YESTERDAY,
        modificationDate: YESTERDAY,
      });
    });

    const source = newSource();
    const first = await source.sync(null);
    expect(first.presentExternalIds?.sort()).toEqual(["uuid-doomed", "uuid-jamie", "uuid-maya"]);

    await provider.disconnect();
    withDb((db) => {
      db.prepare("DELETE FROM ZABCDRECORD WHERE ZUNIQUEID = ?").run("uuid-doomed");
      insertContact(db, 4, {
        firstName: "Restored",
        uniqueId: "uuid-restored",
        creationDate: LAST_WEEK,
        modificationDate: LAST_WEEK,
      });
    });

    const second = await newSource().sync(first.cursor);
    expect(second.presentExternalIds?.sort()).toEqual(["uuid-jamie", "uuid-maya", "uuid-restored"]);
  });

  test("a cycle where nothing changed skips the enumeration", async () => {
    // The other half of the claim: the signature still earns its keep. A
    // source that re-enumerated every cycle would pass the test above by
    // never being cheap at all.
    createTestDb(dbPath).close();
    withDb((db) => {
      insertContact(db, 1, {
        firstName: "Jamie",
        uniqueId: "uuid-jamie",
        creationDate: LAST_WEEK,
        modificationDate: LAST_WEEK,
      });
    });

    const first = await newSource().sync(null);
    expect(first.presentExternalIds).toEqual(["uuid-jamie"]);

    await provider.disconnect();
    const second = await newSource().sync(first.cursor);
    expect(second.presentExternalIds).toBeUndefined();
    expect(second.presentClaims).toBeUndefined();
  });
});
