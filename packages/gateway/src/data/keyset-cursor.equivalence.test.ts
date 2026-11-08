// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keyset cursors rewritten from an OR chain to a row-value comparison return
 * exactly the rows they returned before.
 *
 * `ts < ? OR (ts = ? AND id < ?)` is a disjunction the planner may split into
 * a multi-index OR and then sort in full; with `sqlite_stat1` present it does,
 * and a next-page read of a large source went from a fraction of a
 * millisecond to tens. `(ts, id) < (?, ?)` is one range on the same index.
 * A cursor whose columns run in mixed directions has no single row value, so
 * it bounds the leading column and excludes the cursor's own tie instead.
 *
 * Each rewritten call site is one of the shapes below. For every shape the
 * suite walks a table full of ties and NULLs from every possible cursor and
 * compares the old predicate with the new one row for row; the two cited
 * call sites are also paged end to end against the order they promise.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { listAccessAuditEvents } from "../access/store-audit.js";
import { seedPilotCorpus } from "../scheduler/__fixtures__/pilot-corpus.js";
import { getRecentDocuments } from "./repositories/DocumentRepository.js";

type Db = Database.Database;

interface Shape {
  /** ORDER BY over the scratch table's columns. */
  order: string;
  /** Key columns in order, for building cursors from rows. */
  keys: string[];
  old: string;
  oldArgs: (k: unknown[]) => unknown[];
  now: string;
  nowArgs: (k: unknown[]) => unknown[];
}

const SHAPES: Record<string, Shape> = {
  descending: {
    order: "a DESC, b DESC",
    keys: ["a", "b"],
    old: "(a < ? OR (a = ? AND b < ?))",
    oldArgs: ([a, b]) => [a, a, b],
    now: "(a, b) < (?, ?)",
    nowArgs: ([a, b]) => [a, b],
  },
  ascending: {
    order: "a ASC, b ASC",
    keys: ["a", "b"],
    old: "(a > ? OR (a = ? AND b > ?))",
    oldArgs: ([a, b]) => [a, a, b],
    now: "(a, b) > (?, ?)",
    nowArgs: ([a, b]) => [a, b],
  },
  descendingThenAscending: {
    order: "a DESC, b ASC",
    keys: ["a", "b"],
    old: "(a < ? OR (a = ? AND b > ?))",
    oldArgs: ([a, b]) => [a, a, b],
    now: "a <= ? AND NOT (a = ? AND b <= ?)",
    nowArgs: ([a, b]) => [a, a, b],
  },
  descendingThenTwoAscending: {
    order: "a DESC, b ASC, c ASC",
    keys: ["a", "b", "c"],
    old: "(a < ? OR (a = ? AND b > ?) OR (a = ? AND b = ? AND c > ?))",
    oldArgs: ([a, b, c]) => [a, a, b, a, b, c],
    now: "a <= ? AND NOT (a = ? AND (b, c) <= (?, ?))",
    nowArgs: ([a, b, c]) => [a, a, b, c],
  },
  descendingThenThreeAscending: {
    order: "a DESC, b ASC, c ASC, d ASC",
    keys: ["a", "b", "c", "d"],
    old:
      "(a < ? OR (a = ? AND b > ?) OR (a = ? AND b = ? AND c > ?)" +
      " OR (a = ? AND b = ? AND c = ? AND d > ?))",
    oldArgs: ([a, b, c, d]) => [a, a, b, a, b, c, a, b, c, d],
    now: "a <= ? AND NOT (a = ? AND (b, c, d) <= (?, ?, ?))",
    nowArgs: ([a, b, c, d]) => [a, a, b, c, d],
  },
};

/** Every rewritten call site and the shape its cursor has. */
const CALL_SITES: Array<[string, keyof typeof SHAPES]> = [
  ["DocumentRepository.getRecentDocuments", "descending"],
  ["access/store-audit.listAccessAuditEvents", "descending"],
  ["brain/storage/annotations.listLiveAnnotationsForDoc", "descending"],
  ["brain/tasks/views done tasks", "descending"],
  ["brain/transcripts list", "descending"],
  ["domain/merge/rule-crud.listMergeRules", "descending"],
  ["http/services/PersonService merge history", "descending"],
  ["privacy/presentation exchanges", "descending"],
  ["privacy/store-audit.listPrivacyConversations", "descending"],
  ["privacy/store-queries approvals", "descending"],
  ["subscriptions/store-queries subscriptions", "descending"],
  ["subscriptions/store-queries approvals", "descending"],
  ["subscriptions/store-queries firings", "descending"],
  ["brain/knowledge/connections.readKnowledgeConnections", "ascending"],
  ["brain/storage/interest.listUnembeddedInterestSignals", "ascending"],
  ["watch/materializer document sweep", "ascending"],
  ["watch/materializer index sweep", "ascending"],
  ["sources/omnesis-notes/storage.listNoteEntriesHistory", "descendingThenAscending"],
  ["near-dupes/NearDupGraphService.getNearDupEdges", "descendingThenAscending"],
  ["brain/storage/consumption-edges.listLiveDependentsForAnnotation", "descendingThenTwoAscending"],
  ["brain/storage/coverage.listCognitionCoverage", "descendingThenThreeAscending"],
];

