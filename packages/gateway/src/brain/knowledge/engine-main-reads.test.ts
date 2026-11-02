// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The knowledge engine's tick and `next` run on the gateway's main event loop,
 * so every read they make on the main handle must be a bounded index seek. On a
 * real corpus the knowledge ledgers hold hundreds of thousands of rows and the
 * store is encrypted, so a statement that scans one of them stalls the loop
 * for a second or more. This drives a tick and a maintenance turn against the
 * full gateway schema, with writes and worker selections on their own handles
 * as in the gateway, and checks the plan of every statement the main handle ran.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { resolveBrainSettings } from "../config.js";
import {
  COGNITION_BOOTSTRAP_STARTED_AT_KEY,
  setCognitionEngineState,
} from "../storage/engine-state.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeEngine } from "./engine.js";
import { directKnowledgeSelectionReads } from "./selection-reads.js";
import type Database from "better-sqlite3";

/** Tables that grow with the corpus or with every maintenance batch ever run. */
const LEDGERS = [
  "documents",
  "knowledge_work",
  "knowledge_frontier",
  "knowledge_batches",
  "knowledge_batch_regions",
  "knowledge_changes",
  "knowledge_discovery_coverage",
  "knowledge_discovery_targets",
  "knowledge_dependencies",
  "source_inventory_documents",
];

/**
 * A seek on a whole-table index that narrows only by a kind column, which has
 * a handful of values, still walks most of a ledger. A partial index is
 * already bounded by its own condition, such as pending work.
 */
const BROAD_SEEK = /USING (?:COVERING )?INDEX (\w+) \((?:subject_kind|target_kind|kind)=\?\)$/;

/** The table each alias in a statement names, the tables themselves included. */
function aliases(sql: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const [, table, alias] of sql.matchAll(
    /\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(?!ON\b|WHERE\b|JOIN\b|LEFT\b|CROSS\b|INNER\b|USING\b|GROUP\b|ORDER\b|LIMIT\b)(\w+))?/gi,
  )) {
    names.set(table!, table!);
    if (alias) names.set(alias, table!);
  }
  return names;
}

/** Whether a plan step reads a ledger by a scan or by a seek that is one in practice. */
function scansLedger(db: Database.Database, detail: string, names: Map<string, string>): boolean {
  const step = /^(SCAN|SEARCH) (\w+)/.exec(detail);
  if (!step || !LEDGERS.includes(names.get(step[2]!) ?? step[2]!)) return false;
  // A step that names no index reads every row, whichever word the plan uses.
  if (step[1] === "SCAN" || !/ USING /.test(detail)) return true;
  const index = BROAD_SEEK.exec(detail)?.[1];
  if (!index) return false;
  const definition = db
    .prepare<[string], { sql: string | null }>("SELECT sql FROM sqlite_master WHERE name=?")
    .get(index);
  return !/\bWHERE\b/i.test(definition?.sql ?? "");
}

const log = createLogger("test:knowledge-main-reads");
let dbPath: string;
let handles: Database.Database[];

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  handles = [];
});
afterEach(() => {
  for (const handle of handles) handle.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

function open(): Database.Database {
  const handle = createDatabase(dbPath) as unknown as Database.Database;
  handles.push(handle);
  return handle;
}

it("reads the knowledge ledgers on the main handle only through index seeks", async () => {
  const writer = open();
  const insert = writer.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES(?,'fixture','fixture-notes',?,?,?,?,?,?,?,?)`,
  );
  const now = Date.parse("2027-04-06T09:00:00Z");
  const at = new Date(now - 86_400_000).toISOString();
  for (let i = 0; i < 6; i++)
    insert.run(
      `note-${i}`,
      `note-${i}`,
      `Field note ${i}`,
      `The survey crew logged reading ${i} at the north station.`,
      `hash-${i}`,
      at,
      at,
      at,
      at,
    );
  setCognitionEngineState(writer, COGNITION_BOOTSTRAP_STARTED_AT_KEY, String(now - 1000));

  // The main handle records every statement it runs, with its parameters.
  const main = open();
  const ran = new Map<string, unknown[]>();
  const prepare = main.prepare.bind(main);
  main.prepare = ((sql: string) => {
    const statement = prepare(sql);
    const record =
      (run: (...params: unknown[]) => unknown) =>
      (...params: unknown[]) => {
        if (!ran.has(sql)) ran.set(sql, params);
        return run(...params);
      };
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        return ["get", "all", "run", "iterate"].includes(String(key)) ? record(bound) : bound;
      },
    });
  }) as typeof main.prepare;

  const settings = resolveBrainSettings({ excludedSources: ["fixture-private"] });
  const writeGate = directKnowledgeGate(writer);
  const clock = () => now;
  const service = new KnowledgeService({
    db: main,
    writeGate,
    getSettings: () => settings,
    clock,
    log,
  });
  const decision: DecisionCapability = {
    modelId: "scripted",
    dispose() {},
    async decide(request) {
      return {
        model: "scripted",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            { type: "score" as const, score: 1.8 },
          ]),
        ),
      };
    },
  };
  let serial = 0;
  const engine = new KnowledgeEngine({
    db: main,
    writeGate,
    service,
    getSettings: () => settings,
    clock,
    log,
    idGen: () => String(++serial),
    decisions: { getDecision: () => decision, log, recordSpend: async () => {} },
    selectionReads: directKnowledgeSelectionReads(open()),
  });
  for (let tick = 0; tick < 3; tick++) await engine.tick();
  const batch = writer
    .prepare<[], { id: string; runId: string }>(
      "SELECT id,run_id AS runId FROM knowledge_batches ORDER BY created_at LIMIT 1",
    )
    .get();
  expect(batch).toBeDefined();
  const offered = await engine.next(batch!.id, batch!.runId);
  expect(offered.items.map((item) => item.id)).toContain("source:note-0");

  main.prepare = prepare;
  const scans: string[] = [];
  for (const [sql, params] of ran) {
    if (!/^\s*(WITH|SELECT)/i.test(sql)) continue;
    const plan = main
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail);
    for (const detail of plan)
      if (scansLedger(main, detail, aliases(sql)))
        scans.push(`${detail}\n  in: ${sql.replace(/\s+/g, " ")}`);
  }
  expect(ran.size).toBeGreaterThan(20);
  expect(scans).toEqual([]);
});
