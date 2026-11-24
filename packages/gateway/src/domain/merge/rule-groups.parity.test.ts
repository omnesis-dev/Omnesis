// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Parity goldens for the People → Rules page (`GET /people/merge-rule-groups`).
 * `__fixtures__/rule-groups-parity.<fixture>.json` holds every page the page's
 * read returned on the empty, small, edge and large invented fixtures, for
 * each kind filter and search the page offers, followed through the cursor at
 * page sizes of one, three and fifty (whole pages at fifty; at the smaller
 * sizes, each page's identities and cursor). Any change to how or where the
 * page reads must reproduce them exactly: the same identities in the same
 * order, with the same rules, people, sources and cursors.
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { PersonService } from "../../http/services/PersonService.js";
import {
  RULE_GROUP_FILTERS,
  loadAllPages,
  seedEdgeRuleGroups,
  seedLargeRuleGroups,
  seedSmallRuleGroups,
} from "./rule-groups-test-utils.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const FIXTURES: Record<string, (db: Db) => void> = {
  empty: () => {},
  small: seedSmallRuleGroups,
  edge: seedEdgeRuleGroups,
  large: (db) => seedLargeRuleGroups(db, 40),
};

let path: string;
let db: Db;
beforeEach(() => {
  path = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

describe("merge-rule groups parity", () => {
  for (const name of Object.keys(FIXTURES)) {
    test(`the ${name} fixture pages exactly as the main-handle read did`, async () => {
      FIXTURES[name]!(db);
      const service = new PersonService(db, {} as WriteGate);
      const load = (query: Parameters<PersonService["listMergeRuleGroups"]>[0]) =>
        service.listMergeRuleGroups(query);
      const captured: Record<string, unknown> = {};
      for (const filter of RULE_GROUP_FILTERS) {
        for (const limit of [1, 3, 50]) {
          const pages = await loadAllPages(load, { ...filter, limit });
          // Whole pages at the page size the portal uses; at the small sizes,
          // where the cursor does the work, each page's identities and cursor.
          captured[JSON.stringify({ ...filter, limit })] =
            limit === 50
              ? pages
              : pages.map((page) => ({
                  keys: page.items.map((item) => item.key),
                  hasMore: page.hasMore,
                  last: page.last ?? null,
                }));
        }
      }
      await expect(JSON.stringify(captured, null, 1) + "\n").toMatchFileSnapshot(
        `./__fixtures__/rule-groups-parity.${name}.json`,
      );
    });
  }
});
