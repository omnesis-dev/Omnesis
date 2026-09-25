// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How `resolvePersonIdsFromQuery` picks the people behind a `from:` / `to:` /
 * `with:` name ref.
 *
 * A ref keeps at most ten people. Which ten matters: the ref is a substring,
 * so a short one matches many names, and a cap applied in alias order keeps
 * whoever sorts first by name rather than whoever the user meant. These tests
 * pin the ranked cap — match tier, then recent interaction, then document
 * count — and the literal treatment of LIKE wildcards typed into a ref.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { resolvePersonIdsFromQuery } from "./PersonRepository.js";
import type { Db } from "../types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function insertPerson(p: {
  id: string;
  name: string;
  aliases?: string[];
  docCount?: number;
  scoreRecent?: number;
  mergedInto?: string;
}): void {
  db.prepare(
    `INSERT INTO people
       (id, canonical_name, source, merged_into, is_self, first_seen, last_seen,
        created_at, updated_at, doc_count, interaction_score_recent, alias_count)
     VALUES (?, ?, 'contacts', ?, 0, '2026-01-01', '2026-06-01',
             '2026-01-01', '2026-06-01', ?, ?, ?)`,
  ).run(p.id, p.name, p.mergedInto ?? null, p.docCount ?? 1, p.scoreRecent ?? 0, 1);
  for (const alias of p.aliases ?? [p.name]) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at)
       VALUES (?, ?, 'name', ?, '2026-01-01')`,
    ).run(`${p.id}:${alias}`, p.id, alias);
  }
}

describe("ranked cap", () => {
  test("keeps the best-ranked ten, not the ten whose names sort first", () => {
    // Twelve people contain "john". The ten that sort first by name are all
    // low-interaction "A… Johnson" word-tier matches; the two people worth
    // keeping sort after every one of them: a prefix-tier "john reyes" and
    // the most-interacted Johnson, "zoe".
    const alphabetical = ["Abe", "Ada", "Al", "Amy", "Ann", "Ari", "Ash", "Ava", "Axl", "Ayo"];
    for (const first of alphabetical) {
      insertPerson({ id: `johnson-${first.toLowerCase()}`, name: `${first} Johnson` });
    }
    insertPerson({ id: "johnson-zoe", name: "zoe johnson", scoreRecent: 5, docCount: 50 });
    insertPerson({ id: "john-reyes", name: "john reyes" });

    const ids = resolvePersonIdsFromQuery(db, "john");

    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe("john-reyes");
    expect(ids[1]).toBe("johnson-zoe");
    // Two of the alphabetical ten are the ones dropped.
    expect(ids.filter((id) => id.startsWith("johnson-a"))).toHaveLength(8);
  });

  test("a hit on a merged-away loser ranks by its canonical's stats", () => {
    // "Reeves" lives only on a loser two hops below its canonical. The
    // canonical must be the id returned, and it must rank ahead of a
    // direct match whose own stats are weaker.
    insertPerson({ id: "canonical", name: "Maya", scoreRecent: 9, docCount: 90 });
    insertPerson({ id: "middle", name: "m. reeves", mergedInto: "canonical" });
    insertPerson({ id: "leaf", name: "maya reeves", mergedInto: "middle" });
    insertPerson({ id: "other", name: "tomas reeves", scoreRecent: 1, docCount: 10 });

    expect(resolvePersonIdsFromQuery(db, "reeves")).toEqual(["canonical", "other"]);
  });

  test("returns nobody for a ref that matches no name", () => {
    insertPerson({ id: "p1", name: "maya reeves" });
    expect(resolvePersonIdsFromQuery(db, "nobody")).toEqual([]);
  });
});

describe("LIKE wildcards in a ref", () => {
  test("an underscore in the ref matches only a literal underscore", () => {
    insertPerson({ id: "plain", name: "ann lee" });
    insertPerson({ id: "underscore", name: "a_n lee" });

    expect(resolvePersonIdsFromQuery(db, "a_n")).toEqual(["underscore"]);
  });

  test("a percent sign in the ref matches only a literal percent sign", () => {
    insertPerson({ id: "plain", name: "mo vale" });
    insertPerson({ id: "percent", name: "mo% vale" });

    expect(resolvePersonIdsFromQuery(db, "mo%")).toEqual(["percent"]);
  });
});
