// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createSourceDocumentProfilesTable,
  getSourceDocumentProfile,
  listSourceDocumentProfiles,
  upsertSourceDocumentProfiles,
} from "./SourceDocumentProfileRepository.js";
import type { SourceDocumentProfileEntry } from "./SourceDocumentProfileRepository.js";

let db: Database.Database;

const mailbox: SourceDocumentProfileEntry = {
  sourceType: "mailbox",
  profile: {
    documentTypes: ["email"],
    personRoles: ["sender", "recipient"],
    metadataFields: [
      {
        path: "tags",
        type: "string-array",
        description: "Labels the mailbox applies to a message.",
        canonicalValues: ["receipts", "travel"],
        valueAliases: { receipts: ["receipt"] },
      },
    ],
  },
};

const notebook: SourceDocumentProfileEntry = {
  sourceType: "notebook",
  profile: { documentTypes: ["note"], personRoles: ["author"] },
};

beforeEach(() => {
  db = new Database(":memory:");
  createSourceDocumentProfilesTable(db);
});

afterEach(() => db.close());

describe("source document profile store", () => {
  it("stores a published profile and reads it back whole", () => {
    expect(upsertSourceDocumentProfiles(db, [mailbox], 1000)).toEqual({ stored: 1 });
    expect(getSourceDocumentProfile(db, "mailbox")).toEqual(mailbox.profile);
  });

  it("returns nothing for a source type that was never published", () => {
    upsertSourceDocumentProfiles(db, [mailbox], 1000);
    expect(getSourceDocumentProfile(db, "ledger")).toBeNull();
  });

  it("returns nothing when no collector has published at all", () => {
    expect(getSourceDocumentProfile(db, "mailbox")).toBeNull();
    expect(listSourceDocumentProfiles(db)).toEqual([]);
  });

  it("keeps a source type another host published", () => {
    // A collector loads only the sources its platform supports, so one host's
    // list is complete for itself and partial for the install. Clearing on
    // publish would let a Linux collector erase the macOS-only declarations,
    // and a missing profile fails a compiled plan's dependency check — every
    // watch over those sources would pause.
    upsertSourceDocumentProfiles(db, [mailbox, notebook], 1000);
    upsertSourceDocumentProfiles(db, [notebook], 2000);
    expect(getSourceDocumentProfile(db, "mailbox")).toEqual(mailbox.profile);
    expect(listSourceDocumentProfiles(db)).toEqual([mailbox, notebook]);
  });

  it("overwrites a source type's profile when the declaration changes", () => {
    upsertSourceDocumentProfiles(db, [mailbox], 1000);
    const revised: SourceDocumentProfileEntry = {
      sourceType: "mailbox",
      profile: { documentTypes: ["email", "attachment"] },
    };
    upsertSourceDocumentProfiles(db, [revised], 2000);
    expect(getSourceDocumentProfile(db, "mailbox")).toEqual(revised.profile);
  });

  it("lists profiles ordered by source type", () => {
    upsertSourceDocumentProfiles(db, [notebook, mailbox], 1000);
    expect(listSourceDocumentProfiles(db)).toEqual([mailbox, notebook]);
  });

  it("leaves the store alone when the publisher declares nothing", () => {
    // A collector that loaded no profile-declaring source says nothing about
    // the ones another host published.
    upsertSourceDocumentProfiles(db, [mailbox], 1000);
    expect(upsertSourceDocumentProfiles(db, [], 2000)).toEqual({ stored: 0 });
    expect(listSourceDocumentProfiles(db)).toEqual([mailbox]);
  });

  it("skips one unreadable row rather than denying every source its profile", () => {
    upsertSourceDocumentProfiles(db, [mailbox, notebook], 1000);
    db.prepare("UPDATE source_document_profiles SET profile_json = ? WHERE source_type = ?").run(
      "not json",
      "notebook",
    );

    expect(getSourceDocumentProfile(db, "notebook")).toBeNull();
    expect(listSourceDocumentProfiles(db)).toEqual([mailbox]);
  });

  it("survives a fresh handle on the same file — the point of persisting it", () => {
    const path = `/tmp/omnesis-test-${randomUUID()}.db`;
    const first = new Database(path);
    createSourceDocumentProfilesTable(first);
    upsertSourceDocumentProfiles(first, [mailbox], 1000);
    first.close();

    const second = new Database(path);
    try {
      expect(getSourceDocumentProfile(second, "mailbox")).toEqual(mailbox.profile);
    } finally {
      second.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(path + suffix)) unlinkSync(path + suffix);
      }
    }
  });
});
