// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AGENT_TOOL_CARDS, createLogger } from "@omnesis/core";
import { summarizeToolArgs, type SearchPort, type ToolHandle } from "@omnesis/agent";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { createPersonAnnotation } from "../storage/person-annotations.js";
import { buildTaskTools } from "../tasks/tools.js";
import { createOpenLoopMirror } from "./mirror.js";
import { buildAnnotationTools, buildCognitionOwnTools } from "./tools.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const log = createLogger("test:tool-summaries");
const emptySearch: SearchPort = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async search(input) {
    return { query: input.query, durationMs: 0, results: [] };
  },
};

let db: Database.Database;
let path: string;
beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  db.prepare(
    `INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at)
    VALUES('person','Maya','test',?,?,?,?)`,
  ).run(NOW, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,
    source_created_at,source_updated_at,ingested_at,updated_at) VALUES('doc','test','test','doc','Workshop invoice','Maya runs the workshop.','h',?,?,?,?)`,
  ).run(NOW, NOW, NOW, NOW);
  createOpenLoop(
    db,
    {
      id: "loop_budget",
      createdByRun: "r0",
      title: "Review the Q4 budget",
      description: "",
      confidence: 0.8,
      importance: 0.5,
    },
    NOW,
  );
  createPersonAnnotation(
    db,
    {
      id: "pa_role",
      personId: "person",
      claimType: "role",
      claimText: "Maya runs the workshop.",
      evidenceDocId: "doc",
      evidenceQuote: "Maya runs the workshop.",
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "seed",
      verificationState: "verified",
      lastVerifiedAt: NOW,
    },
    NOW,
  );
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function tools(): ToolHandle[] {
  const writeGate = directWriteGate(db);
  return [
    ...buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearch,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => NOW,
      runId: "run",
      idGen: () => randomUUID(),
      log,
    }),
    ...buildAnnotationTools({ db, writeGate, clock: () => NOW, runId: "run", log }),
    ...buildTaskTools({
      db,
      tasks: { apply: () => Promise.reject(new Error("unused")) },
      writeGate,
      origin: { surface: "conversation", runId: "run" },
      observations: true,
    }),
  ];
}
const summary = (name: string, args: unknown) =>
  summarizeToolArgs(
    tools().find((tool) => tool.name === name),
    args,
  );

it("every tool summarizes its own call, so a card never shows raw arguments", () => {
  for (const tool of tools()) expect(tool.summarize, tool.name).toBeTypeOf("function");
});

it("every tool has a decided transcript card", () => {
  for (const tool of tools()) expect(AGENT_TOOL_CARDS[tool.name], tool.name).toBeDefined();
});

it("names records by their title or text, not their id", () => {
  expect(summary("open_loop_fetch", { id: "loop_budget" })).toBe("Review the Q4 budget");
  expect(summary("task_update", { id: "loop_budget", action: "complete" })).toBe(
    "Review the Q4 budget",
  );
  expect(summary("task_update", { id: "loop_budget", action: "edit", title: "Close Q4" })).toBe(
    "Close Q4",
  );
  expect(summary("person_annotation_retract", { id: "pa_role" })).toBe("Maya runs the workshop.");
  expect(summary("annotation_search", { personId: "person" })).toBe("Maya");
  expect(summary("annotation_search", { docId: "doc" })).toBe("Workshop invoice");
  expect(
    summary("annotate_person", { personId: "person", claimText: "Maya prefers mornings." }),
  ).toBe("Maya: Maya prefers mornings.");
});

it("shows nothing for a record that does not exist, or a call with no subject", () => {
  expect(summary("open_loop_fetch", { id: "loop_missing" })).toBe("");
  expect(summary("observation_list", {})).toBe("");
  expect(summary("notes_rewrite", { text: "a\nb" })).toBe("");
  expect(summary("task_undo", { undoSeq: 4 })).toBe("");
});

it("excerpts long text on one line", () => {
  const text = `Remember   that\n${"the workshop ".repeat(10)}`;
  const line = summary("notes_append", { text });
  expect(line).not.toContain("\n");
  expect(line.length).toBeLessThanOrEqual(60);
  expect(line.endsWith("…")).toBe(true);
});
