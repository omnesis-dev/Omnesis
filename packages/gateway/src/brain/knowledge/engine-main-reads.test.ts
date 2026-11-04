// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The knowledge engine's tick and `next` run on the gateway's main event loop,
 * so every read they make on the main handle must be a bounded index seek. On a
 * real corpus the knowledge ledgers hold hundreds of thousands of rows and the
 * store is encrypted, so a statement that scans one of them stalls the loop
 * for a second or more, and so does one that walks document rows, whose
 * revision lies past their content. This drives a tick and a maintenance turn against the
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
import { ledgerScans, recordStatements } from "./test-utils.js";
import type Database from "better-sqlite3";

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

  // The main handle records every statement it runs, with its parameters; so
  // does the handle the selection reads use, standing in for the read worker.
  const main = open();
  const { statements: ran, stop } = recordStatements(main);
  const selectionHandle = open();
  const { statements: ranOffMain } = recordStatements(selectionHandle);

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
    selectionReads: directKnowledgeSelectionReads(selectionHandle),
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

  stop();
  expect(ran.size).toBeGreaterThan(20);
  expect(ledgerScans(main, ran)).toEqual([]);
  // The reads the engine runs on the read worker ran there, and not on main.
  const ranOn = (statements: Map<string, unknown[]>) =>
    OFF_MAIN.filter(([, pattern]) => [...statements.keys()].some((sql) => pattern.test(sql))).map(
      ([name]) => name,
    );
  expect(ranOn(ranOffMain)).toEqual(OFF_MAIN.map(([name]) => name));
  expect(ranOn(ran)).toEqual([]);
});

/** Statements the engine runs only through its selection reads. */
const OFF_MAIN: Array<[string, RegExp]> = [
  ["planning window", /FROM knowledge_work WHERE status='pending' ORDER BY due_at,created_at,id/],
  ["batch recovery", /LEFT JOIN cognition_runs r ON r\.id=b\.run_id/],
  ["payload capture", /WITH RECURSIVE ancestors/],
];
