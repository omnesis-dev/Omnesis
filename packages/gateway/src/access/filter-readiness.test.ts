// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a filter can be created on a field of an account: each state, in
 * the order they are reported, for a source hosted by one device and for one
 * whose devices each keep their own cursor; and the two counts of records a
 * filter leaves hidden. All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countUnmatchedRecords,
  filterAccountLabel,
  filterSourceName,
  readSourceFilterReadiness,
  type FilterFieldState,
} from "./filter-readiness.js";
import {
  LEDGER_PROFILE,
  PARLEY_PROFILE,
  insertDocument,
  openFilterFixture,
  publishList,
  publishProfile,
  type FilterFixture,
} from "./filter-test-utils.js";
import type { Db } from "../data/types.js";

const LEDGER = "ledger:northstar";
const PARLEY = "parley:studio";
let fixture: FilterFixture;
let db: Db;
let inventories = 0;

function device(id: string, name: string, revoked = false): void {
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at, revoked_at) VALUES (?, ?, 'collector', 1, ?)",
  ).run(id, name, revoked ? 2 : null);
}

function source(id: string, deviceId: string, mode = "exclusive", members: string[] = []): void {
  db.prepare(
    `INSERT INTO sources (id, type, account_id, device_id, multi_device_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(id, id.split(":")[0], id.split(":")[1], deviceId, mode);
  members.forEach((member, index) => {
    db.prepare("INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)").run(
      id,
      member,
      index + 1,
    );
  });
}

/** A page committed on one cursor row, by a host at `version`. */
function cursor(sourceId: string, cursorRow: string, version: number): void {
  db.prepare(
    `INSERT INTO sync_state (source_id, device_id, source_version, last_synced_at)
     VALUES (?, ?, ?, '2027-03-01T09:00:00.000Z')
     ON CONFLICT(source_id, device_id) DO UPDATE SET
       source_version = excluded.source_version, last_synced_at = excluded.last_synced_at`,
  ).run(sourceId, cursorRow, version);
}

/** A cursor row holding only what was stored before any page: display details, or a first sync's error. */
function rowWithoutPage(sourceId: string, cursorRow: string): void {
  db.prepare(
    `INSERT INTO sync_state (source_id, device_id, label, last_error, errored_at)
     VALUES (?, ?, 'maya@example.org', 'The first sync could not reach the server.', '2027-03-01T09:00:00.000Z')`,
  ).run(sourceId, cursorRow);
}

/** Record a read of the account by one cursor row: under way, ended, or a read of everything. */
function read(
  sourceId: string,
  cursorRow: string,
  minVersion: number,
  state: "open" | "ended" | "full",
): void {
  inventories += 1;
  db.prepare(
    `INSERT INTO source_inventories
       (id, source_id, cursor_row, started_at, first_received_at, observed_at, completed_at, min_source_version, full_read_at)
     VALUES (?, ?, ?, '2027-03-01T09:00:00.000Z', ?, ?, ?, ?, ?)`,
  ).run(
    `inventory-${inventories}`,
    sourceId,
    cursorRow,
    inventories,
    inventories,
    state === "open" ? null : inventories,
    minVersion,
    state === "full" ? inventories : null,
  );
}

function states(sourceId = LEDGER): Record<string, FilterFieldState> {
  const readiness = readSourceFilterReadiness(db, sourceId)!;
  return Object.fromEntries(readiness.fields.map((field) => [field.field, field.state]));
}

beforeEach(() => {
  fixture = openFilterFixture();
  db = fixture.db;
  inventories = 0;
  device("dev-laptop", "Studio Mac");
  device("dev-desktop", "Workshop PC");
  publishProfile(db, "ledger", 5, LEDGER_PROFILE);
  publishProfile(db, "parley", 1, PARLEY_PROFILE);
  db.prepare(
    "INSERT INTO source_family_meta (source_type, updated_at, resync_cost) VALUES ('ledger', 'now', ?)",
  ).run("This reads about 95,000 entries a day.");
});

afterEach(() => fixture.close());

function publishEveryList(): void {
  publishList(db, { sourceId: LEDGER, field: "extra.labelIds" }, [{ id: "L1", label: "Finance" }]);
  publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [{ id: "F1", label: "Clients" }]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: "dev-laptop" }, [
    { id: "/home/maya/work", label: "~/work" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.tagIds", deviceId: "dev-laptop" }, [
    { id: "red", label: "Red" },
  ]);
}

describe("an account hosted by one device", () => {
  beforeEach(() => source(LEDGER, "dev-laptop"));

  it("is unknown to the gateway", () => {
    expect(readSourceFilterReadiness(db, "ledger:elsewhere")).toBeNull();
  });

  it("names the device to update while its build does not write the field", () => {
    cursor(LEDGER, "", 1);
    expect(states()).toMatchObject({
      "extra.labelIds": {
        status: "collector-behind",
        devices: [{ id: "dev-laptop", name: "Studio Mac" }],
      },
      "extra.folderIds": { status: "collector-behind" },
      // Fields that old records already carry wait only for their list.
      "extra.directory": { status: "list-pending" },
      $people: { status: "ready" },
    });
  });

  it("does not call a device behind before its first sync has stored a page", () => {
    // No version reported yet: the account's first read is about to start.
    const firstRead = {
      "extra.labelIds": { status: "resyncing", processed: 0, total: null },
      "extra.folderIds": { status: "resyncing", processed: 0, total: null },
    };
    expect(states()).toMatchObject(firstRead);
    // The account's details or a first sync's error report no version either.
    rowWithoutPage(LEDGER, "");
    expect(states()).toMatchObject(firstRead);
  });

  it("names the device to update once a page shows its build writes no version", () => {
    cursor(LEDGER, "", 0);
    expect(states()["extra.labelIds"]).toEqual({
      status: "collector-behind",
      devices: [{ id: "dev-laptop", name: "Studio Mac" }],
    });
  });

  it("reports a first read by the count alone: no earlier full read gives it a total", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 3, "open");
    for (let index = 0; index < 4; index++) {
      insertDocument(db, { id: `doc-${index}`, sourceId: LEDGER, version: 3, metadata: {} });
    }
    expect(states()).toMatchObject({
      "extra.labelIds": { status: "resyncing", processed: 4, total: null },
      "extra.folderIds": { status: "resyncing", processed: 4, total: null },
    });
  });

  it("asks for a resync, with the source's own sentence, once the device is new enough", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 0, "full");
    expect(states()).toMatchObject({
      "extra.labelIds": { status: "needs-resync", cost: "This reads about 95,000 entries a day." },
      "extra.folderIds": { status: "needs-resync", cost: "This reads about 95,000 entries a day." },
    });
  });

  it("has no sentence to give when the source declares none", () => {
    db.prepare("UPDATE source_family_meta SET resync_cost = NULL").run();
    cursor(LEDGER, "", 3);
    expect(states()["extra.labelIds"]).toEqual({ status: "needs-resync", cost: null });
  });

  it("reports a resync of an account read in full before, as records at the current version out of all", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 0, "full");
    read(LEDGER, "", 3, "open");
    for (let index = 0; index < 5; index++) {
      insertDocument(db, {
        id: `doc-${index}`,
        sourceId: LEDGER,
        version: index < 2 ? 3 : 0,
        metadata: {},
      });
    }
    expect(states()).toMatchObject({
      "extra.labelIds": { status: "resyncing", processed: 2, total: 5 },
      "extra.folderIds": { status: "resyncing", processed: 2, total: 5 },
    });
  });

  it("does not count a resync by a host too old for the field as the one it needs", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 2, "open");
    expect(states()).toMatchObject({
      // New enough for labels (from version 2), not for folders (from 3).
      "extra.labelIds": { status: "resyncing" },
      "extra.folderIds": { status: "needs-resync" },
    });
  });

  it("does not take the end of a first cycle for a read of everything", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 3, "ended");
    expect(states()["extra.labelIds"]).toMatchObject({ status: "resyncing" });
  });

  it("waits for the list after a full read at a new enough version", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 3, "full");
    expect(states()).toMatchObject({
      "extra.labelIds": { status: "list-pending" },
      "extra.folderIds": { status: "list-pending" },
    });
  });

  it("is ready once read in full and listed, and stays ready through a later resync", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 3, "full");
    publishEveryList();
    const ready = Object.fromEntries(
      ["extra.labelIds", "extra.folderIds", "extra.directory", "extra.tagIds", "$people"].map(
        (field) => [field, { status: "ready" }],
      ),
    );
    expect(states()).toEqual(ready);
    read(LEDGER, "", 4, "open");
    expect(states()).toEqual(ready);
  });

  it("holds a field to the full read of its own minimum version", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 2, "full");
    publishEveryList();
    expect(states()).toMatchObject({
      "extra.labelIds": { status: "ready" },
      "extra.folderIds": { status: "needs-resync" },
    });
  });

  it("describes each field from the source's declaration", () => {
    const readiness = readSourceFilterReadiness(db, LEDGER)!;
    expect(readiness).toMatchObject({
      sourceId: LEDGER,
      sourceType: "ledger",
      profile: "declared",
      devices: [{ id: "dev-laptop", name: "Studio Mac" }],
    });
    expect(
      readiness.fields.map((field) => [
        field.field,
        field.capability,
        field.noun.one,
        field.minVersion,
      ]),
    ).toEqual([
      ["extra.labelIds", "membership", "label", 2],
      ["extra.folderIds", "tree", "folder", 3],
      ["extra.directory", "tree", "project folder", 0],
      ["extra.tagIds", "membership", "tag", 0],
      ["$people", "person", "person", 0],
    ]);
    expect(readiness.fields[4]!.identifiers).toEqual(["email", "phone", "domain"]);
    expect(readiness.fields[1]!.declaration).toMatchObject({ picker: "tree", scope: "global" });
  });
});

describe("what the gateway cannot read", () => {
  beforeEach(() => source(LEDGER, "dev-laptop"));

  it("lists no field when no profile was published, or one from before filter declarations", () => {
    db.prepare("DELETE FROM source_document_profiles").run();
    expect(readSourceFilterReadiness(db, LEDGER)).toMatchObject({
      profile: "no-profile",
      fields: [],
    });
    publishProfile(db, "ledger", 0, LEDGER_PROFILE);
    expect(readSourceFilterReadiness(db, LEDGER)).toMatchObject({
      profile: "collector-behind",
      fields: [],
      devices: [{ id: "dev-laptop" }],
    });
  });

  it("says the gateway is behind for a capability it does not have", () => {
    const profile = structuredClone(LEDGER_PROFILE) as unknown as {
      metadataFields: Array<{ filter: { capability: string } }>;
    };
    profile.metadataFields[0]!.filter.capability = "date-range";
    publishProfile(db, "ledger", 6, profile as never);
    expect(states()["extra.labelIds"]).toEqual({ status: "gateway-behind" });
  });

  it("leaves out a field whose declaration breaks the contract", () => {
    const profile = structuredClone(LEDGER_PROFILE) as unknown as {
      metadataFields: Array<{ filter: { picker: string } }>;
    };
    profile.metadataFields[0]!.filter.picker = "carousel";
    publishProfile(db, "ledger", 6, profile as never);
    expect(Object.keys(states())).not.toContain("extra.labelIds");
  });
});

describe("an account whose devices each keep their own cursor", () => {
  beforeEach(() => source(LEDGER, "dev-laptop", "partitioned", ["dev-laptop", "dev-desktop"]));

  it("names only the devices that are behind", () => {
    cursor(LEDGER, "dev-laptop", 3);
    cursor(LEDGER, "dev-desktop", 1);
    expect(states()["extra.labelIds"]).toEqual({
      status: "collector-behind",
      devices: [{ id: "dev-desktop", name: "Workshop PC" }],
    });
  });

  it("needs every device to have read its share in full", () => {
    cursor(LEDGER, "dev-laptop", 3);
    cursor(LEDGER, "dev-desktop", 3);
    read(LEDGER, "dev-laptop", 3, "full");
    expect(states()["extra.labelIds"]).toMatchObject({ status: "needs-resync" });
    read(LEDGER, "dev-desktop", 3, "open");
    expect(states()["extra.labelIds"]).toMatchObject({ status: "resyncing" });
    read(LEDGER, "dev-desktop", 3, "full");
    expect(states()["extra.labelIds"]).toEqual({ status: "list-pending" });
  });

  it("does not let the shared cursor row stand in for a device's own", () => {
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 3, "full");
    // Each device's own first read is still to come.
    expect(states()["extra.labelIds"]).toMatchObject({ status: "resyncing", total: null });
  });

  it("reads a device that joined and has not synced yet as reading for the first time", () => {
    cursor(LEDGER, "dev-laptop", 3);
    read(LEDGER, "dev-laptop", 3, "full");
    expect(states()["extra.labelIds"]).toEqual({ status: "resyncing", processed: 0, total: null });
    cursor(LEDGER, "dev-desktop", 1);
    expect(states()["extra.labelIds"]).toEqual({
      status: "collector-behind",
      devices: [{ id: "dev-desktop", name: "Workshop PC" }],
    });
  });

  it("leaves out a device that was unpaired", () => {
    db.prepare("UPDATE devices SET revoked_at = 5 WHERE id = 'dev-desktop'").run();
    cursor(LEDGER, "dev-laptop", 3);
    read(LEDGER, "dev-laptop", 3, "full");
    expect(readSourceFilterReadiness(db, LEDGER)!.devices).toEqual([
      { id: "dev-laptop", name: "Studio Mac" },
    ]);
    expect(states()["extra.labelIds"]).toEqual({ status: "list-pending" });
  });
});

describe("an account handed between devices, read through one shared cursor", () => {
  it("is read in full when the shared row is, and names every host when behind", () => {
    source(LEDGER, "dev-laptop", "handoff", ["dev-laptop", "dev-desktop"]);
    cursor(LEDGER, "", 1);
    expect(states()["extra.labelIds"]).toEqual({
      status: "collector-behind",
      devices: [
        { id: "dev-laptop", name: "Studio Mac" },
        { id: "dev-desktop", name: "Workshop PC" },
      ],
    });
    cursor(LEDGER, "", 3);
    read(LEDGER, "", 3, "full");
    expect(states()["extra.labelIds"]).toEqual({ status: "list-pending" });
  });
});

describe("people filtered through a chat's members", () => {
  it("wait for the chat list, and are ready with it", () => {
    source(PARLEY, "dev-laptop");
    expect(states(PARLEY)).toEqual({
      "extra.chatId": { status: "list-pending" },
      $people: { status: "list-pending" },
    });
    publishList(db, { sourceId: PARLEY, field: "extra.chatId" }, [{ id: "c1", label: "Team" }]);
    expect(states(PARLEY)).toEqual({
      "extra.chatId": { status: "ready" },
      $people: { status: "ready" },
    });
  });
});

describe("the two counts", () => {
  beforeEach(() => {
    source(LEDGER, "dev-laptop");
    publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [
      { id: "F1", label: "Clients" },
    ]);
    const entry = (id: string, version: number, extra: Record<string, unknown>, people?: unknown) =>
      insertDocument(db, {
        id,
        sourceId: LEDGER,
        version,
        metadata: { documentType: "entry", ...(people ? { people } : {}), extra },
      });
    entry("old-0", 0, {});
    entry("old-1", 1, { labelIds: ["L1"] });
    entry("at-2", 2, { labelIds: [], folderIds: ["F1"] });
    entry("new-ok", 3, { labelIds: ["L1"], folderIds: ["F1"] }, [
      { role: "sender", emails: ["maya@example.org"] },
    ]);
    entry("new-no-labels", 3, { folderIds: [] });
    entry("new-unlisted-folder", 3, { labelIds: [], folderIds: ["gone"] }, [
      { role: "sender", name: "Someone" },
    ]);
    insertDocument(db, {
      id: "orphan",
      sourceId: LEDGER,
      version: 3,
      metadata: { documentType: "attachment", extra: { parentExternalId: "missing" } },
    });
    insertDocument(db, { id: "elsewhere", sourceId: "ledger:other", version: 0, metadata: {} });
  });

  it("counts the records below each field's minimum version from the running counts", () => {
    const fields = readSourceFilterReadiness(db, LEDGER)!.fields;
    expect(Object.fromEntries(fields.map((field) => [field.field, field.tooOld]))).toEqual({
      "extra.labelIds": 2,
      "extra.folderIds": 3,
      "extra.directory": 0,
      "extra.tagIds": 0,
      $people: 0,
    });
  });

  it("counts the new enough records that cannot be placed, by the real check", () => {
    // No label detail; and the attachment whose parent is missing.
    expect(countUnmatchedRecords(db, LEDGER, "extra.labelIds")).toBe(2);
    // The unlisted folder; and the attachment.
    expect(countUnmatchedRecords(db, LEDGER, "extra.folderIds")).toBe(2);
    // Everyone but the record that names an identified sender.
    expect(countUnmatchedRecords(db, LEDGER, "$people")).toBe(6);
  });

  it("has no count for a field that cannot be applied", () => {
    expect(countUnmatchedRecords(db, LEDGER, "extra.threadId")).toBeNull();
    expect(countUnmatchedRecords(db, "almanac:home", "$people")).toBeNull();
  });
});

describe("what an account is called beside its source's name", () => {
  const PHONE_ACCOUNT = "parley:+15550100123";

  beforeEach(() => {
    source(PHONE_ACCOUNT, "dev-laptop");
    db.prepare(
      "INSERT INTO source_family_meta (source_type, label, updated_at) VALUES ('parley', 'Parley', 'now')",
    ).run();
  });

  function reported(label: string): void {
    db.prepare("INSERT INTO sync_state (source_id, device_id, label) VALUES (?, '', ?)").run(
      PHONE_ACCOUNT,
      label,
    );
  }

  function declared(account: unknown): void {
    db.prepare("UPDATE sources SET account = ? WHERE id = ?").run(
      JSON.stringify(account),
      PHONE_ACCOUNT,
    );
  }

  it("is the label the source reports for the account, not its raw id", () => {
    reported("+1 (555) 010-0123");
    expect(filterSourceName(db, PHONE_ACCOUNT, "parley")).toBe("Parley");
    expect(filterAccountLabel(db, PHONE_ACCOUNT, "Parley")).toBe("+1 (555) 010-0123");
  });

  it("is the label the source declared when nothing reports one yet", () => {
    declared({ id: "+15550100123", label: "+1 (555) 010-0123" });
    expect(filterAccountLabel(db, PHONE_ACCOUNT, "Parley")).toBe("+1 (555) 010-0123");
  });

  it("skips a reported label that only repeats the source's name", () => {
    reported("Parley");
    declared({ id: "+15550100123", label: "Studio line" });
    expect(filterAccountLabel(db, PHONE_ACCOUNT, "Parley")).toBe("Studio line");
  });

  it("falls back to the account part of the id, and is null for an id without one", () => {
    reported("Parley");
    expect(filterAccountLabel(db, PHONE_ACCOUNT, "Parley")).toBe("+15550100123");
    expect(filterAccountLabel(db, "almanac", "Almanac")).toBeNull();
  });
});