const opened: Array<{ db: Db; path?: string }> = [];
afterEach(() => {
  for (const { db, path } of opened.splice(0)) {
    db.close();
    if (path)
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

/** Rows tied on every prefix, NULL in each column somewhere, unique as a whole key. */
function scratch(): Db {
  const db = new Database(":memory:");
  opened.push({ db });
  db.exec("CREATE TABLE t (a INTEGER, b TEXT, c INTEGER, d INTEGER, UNIQUE(a, b, c, d))");
  db.exec("CREATE INDEX t_ab ON t(a, b)");
  const insert = db.prepare("INSERT OR IGNORE INTO t (a, b, c, d) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 360; i++) {
    const a = i % 23 === 0 ? null : Math.floor(i / 40);
    const b = i % 31 === 0 ? null : `k${i % 7}`;
    const c = i % 37 === 0 ? null : i % 3;
    insert.run(a, b, c, i % 5);
  }
  return db;
}

function rows(db: Db, shape: Shape, where: string, args: unknown[]): string[] {
  return db
    .prepare(`SELECT a, b, c, d FROM t WHERE ${where} ORDER BY ${shape.order}, d, c, b, a`)
    .all(...(args as never[]))
    .map((r) => JSON.stringify(r));
}

describe("rewritten keyset cursors", () => {
  test("every rewritten call site has a shape", () => {
    for (const [site, shape] of CALL_SITES) expect(SHAPES[shape], site).toBeDefined();
  });

  for (const [name, shape] of Object.entries(SHAPES)) {
    test(`${name}: the new predicate returns the old one's rows from every cursor`, () => {
      const db = scratch();
      const all = db
        .prepare(`SELECT ${shape.keys.join(", ")} FROM t`)
        .raw()
        .all() as unknown[][];
      const cursors = [...all, shape.keys.map(() => 2), shape.keys.map(() => 9999)];
      for (const key of cursors) {
        expect(rows(db, shape, shape.now, shape.nowArgs(key)), JSON.stringify(key)).toEqual(
          rows(db, shape, shape.old, shape.oldArgs(key)),
        );
      }
    });
  }
});

describe("rewritten keyset pages end to end", () => {
  function corpus(): Db {
    const path = `/tmp/omnesis-test-${randomUUID()}.db`;
    const db = createDatabase(path) as unknown as Db;
    opened.push({ db, path });
    seedPilotCorpus(db, { docs: 2_000 });
    // Ties on the timestamp a page orders by.
    db.exec(
      "UPDATE documents SET source_created_at = substr(source_created_at, 1, 7) || '-01T00:00:00.000Z' WHERE source_id = 'synth-mail-work'",
    );
    return db;
  }

  test("recent documents page through a source in its promised order, ties included", () => {
    const db = corpus();
    const expected = db
      .prepare<[], { id: string }>(
        `SELECT id FROM documents WHERE source_id = 'synth-mail-work'
          ORDER BY source_created_at DESC, id DESC`,
      )
      .all()
      .map((r) => r.id);
    const ties = db
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM (SELECT source_created_at FROM documents
          WHERE source_id = 'synth-mail-work' GROUP BY 1 HAVING COUNT(*) > 1)`,
      )
      .get()!.n;
    expect(ties).toBeGreaterThan(10);
    const paged: string[] = [];
    let before: { sourceCreatedAt: string; id: string } | undefined;
    for (;;) {
      const page = getRecentDocuments(db, "synth-mail-work", 7, before);
      if (page.length === 0) break;
      paged.push(...page.map((d) => d.id));
      const last = page.at(-1)!;
      before = { sourceCreatedAt: last.source_created_at, id: last.id };
    }
    expect(paged).toEqual(expected);
  });

  test("the access ledger pages newest first, ties included, with and without a principal", () => {
    const db = corpus();
    for (const principalId of [undefined, "synth-principal-3"]) {
      const expected = db
        .prepare<unknown[], { id: string }>(
          `SELECT id FROM access_audit_events ${principalId ? "WHERE principal_id = ?" : ""}
            ORDER BY occurred_at DESC, id DESC`,
        )
        .all(...(principalId ? [principalId] : []))
        .map((r) => r.id);
      const paged: string[] = [];
      let after: { occurredAt: number; id: string } | undefined;
      for (;;) {
        const page = listAccessAuditEvents(db, { limit: 4, principalId, after });
        paged.push(...page.items.map((e) => e.id));
        if (!page.hasMore) break;
        const last = page.items.at(-1)!;
        after = { occurredAt: last.occurredAt, id: last.id };
      }
      expect(paged).toEqual(expected);
    }
  });
});
