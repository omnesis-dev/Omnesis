// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The discovery backlog walks one source's documents in date order past every
 * one already covered. On a document row the revision is stored after the
 * content, so a walk that read each row would pay the content's overflow pages
 * for every document it passes over. On the production schema the walk must
 * read the revision from the date index and look rows up only for what it
 * returns.
 */
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { listKnowledgeDiscoveryBacklog } from "./discovery.js";
import type Database from "better-sqlite3";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

/** The backlog statement and its parameters, as the function runs it. */
function backlogStatement(): { sql: string; params: unknown[] } {
  let captured: { sql: string; params: unknown[] } | undefined;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!/FROM documents d\b/.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key !== "all" || typeof value !== "function") return value;
        return (...params: unknown[]) => {
          captured = { sql, params };
          return (value as (...args: unknown[]) => unknown).apply(target, params);
        };
      },
    });
  }) as typeof db.prepare;
  try {
    listKnowledgeDiscoveryBacklog(db, {
      phase: "interpretation",
      limit: 20,
      now: Date.parse("2027-04-06T09:00:00Z"),
      sourceId: "fixture-mail",
      notBefore: "2026-10-01T00:00:00.000Z",
    });
  } finally {
    db.prepare = prepare;
  }
  if (!captured) throw new Error("the backlog statement did not run");
  return captured;
}

it("walks one source's documents through the date index that carries their revision", () => {
  const { sql, params } = backlogStatement();
  const plan = db
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
  expect(plan).toContain(
    "SEARCH d USING INDEX idx_documents_source_created_revision (source_id=? AND source_created_at>?)",
  );

  // The bytecode reads content_hash from the index cursor; the table cursor is
  // positioned by a deferred seek, so a document the filter rejects is never read.
  const root = (name: string) =>
    db
      .prepare<[string], { rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name=?")
      .get(name)!.rootpage;
  const program = db
    .prepare<unknown[], { opcode: string; p1: number; p2: number }>(`EXPLAIN ${sql}`)
    .all(...params);
  const cursorsOn = (rootpage: number) =>
    new Set(
      program.filter((op) => op.opcode === "OpenRead" && op.p2 === rootpage).map((op) => op.p1),
    );
  const tableCursors = cursorsOn(root("documents"));
  const indexCursors = cursorsOn(root("idx_documents_source_created_revision"));
  expect(tableCursors.size).toBeGreaterThan(0);
  expect(indexCursors.size).toBeGreaterThan(0);
  const contentHash = db
    .prepare<[], { cid: number; name: string }>(
      "SELECT cid, name FROM pragma_table_info('documents')",
    )
    .all()
    .find((column) => column.name === "content_hash")!.cid;
  expect(
    program.filter(
      (op) => op.opcode === "Column" && tableCursors.has(op.p1) && op.p2 === contentHash,
    ),
  ).toEqual([]);
  expect(program.some((op) => op.opcode === "DeferredSeek" && indexCursors.has(op.p1))).toBe(true);
});

it("returns the backlog in date order with id as the tie-break", () => {
  const insert = db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES(?,'fixture','fixture-mail',?,?,?,?,?,?,?,?)`,
  );
  const at = (day: number) => `2026-11-0${day}T08:00:00.000Z`;
  // Inserted out of id order, with two documents sharing a date.
  for (const [id, day] of [
    ["mail-c", 2],
    ["mail-a", 2],
    ["mail-b", 3],
    ["mail-d", 1],
  ] as const)
    insert.run(
      id,
      id,
      `Survey ${id}`,
      `Field report ${id}.`.repeat(400),
      `hash-${id}`,
      at(day),
      at(day),
      at(day),
      at(day),
    );
  const listed = listKnowledgeDiscoveryBacklog(db, {
    phase: "interpretation",
    limit: 20,
    now: Date.parse("2027-04-06T09:00:00Z"),
    sourceId: "fixture-mail",
    notBefore: "2026-10-01T00:00:00.000Z",
  });
  expect(listed.map((document) => [document.id, document.contentHash])).toEqual([
    ["mail-b", "hash-mail-b"],
    ["mail-a", "hash-mail-a"],
    ["mail-c", "hash-mail-c"],
    ["mail-d", "hash-mail-d"],
  ]);
  expect(listed[0]).toMatchObject({ title: "Survey mail-b", sourceUpdatedAt: at(3) });
});
