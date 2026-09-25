// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../db.js";
import { upgradePlaceholderCanonicalNames } from "./upgrade-placeholder-canonical-names.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-canonical-upgrade-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertPerson(canonicalName: string, opts?: { mergedInto?: string }): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, canonicalName, opts?.mergedInto ?? null);
  return id;
}

function insertNameAlias(
  personId: string,
  alias: string,
  opts?: { sourceId?: string; createdAt?: string },
): void {
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, 'name', ?, ?)`,
  ).run(randomUUID(), personId, alias, opts?.sourceId ?? null, opts?.createdAt ?? "2026-01-01");
}

/** Register `sourceId` as a contact-card source by giving it a contact doc. */
function insertContactDoc(sourceId: string): void {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, 'Contact', '', 'h-' || ?, ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, sourceId, id, id, JSON.stringify({ documentType: "contact", people: [] }));
}

function canonicalNameOf(personId: string): string {
  return db
    .prepare<[string], { canonical_name: string }>("SELECT canonical_name FROM people WHERE id = ?")
    .get(personId)!.canonical_name;
}

describe("upgradePlaceholderCanonicalNames", () => {
  test("promotes a trusted name alias onto a phone-shaped headline", () => {
    const id = insertPerson("+447700000001");
    insertNameAlias(id, "Jamie Lopez", { sourceId: "whatsapp:acct" });

    const { upgraded } = upgradePlaceholderCanonicalNames(db);

    expect(upgraded).toBe(1);
    expect(canonicalNameOf(id)).toBe("Jamie Lopez");
  });

  test("promotes onto an email-shaped headline", () => {
    const id = insertPerson("jamie@example.com");
    insertNameAlias(id, "Jamie Lopez", { sourceId: "gmail:acct" });

    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(1);
    expect(canonicalNameOf(id)).toBe("Jamie Lopez");
  });

  test("prefers a contact-sourced name when multiple trusted names exist", () => {
    insertContactDoc("apple-contacts:acct");
    const id = insertPerson("+15550100123");
    // A message pushname (earlier) and the authoritative contact-card name.
    insertNameAlias(id, "Jamie 📱", { sourceId: "whatsapp:acct", createdAt: "2026-01-01" });
    insertNameAlias(id, "Jamie Lopez", {
      sourceId: "apple-contacts:acct",
      createdAt: "2026-03-01",
    });

    upgradePlaceholderCanonicalNames(db);

    // Contact-sourced wins despite the message name being older.
    expect(canonicalNameOf(id)).toBe("Jamie Lopez");
  });

  test("falls back to the earliest trusted name when none is contact-sourced", () => {
    const id = insertPerson("+15550100124");
    insertNameAlias(id, "Later Name", { sourceId: "gmail:acct", createdAt: "2026-05-01" });
    insertNameAlias(id, "Earliest Name", { sourceId: "imessage:acct", createdAt: "2026-01-01" });

    upgradePlaceholderCanonicalNames(db);

    expect(canonicalNameOf(id)).toBe("Earliest Name");
  });

  test("considers name aliases inherited from a merged loser", () => {
    const canonical = insertPerson("+15550100200");
    const loser = insertPerson("+15550100200", { mergedInto: canonical });
    insertNameAlias(loser, "Sam Carter", { sourceId: "imessage:acct" });

    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(1);
    expect(canonicalNameOf(canonical)).toBe("Sam Carter");
  });

  test("considers name aliases inherited through a deep merge chain", () => {
    // canonical ← loser1 ← loser2 — a transient multi-hop chain such as
    // consolidateIntoSelf can produce at boot before transitive-collapse
    // re-flattens it. The deep loser holds the only trusted name.
    const canonical = insertPerson("+15550100210");
    const loser1 = insertPerson("+15550100210", { mergedInto: canonical });
    const loser2 = insertPerson("+15550100210", { mergedInto: loser1 });
    insertNameAlias(loser2, "Robin Vale", { sourceId: "imessage:acct" });

    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(1);
    expect(canonicalNameOf(canonical)).toBe("Robin Vale");
  });

  test("leaves a person with no trusted name alias untouched", () => {
    const id = insertPerson("+15550100125");

    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(0);
    expect(canonicalNameOf(id)).toBe("+15550100125");
  });

  test("never overwrites a real headline", () => {
    const id = insertPerson("Maya Reeves");
    insertNameAlias(id, "M. Reeves", { sourceId: "gmail:acct" });

    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(0);
    expect(canonicalNameOf(id)).toBe("Maya Reeves");
  });

  test("ignores a name alias that is itself placeholder-shaped", () => {
    const id = insertPerson("+15550100126");
    // A phone-as-name slipped into the name aliases — must not replace the
    // phone headline with another phone.
    insertNameAlias(id, "+15550100126", { sourceId: "imessage:acct" });

    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(0);
    expect(canonicalNameOf(id)).toBe("+15550100126");
  });

  test("does not touch losers' own headlines", () => {
    const canonical = insertPerson("Real Person");
    const loser = insertPerson("+15550100201", { mergedInto: canonical });
    insertNameAlias(loser, "Hidden Name", { sourceId: "imessage:acct" });

    // The canonical already has a real name; the loser is not displayed, so
    // nothing is upgraded.
    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(0);
    expect(canonicalNameOf(loser)).toBe("+15550100201");
  });

  test("is idempotent — a second run is a no-op", () => {
    const id = insertPerson("+15550100127");
    insertNameAlias(id, "Dana Kim", { sourceId: "whatsapp:acct" });

    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(1);
    expect(upgradePlaceholderCanonicalNames(db).upgraded).toBe(0);
    expect(canonicalNameOf(id)).toBe("Dana Kim");
  });
});
