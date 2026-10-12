// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import {
  createObservation,
  deleteObservationsCitingDocs,
  pruneClosedObservations,
  transitionObservation,
} from "../storage/observations.js";
import { markMorningBriefSent, replaceMorningBriefItems } from "../storage/morning-brief-items.js";
import { redactTaintedMorningBriefs } from "./redaction.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T07:00:00Z");
const log = createLogger("test").child("redaction");
let path: string;
let db: Database.Database;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  const iso = new Date(NOW - 86_400_000).toISOString();
  for (const id of ["doc_kept", "doc_gone"])
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
         source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'p', 's', ?, 'Club newsletter', 'body', 'h', ?, ?, ?, ?)`,
    ).run(id, id, iso, iso, iso, iso);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

function sendBrief(day: string, messageId: string, observations: Array<[string, string]>) {
  for (const [id, doc] of observations)
    createObservation(
      db,
      { id, createdByRun: "run_1", summary: `About ${doc}`, citations: [doc] },
      NOW - 3_600_000,
    );
  replaceMorningBriefItems(
    db,
    day,
    "run_d",
    observations.map(([id]) => id),
  );
  markMorningBriefSent(db, { day, runId: "run_d", conversationId: "conv_brief", messageId }, NOW);
}

function sweep() {
  const redacted: string[] = [];
  const result = redactTaintedMorningBriefs({
    db,
    writeGate: directWriteGate(db),
    getConversations: () => ({
      redactMorningBrief: async (_conversation, messageId) => {
        redacted.push(messageId);
        return true;
      },
    }),
    log,
  });
  return { result, redacted };
}

test("a brief whose observation was privacy-deleted is redacted once", async () => {
  sendBrief("2026-03-10", "msg_1", [
    ["obs_kept", "doc_kept"],
    ["obs_gone", "doc_gone"],
  ]);
  sendBrief("2026-03-11", "msg_2", [["obs_other", "doc_kept"]]);
  deleteObservationsCitingDocs(db, ["doc_gone"]);
  const first = sweep();
  expect(await first.result).toBe(1);
  expect(first.redacted).toEqual(["msg_1"]);
  const second = sweep();
  expect(await second.result).toBe(0);
});

test("an observation retired by age does not taint its brief", async () => {
  sendBrief("2026-03-10", "msg_1", [["obs_old", "doc_kept"]]);
  transitionObservation(db, "obs_old", { state: "dropped", reason: "expired" }, NOW);
  pruneClosedObservations(db, NOW + 1, NOW + 2, 10);
  expect(await sweep().result).toBe(0);
});

test("nothing happens while the conversation side is not running", async () => {
  sendBrief("2026-03-10", "msg_1", [["obs_gone", "doc_gone"]]);
  deleteObservationsCitingDocs(db, ["doc_gone"]);
  const result = await redactTaintedMorningBriefs({
    db,
    writeGate: directWriteGate(db),
    getConversations: () => null,
    log,
  });
  expect(result).toBe(0);
  expect(await sweep().result).toBe(1);
});
