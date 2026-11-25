// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Loading the People → Rules page resolves every active rule's winning alias to a
 * person, so its cost is one lookup per rule. These tests pin that each lookup
 * is an index seek, for every filter combination the page builds, so the read
 * cannot fall back to walking every alias of a type once per rule, and that
 * keyset paging holds when rules are removed or added between page loads.
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFreshTestDatabase } from "../../testing/fresh-database.js";
import { PERSON_NAME_ALIAS_INDEX } from "../../data/migration-218-person-name-alias-index.js";
import { listMergeRuleGroups, mergeRuleGroupsPageSql } from "./rule-groups.js";
import { seedEdgeRuleGroups } from "./rule-groups-test-utils.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let path: string;
let db: Db;
beforeEach(() => {
  path = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createFreshTestDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

function plan(sql: string): string[] {
  const placeholders = (sql.match(/\?/g) ?? []).length;
  return db
    .prepare<string[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array<string>(placeholders).fill("x"))
    .map((row) => row.detail);
}

describe("the page's identity lookups", () => {
  for (const kind of [false, true])
    for (const q of [false, true])
      for (const before of [false, true]) {
        test(`seek an index (kind ${kind}, q ${q}, cursor ${before})`, () => {
          const details = plan(mergeRuleGroupsPageSql({ kind, q, before }));
          const aliasReads = details.filter((detail) => / pa /.test(detail));
          // A name winner seeks the name index; any other winner seeks its type and alias.
          expect(aliasReads).toContain(
            `SEARCH pa USING INDEX ${PERSON_NAME_ALIAS_INDEX} (<expr>=?)`,
          );
          expect(aliasReads.some((detail) => detail.includes("(alias_type=? AND alias=?)"))).toBe(
            true,
          );
          for (const detail of aliasReads)
            expect(detail).toMatch(
              new RegExp(
                `^SEARCH pa USING (COVERING )?INDEX \\S+ \\((<expr>=\\?|alias_type=\\? AND alias=\\?)\\)$`,
              ),
            );
        });
      }

  test("a name winner resolves to its person whatever the case of the name", () => {
    seedEdgeRuleGroups(db);
    const page = listMergeRuleGroups(db, { limit: 50, q: "mendez" });
    // The rule stores "sarah mendez"; two people carry the name in other cases,
    // and the identity is the lowest of them.
    expect(page.items.map((item) => [item.key, item.ruleIds])).toEqual([["p-sarah", ["r-name"]]]);
  });

  test("fail loudly rather than scan when the name index is missing", () => {
    db.exec(`DROP INDEX ${PERSON_NAME_ALIAS_INDEX}`);
    expect(() => plan(mergeRuleGroupsPageSql({ kind: false, q: false, before: false }))).toThrow(
      /no such index/,
    );
  });
});

describe("paging while the rules change", () => {
  test("a page read after a rule is removed continues from the cursor without repeats", () => {
    seedEdgeRuleGroups(db);
    const first = listMergeRuleGroups(db, { limit: 2 });
    const all = listMergeRuleGroups(db, { limit: 50 }).items.map((item) => item.key);
    // Undo the next identity's only rule between the two page loads.
    db.prepare("DELETE FROM merge_rules WHERE id = 'r-merged-winner'").run();
    db.prepare("DELETE FROM merge_rules WHERE id IN ('r-root', 'r-lid')").run();
    const rest = listMergeRuleGroups(db, { limit: 50, before: first.last! });
    expect(rest.items.map((item) => item.key)).toEqual(
      all.slice(2).filter((key) => key !== "p-root"),
    );
  });

  test("an identity given a newer rule after its page was read is not repeated below the cursor", () => {
    seedEdgeRuleGroups(db);
    const first = listMergeRuleGroups(db, { limit: 2 });
    const all = listMergeRuleGroups(db, { limit: 50 }).items.map((item) => item.key);
    // A later merge into the last identity on the second page lifts it above the cursor.
    db.prepare(
      `INSERT INTO merge_rules (id, kind, side_a_alias_type, side_a_alias, side_b_alias_type,
         side_b_alias, winner_side, created_at, active)
       VALUES ('r-late', 'user', 'email', 'tie.a@example.com', 'email', 'late@example.com', 'a',
               '2026-03-01T00:00:00.000Z', 1)`,
    ).run();
    const rest = listMergeRuleGroups(db, { limit: 50, before: first.last! });
    expect(rest.items.map((item) => item.key)).toEqual(
      all.slice(2).filter((key) => key !== "p-tie-a"),
    );
    expect(listMergeRuleGroups(db, { limit: 1 }).items[0]!.key).toBe("p-tie-a");
  });
});
