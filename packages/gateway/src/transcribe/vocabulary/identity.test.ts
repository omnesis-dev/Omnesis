// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { CONTACT_NAME_FLOOR } from "../../domain/PeopleResolutionService.js";
import { contextualVocabularyNames } from "./identity.js";
import { cleanVocabularyName } from "./names.js";
import type { Db } from "../../data/types.js";

const databases: Db[] = [];
function database(): Db {
  const db = createDatabase(":memory:");
  databases.push(db);
  db.prepare(
    `INSERT INTO people(id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at)
    VALUES ('self','You','test',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01'),
    ('speaker','Display Label','test',0,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  ).run();
  return db;
}
function alias(
  db: Db,
  id: string,
  name: string,
  count = CONTACT_NAME_FLOOR,
  person = "self",
): void {
  db.prepare(
    `INSERT INTO person_aliases(id,person_id,alias,alias_type,source_id,created_at,occurrence_count)
    VALUES (?,?,?,'name','fictional:source','2026-01-01',?)`,
  ).run(id, person, name, count);
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

test("cleans lexical names without retaining addresses or display annotations", () => {
  expect(cleanVocabularyName("Maya Reeves (Team) | Example Office")).toBe("Maya Reeves");
  expect(cleanVocabularyName("张小明")).toBe("张小明");
  expect(cleanVocabularyName("Élodie D’Arcy")).toBe("Élodie D’Arcy");
  for (const name of [
    "You",
    "Self",
    "Me",
    "Unknown",
    "maya@example.org",
    "example.org",
    "A\nB",
    "X".repeat(81),
    "Name <markup>",
  ]) {
    expect(cleanVocabularyName(name)).toBeNull();
  }
});

test("uses one curated full name rather than canonical labels or historical aliases", () => {
  const db = database();
  alias(db, "old", "Untrusted Label", 1000);
  alias(db, "oversized", "Maya".repeat(10000), CONTACT_NAME_FLOOR + 100);
  alias(db, "short", "Maya");
  alias(db, "full", "Maya Reeves");
  expect(contextualVocabularyNames(db, [], true)).toEqual(["Maya Reeves"]);
  expect(contextualVocabularyNames(db, ["speaker"], false)).toEqual([]);
});

test("uses configuration assertion even when another source inserted the alias first", () => {
  const db = database();
  alias(db, "contact", "Maya Reeves");
  alias(db, "configured", "Maya Lopez", 1);
  db.prepare(
    `INSERT INTO person_alias_assertions(alias_id,source_id,first_seen,last_seen)
    VALUES ('configured','config','2026-01-01','2026-01-01')`,
  ).run();
  expect(contextualVocabularyNames(db, [], true)).toEqual(["Maya Lopez"]);
});

test("bounds alias reads before filtering and only selects requested identities", () => {
  const db = database();
  for (let i = 0; i < 128; i++) alias(db, `noise-${i}`, `Noise ${i}`, 1);
  alias(db, "beyond-page", "Maya Reeves");
  alias(db, "speaker-name", "Jamie Lopez", CONTACT_NAME_FLOOR, "speaker");
  expect(contextualVocabularyNames(db, [], true)).toEqual([]);
  expect(contextualVocabularyNames(db, ["speaker"], false)).toEqual(["Jamie Lopez"]);
});

test("merged contact aliases supply the canonical identity only while merged", () => {
  const db = database();
  alias(db, "loser-name", "Maya Reeves", CONTACT_NAME_FLOOR, "speaker");
  db.prepare("UPDATE people SET merged_into='self' WHERE id='speaker'").run();
  expect(contextualVocabularyNames(db, [], true)).toEqual(["Maya Reeves"]);
  db.prepare("UPDATE people SET merged_into=NULL WHERE id='speaker'").run();
  expect(contextualVocabularyNames(db, [], true)).toEqual([]);
  expect(contextualVocabularyNames(db, ["speaker"], false)).toEqual(["Maya Reeves"]);
});

test("merged identities share the alias budget including non-name aliases", () => {
  const db = database();
  const insert = db.prepare(`INSERT INTO person_aliases(id,person_id,alias,alias_type,created_at)
    VALUES (?,'self',?,'email','2026-01-01')`);
  for (let i = 0; i < 128; i++) insert.run(`email-${i}`, `person-${i}@example.org`);
  alias(db, "loser-name", "Maya Reeves", CONTACT_NAME_FLOOR, "speaker");
  db.prepare("UPDATE people SET merged_into='self' WHERE id='speaker'").run();
  expect(contextualVocabularyNames(db, [], true)).toEqual([]);
  db.prepare("DELETE FROM person_aliases WHERE id='email-127'").run();
  expect(contextualVocabularyNames(db, [], true)).toEqual(["Maya Reeves"]);
});
