// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How `searchPeople` ranks a non-empty query.
 *
 * Substring containment alone cannot rank a people search: a short query is a
 * substring of plenty of unrelated long names, and once popularity is the only
 * sort key a well-connected accident buries the person actually being looked
 * for — or, when the query has a one-letter slip, replaces them entirely.
 * These tests pin both halves: the tier ordering that demotes an accidental
 * substring, and the fuzzy rescue that finds a near-miss the literal pass
 * cannot see.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { searchPeople, type PersonBrowseCursor } from "./PersonRepository.js";
import { MATCH_RANK } from "./person-match.js";
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
  isSelf?: boolean;
  docCount?: number;
  scoreRecent?: number;
  mergedInto?: string;
}): void {
  db.prepare(
    `INSERT INTO people
       (id, canonical_name, source, merged_into, is_self, first_seen, last_seen,
        created_at, updated_at, doc_count, interaction_score_recent, alias_count)
     VALUES (?, ?, 'contacts', ?, ?, '2026-01-01', '2026-06-01',
             '2026-01-01', '2026-06-01', ?, ?, ?)`,
  ).run(
    p.id,
    p.name,
    p.mergedInto ?? null,
    p.isSelf ? 1 : 0,
    p.docCount ?? 1,
    p.scoreRecent ?? 0,
    (p.aliases ?? []).length,
  );
  for (const alias of p.aliases ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (person_id, alias_type, alias, created_at)
       VALUES (?, ?, ?, '2026-01-01')`,
    ).run(p.id, alias.includes("@") ? "email" : "name", alias);
  }
}

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

describe("match-quality tiers", () => {
  beforeEach(() => {
    // One query, five ways of matching it. Scores run backwards against the
    // tiers on purpose: the worst match is the most popular person, so any
    // result that is merely score-ordered is visibly wrong.
    insertPerson({ id: "exact", name: "Vint", scoreRecent: 0.01, docCount: 1 });
    insertPerson({ id: "prefix", name: "Vintaro Kelder", scoreRecent: 0.2, docCount: 20 });
    insertPerson({ id: "word", name: "Marek Vint-Halloway", scoreRecent: 0.4, docCount: 40 });
    insertPerson({ id: "infix", name: "Alvintor Grant", scoreRecent: 0.9, docCount: 90 });
  });

  test("orders exact, then prefix, then word start, then accidental infix", () => {
    expect(ids(searchPeople(db, "vint", 10))).toEqual(["exact", "prefix", "word", "infix"]);
  });

  test("reports the tier it matched at", () => {
    const byId = new Map(searchPeople(db, "vint", 10).map((r) => [r.id, r.matchRank]));
    expect(byId.get("exact")).toBe(MATCH_RANK.EXACT);
    expect(byId.get("prefix")).toBe(MATCH_RANK.PREFIX);
    expect(byId.get("word")).toBe(MATCH_RANK.WORD);
    expect(byId.get("infix")).toBe(MATCH_RANK.INFIX);
  });

  test("is case-insensitive on both sides", () => {
    expect(ids(searchPeople(db, "VINT", 10))).toEqual(["exact", "prefix", "word", "infix"]);
  });

  test("interaction score still orders people within one tier", () => {
    // Both match at PREFIX, so only the score separates them.
    insertPerson({ id: "quiet", name: "Vint Ferrand", scoreRecent: 0.05, docCount: 3 });
    insertPerson({ id: "loud", name: "Vint Oleander", scoreRecent: 0.8, docCount: 60 });
    const rows = searchPeople(db, "vint", 10);
    const byId = new Map(rows.map((r) => [r.id, r.matchRank]));
    expect(byId.get("quiet")).toBe(MATCH_RANK.PREFIX);
    expect(byId.get("loud")).toBe(MATCH_RANK.PREFIX);
    const order = ids(rows);
    expect(order.indexOf("loud")).toBeLessThan(order.indexOf("quiet"));
  });

  test("a matching alias sets the tier even when the canonical name does not match", () => {
    insertPerson({
      id: "aliased",
      name: "Tavi Delacroix",
      aliases: ["Vint"],
      scoreRecent: 0.001,
      docCount: 1,
    });
    // Exact on the alias outranks an accidental infix on a far more
    // connected person's name.
    expect(ids(searchPeople(db, "vint", 10))[0]).toBe("exact");
    expect(ids(searchPeople(db, "vint", 10)).indexOf("aliased")).toBeLessThan(
      ids(searchPeople(db, "vint", 10)).indexOf("infix"),
    );
  });

  test("the best of several aliases wins the tier", () => {
    insertPerson({
      id: "multi",
      name: "Ferndale Holdings",
      // One alias only contains the query, another starts with it.
      aliases: ["Alvintor", "Vintwick"],
      scoreRecent: 0.001,
      docCount: 1,
    });
    const row = searchPeople(db, "vint", 10).find((r) => r.id === "multi");
    expect(row?.matchRank).toBe(MATCH_RANK.PREFIX);
  });

  test("word-start tier covers compound-name and address separators", () => {
    insertPerson({ id: "dot", name: "x", aliases: ["marek.vint@example.com"], docCount: 1 });
    insertPerson({ id: "at", name: "y", aliases: ["contact@vint-labs.example"], docCount: 1 });
    insertPerson({ id: "underscore", name: "z", aliases: ["marek_vint"], docCount: 1 });
    for (const id of ["dot", "at", "underscore"]) {
      const row = searchPeople(db, "vint", 20).find((r) => r.id === id);
      expect(row?.matchRank).toBe(MATCH_RANK.WORD);
    }
  });

  test("self stays pinned above the tiers", () => {
    insertPerson({ id: "me", name: "Vintworth Self", isSelf: true, scoreRecent: 0, docCount: 1 });
    expect(ids(searchPeople(db, "vin", 10))[0]).toBe("me");
  });

  test("merged people never appear", () => {
    insertPerson({
      id: "loser",
      name: "Vint",
      mergedInto: "exact",
      scoreRecent: 9,
      docCount: 999,
    });
    expect(ids(searchPeople(db, "vint", 10))).not.toContain("loser");
  });
});

describe("fuzzy rescue", () => {
  /**
   * The shape of the failure this exists for: a query one letter off a short
   * nickname is not a substring of it, but *is* an accidental substring of an
   * unrelated, far more connected name. The literal pass therefore returns a
   * page of the wrong person and omits the right one.
   */
  function seedNearMiss(): void {
    // "rite" is an infix of "Marguerite" but not of "Ritika"; the intended
    // person is reachable only through her "Rit" nickname, one edit away.
    insertPerson({ id: "accident", name: "Marguerite Vance", scoreRecent: 0.9, docCount: 400 });
    insertPerson({
      id: "intended",
      name: "Ritika Vantol",
      aliases: ["Rit"],
      scoreRecent: 0.05,
      docCount: 30,
    });
  }

  test("finds the near-miss the literal pass cannot see", () => {
    seedNearMiss();
    // Precondition: the literal pass really does miss her.
    expect(ids(searchPeople(db, "ritika", 10))).toContain("intended");
    const rows = searchPeople(db, "rite", 10);
    expect(ids(rows)).toContain("intended");
  });

  test("the accidental substring does not outrank the intended person", () => {
    seedNearMiss();
    const rows = searchPeople(db, "rite", 10);
    expect(rows[0].id).toBe("intended");
  });

  test("rescued rows are marked as fuzzy", () => {
    seedNearMiss();
    const rows = searchPeople(db, "rite", 10);
    expect(rows.every((r) => r.matchRank === MATCH_RANK.FUZZY)).toBe(true);
  });

  test("does not fire when the literal pass already found a word-start match", () => {
    seedNearMiss();
    insertPerson({ id: "good", name: "Ritestone Labs", scoreRecent: 0.01, docCount: 1 });
    const rows = searchPeople(db, "rite", 10);
    // A real prefix match exists, so the literal result stands and the
    // more-expensive rescue is skipped entirely.
    expect(rows[0].id).toBe("good");
    expect(ids(rows)).toContain("accident");
    expect(ids(rows)).not.toContain("intended");
  });

  test("does not fire for a query too short to have a budget", () => {
    // "rit" is exactly one edit from "rio" and short enough to sit inside a
    // budget-of-1 length window, so this finds nothing only because a
    // three-letter query gets no budget at all.
    insertPerson({ id: "near", name: "Rit", docCount: 1 });
    expect(searchPeople(db, "rio", 10)).toEqual([]);
    // The same fixture, one edit from a four-letter query, IS rescued — which
    // is what makes the line above a statement about the budget rather than
    // about the fixture being unreachable.
    expect(ids(searchPeople(db, "riot", 10))).toEqual(["near"]);
  });

  test("does not fire over a page that was cut short by the limit", () => {
    // `is_self` is pinned ahead of the tier, so a one-row page can be self
    // matching on an accidental substring while a genuine prefix match sits
    // just outside it. The rescue replaces the page rather than extending it,
    // so firing here would discard that prefix match. A page that was cut
    // short says nothing about what is below it.
    seedNearMiss();
    insertPerson({ id: "me", name: "Ambrite Self", isSelf: true, docCount: 1 });
    insertPerson({ id: "good", name: "Ritestone Labs", scoreRecent: 0.001, docCount: 1 });

    const saturated = searchPeople(db, "rite", 1);
    expect(saturated).toHaveLength(1);
    expect(saturated[0].id).toBe("me");
    expect(saturated[0].matchRank).toBe(MATCH_RANK.INFIX);

    // Given room to return the whole literal set, the prefix match is right
    // there — it was never a case for the rescue.
    expect(ids(searchPeople(db, "rite", 10))).toEqual(["me", "good", "accident"]);
  });

  test("does not fire when paging an established result set", () => {
    seedNearMiss();
    const first = searchPeople(db, "rite", 10);
    expect(first[0].id).toBe("intended");
    // Paging from a literal cursor must continue that literal walk rather
    // than restarting the rescue and repeating rows.
    const cursor: PersonBrowseCursor = {
      isSelf: 0,
      interactionScoreRecent: 0.9,
      documentCount: 400,
      id: "accident",
      matchRank: MATCH_RANK.INFIX,
    };
    const next = searchPeople(db, "rite", 10, { after: cursor });
    expect(ids(next)).not.toContain("intended");
  });

  test("returns nothing when no name is close enough", () => {
    insertPerson({ id: "far", name: "Quintero Holdings", docCount: 1 });
    expect(searchPeople(db, "zzzz", 10)).toEqual([]);
  });

  test("orders rescued people by how close the spelling is", () => {
    // Against "nakamora": one substitution for the first, two for the second.
    insertPerson({ id: "one-edit", name: "Nakamura", scoreRecent: 0.01, docCount: 1 });
    insertPerson({ id: "two-edit", name: "Nakomoro", scoreRecent: 0.9, docCount: 900 });
    // Both are inside the budget, but the closer spelling leads despite being
    // far less connected — distance is the only signal a fuzzy match carries.
    const rows = searchPeople(db, "nakamora", 10);
    expect(ids(rows)).toEqual(["one-edit", "two-edit"]);
  });

  test("a person matched by both a near name and a near alias appears once", () => {
    // Both the canonical name and the alias are inside the length window and
    // within budget of "marguerite", so the per-person minimum is genuinely
    // exercised rather than only one leg matching.
    insertPerson({ id: "dual", name: "Margueritte", aliases: ["Marguerita"], docCount: 1 });
    const rows = searchPeople(db, "marguerite", 10);
    expect(ids(rows).filter((id) => id === "dual")).toHaveLength(1);
    // Each leg alone would also have matched — that is what makes the
    // deduplication above meaningful.
    insertPerson({ id: "name-only", name: "Margueritte", docCount: 1 });
    insertPerson({ id: "alias-only", name: "Unrelated Person", aliases: ["Marguerita"] });
    const both = ids(searchPeople(db, "marguerite", 10));
    expect(both).toContain("name-only");
    expect(both).toContain("alias-only");
  });

  test("never rescues a merged person", () => {
    insertPerson({ id: "winner", name: "Quintero Holdings", docCount: 1 });
    insertPerson({
      id: "merged",
      name: "Ritika Vantol",
      aliases: ["Rit"],
      mergedInto: "winner",
      docCount: 999,
    });
    expect(ids(searchPeople(db, "rite", 10))).not.toContain("merged");
  });

  test("fills the page to the requested limit and no further", () => {
    for (let i = 0; i < 12; i++) {
      insertPerson({ id: `p${i}`, name: `Nakamur${String.fromCharCode(97 + i)}`, docCount: 1 });
    }
    // Twelve people are within budget; exactly five come back.
    expect(searchPeople(db, "nakamurz", 5)).toHaveLength(5);
    expect(searchPeople(db, "nakamurz", 12)).toHaveLength(12);
  });

  test("a rescued result set is one page — paging past it stops", () => {
    // Deliberate: the rescue is a "did you mean", not a corpus walk. Callers
    // that page past it get nothing rather than sliding into the literal
    // accidental-substring matches the rescue replaced.
    for (let i = 0; i < 6; i++) {
      insertPerson({ id: `p${i}`, name: `Nakamur${String.fromCharCode(97 + i)}`, docCount: 1 });
    }
    const page = searchPeople(db, "nakamurz", 3);
    expect(page).toHaveLength(3);
    const last = page[page.length - 1];
    const next = searchPeople(db, "nakamurz", 3, {
      after: {
        isSelf: 0,
        interactionScoreRecent: last.interactionScoreRecent,
        documentCount: last.documentCount,
        id: last.id,
        matchRank: last.matchRank,
      },
    });
    expect(next).toEqual([]);
  });
});

describe("cursor paging with a query", () => {
  beforeEach(() => {
    insertPerson({ id: "exact", name: "Vint", scoreRecent: 0.01, docCount: 1 });
    insertPerson({ id: "prefix", name: "Vintaro Kelder", scoreRecent: 0.2, docCount: 20 });
    insertPerson({ id: "word", name: "Marek Vint-Halloway", scoreRecent: 0.4, docCount: 40 });
    insertPerson({ id: "infix", name: "Alvintor Grant", scoreRecent: 0.9, docCount: 90 });
  });

  function walk(pageSize: number): string[] {
    const seen: string[] = [];
    let after: PersonBrowseCursor | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = searchPeople(db, "vint", pageSize, { after });
      if (page.length === 0) break;
      seen.push(...ids(page));
      const last = page[page.length - 1];
      after = {
        isSelf: last.isSelf ? 1 : 0,
        interactionScoreRecent: last.interactionScoreRecent,
        documentCount: last.documentCount,
        id: last.id,
        matchRank: last.matchRank,
      };
    }
    return seen;
  }

  test("a full walk visits every match exactly once, in tier order", () => {
    // The regression guarded here: adding the tier to the ORDER BY without
    // adding it to the cursor comparison makes the walk skip and repeat rows
    // at every tier boundary.
    for (const pageSize of [1, 2, 3, 4, 10]) {
      expect(walk(pageSize)).toEqual(["exact", "prefix", "word", "infix"]);
    }
  });

  test("a cursor with no tier ends the walk instead of re-serving it", () => {
    // A cursor minted before the tier joined the sort tuple cannot say where
    // in the new ordering it pointed. Ending the walk loses that walk's tail;
    // the alternative — assuming the best tier — makes the "after" comparison
    // true for nearly every row, so the client is served the same page for as
    // long as it keeps asking.
    const first = searchPeople(db, "vint", 1);
    expect(first[0].id).toBe("exact");
    const legacy: PersonBrowseCursor = {
      isSelf: 0,
      interactionScoreRecent: first[0].interactionScoreRecent,
      documentCount: first[0].documentCount,
      id: first[0].id,
    };
    const rest = searchPeople(db, "vint", 10, { after: legacy });
    expect(rest).toEqual([]);
    // A fresh walk from the same query is unaffected and still complete.
    expect(ids(searchPeople(db, "vint", 10))).toEqual(["exact", "prefix", "word", "infix"]);
  });

  test("paging past a rescued page ends the walk instead of leaking literal matches", () => {
    db.exec("DELETE FROM people; DELETE FROM person_aliases;");
    insertPerson({ id: "accident", name: "Marguerite Vance", scoreRecent: 0.9, docCount: 400 });
    insertPerson({ id: "intended", name: "Ritika Vantol", aliases: ["Rit"], docCount: 30 });
    const page = searchPeople(db, "rite", 10);
    expect(page[0].id).toBe("intended");
    const last = page[page.length - 1];
    const next = searchPeople(db, "rite", 10, {
      after: {
        isSelf: 0,
        interactionScoreRecent: last.interactionScoreRecent,
        documentCount: last.documentCount,
        id: last.id,
        matchRank: last.matchRank,
      },
    });
    // Fuzzy is the last tier, so nothing sorts after it — continuing must not
    // fall back into the accidental-substring matches the rescue replaced.
    expect(next).toEqual([]);
  });
});

describe("LIKE metacharacters in the query", () => {
  // The escaping in the bound parameter and the ESCAPE clause in the SQL have
  // to agree; nothing else in the suite reaches real SQL with a wildcard in
  // the query, so this is where a mismatch would show up.
  beforeEach(() => {
    insertPerson({ id: "literal", name: "a_b", docCount: 1 });
    insertPerson({ id: "wildcard-hit", name: "axb", docCount: 1 });
    insertPerson({ id: "percent", name: "50% off", docCount: 1 });
    insertPerson({ id: "other", name: "50 pounds off", docCount: 1 });
  });

  test("underscore matches one literal underscore, not any character", () => {
    const rows = ids(searchPeople(db, "a_b", 10));
    expect(rows).toContain("literal");
    expect(rows).not.toContain("wildcard-hit");
  });

  test("percent matches a literal percent, not any run of characters", () => {
    const rows = ids(searchPeople(db, "50%", 10));
    expect(rows).toContain("percent");
    expect(rows).not.toContain("other");
  });

  test("a backslash in the query is matched literally", () => {
    insertPerson({ id: "slash", name: "back\\slash", docCount: 1 });
    expect(ids(searchPeople(db, "back\\slash", 10))).toEqual(["slash"]);
  });

  test("a wildcard query still scores a real tier rather than matching everything", () => {
    const row = searchPeople(db, "a_b", 10).find((r) => r.id === "literal");
    expect(row?.matchRank).toBe(MATCH_RANK.EXACT);
  });
});

describe("document-count sorting with a query", () => {
  beforeEach(() => {
    insertPerson({ id: "exact", name: "Vint", docCount: 1, scoreRecent: 0.01 });
    insertPerson({ id: "prefix", name: "Vintaro Kelder", docCount: 20, scoreRecent: 0.2 });
    insertPerson({ id: "infix", name: "Alvintor Grant", docCount: 90, scoreRecent: 0.9 });
  });

  test("ranks by tier first, then by document count", () => {
    const rows = searchPeople(db, "vint", 10, { sortBy: "documents" });
    expect(ids(rows)).toEqual(["exact", "prefix", "infix"]);
  });

  test("pages without repeating or dropping a row", () => {
    const seen: string[] = [];
    let after: PersonBrowseCursor | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = searchPeople(db, "vint", 1, { sortBy: "documents", after });
      if (page.length === 0) break;
      seen.push(...ids(page));
      const last = page[page.length - 1];
      after = {
        isSelf: last.isSelf ? 1 : 0,
        interactionScoreRecent: last.interactionScoreRecent,
        documentCount: last.documentCount,
        id: last.id,
        matchRank: last.matchRank,
      };
    }
    expect(seen).toEqual(["exact", "prefix", "infix"]);
  });
});

describe("behaviour preserved by the ranker", () => {
  test("browse is unranked and unchanged", () => {
    insertPerson({ id: "self", name: "Self User", isSelf: true, scoreRecent: 0, docCount: 5 });
    insertPerson({ id: "top", name: "Top Score", scoreRecent: 9, docCount: 100 });
    insertPerson({ id: "mid", name: "Mid Score", scoreRecent: 5, docCount: 80 });
    const rows = searchPeople(db, "", 10);
    expect(ids(rows)).toEqual(["self", "top", "mid"]);
    // No query means no match tier to report.
    expect(rows.every((r) => r.matchRank === undefined)).toBe(true);
  });

  test("a dotted or tagged Gmail address still finds the alias stored canonically", () => {
    // Gmail is the provider whose dots and `+tag` are cosmetic, so ingestion
    // stores the stripped form while a human types the decorated one. The
    // fixture address is invented; only the domain matters to the code path.
    insertPerson({ id: "mailed", name: "Marek Vint", aliases: ["marekvint@gmail.com"] });
    const rows = searchPeople(db, "marek.vint+news@gmail.com", 10);
    expect(ids(rows)).toContain("mailed");
    // And it scores as a real match rather than falling through to no tier.
    expect(rows.find((r) => r.id === "mailed")?.matchRank).toBe(MATCH_RANK.EXACT);
  });

  test("ranks correctly before the stat columns are materialized", () => {
    // A fresh install serves searches from correlated counts until the
    // refresh tasks first run; the tier ordering must hold on that path too.
    insertPerson({ id: "exact", name: "Vint", docCount: 0, scoreRecent: 0 });
    insertPerson({ id: "infix", name: "Alvintor Grant", docCount: 0, scoreRecent: 0 });
    const rows = searchPeople(db, "vint", 10);
    expect(ids(rows)).toEqual(["exact", "infix"]);
  });

  test("rescues a near-miss before the stat columns are materialized", () => {
    insertPerson({ id: "accident", name: "Marguerite Vance", docCount: 0, scoreRecent: 0 });
    insertPerson({ id: "intended", name: "Ritika Vantol", aliases: ["Rit"], docCount: 0 });
    expect(ids(searchPeople(db, "rite", 10))).toContain("intended");
  });
});
