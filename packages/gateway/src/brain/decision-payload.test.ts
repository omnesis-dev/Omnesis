// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import { createKnowledgeTables } from "./knowledge/schema.js";
import { createBriefsStorageTables } from "./storage/schema.js";
import {
  captureDecisionPayloadSubjects,
  createDecisionPayloadTables,
  decisionPayloadErasureGeneration,
  readDecisionPayload,
  recordDecisionPayload,
} from "./decision-payload.js";

let db: Database.Database;
const payload = {
  requestJson: JSON.stringify({ state: { content: "Observatory access lasts two hours." } }),
  responseJson: JSON.stringify({ answers: { impact: { type: "score", score: 1 } } }),
  error: null,
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT); CREATE TABLE knowledge_decisions(id TEXT PRIMARY KEY); CREATE TABLE removed_sources(id TEXT PRIMARY KEY)",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  db.exec(
    "INSERT INTO documents VALUES('first','fictional','v1'),('second','fictional','v1'); INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('first','v1',0,1),('second','v1',0,1)",
  );
  createDecisionPayloadTables(db);
});
afterEach(() => db.close());
function sourceCapture() {
  return captureDecisionPayloadSubjects(
    db,
    { sourceIds: ["first", "second"] },
    decisionPayloadErasureGeneration(db),
  )!;
}
function node(id: string) {
  db.prepare(
    "INSERT INTO knowledge_nodes(id,kind,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES(?,'wiki',?,'text','text',1,1,'hash','current','{}','{}',1,1)",
  ).run(id, id);
}
function dependency(nodeId: string, targetKind: string, targetId: string, historical = false) {
  if (historical)
    db.prepare(
      "INSERT INTO knowledge_revision_dependencies(node_id,revision,target_kind,target_id) VALUES(?,1,?,?)",
    ).run(nodeId, targetKind, targetId);
  else
    db.prepare(
      "INSERT INTO knowledge_dependencies(node_id,claim_id,ref,target_id,target_kind,relation,input_version_json) VALUES(?,'fact',?,?,?,'context','1')",
    ).run(nodeId, `${targetKind}:${targetId}`, targetId, targetKind);
}
it("retains the exact multi-source request, result and error, erasing all when a secondary source is removed", () => {
  const capture = sourceCapture();
  const failed = { ...payload, error: "A source-dependent reply was invalid." };
  recordDecisionPayload(db, "record-check", capture, failed, 1);
  expect(readDecisionPayload(db, "record-check")).toEqual({
    availability: "available",
    request: JSON.parse(payload.requestJson),
    response: JSON.parse(payload.responseJson),
    error: failed.error,
  });
  db.prepare("DELETE FROM documents WHERE id='second'").run();
  expect(readDecisionPayload(db, "record-check").availability).toBe("unavailable");
  expect(
    db.prepare("SELECT count(*) AS count FROM knowledge_decision_input_subjects").get(),
  ).toEqual({ count: 0 });
  db.prepare("INSERT INTO documents VALUES('second','fictional','v1')").run();
  recordDecisionPayload(db, "late", capture, payload);
  expect(readDecisionPayload(db, "late").availability).toBe("unavailable");
});
it.each(["source-purge", "node-purge", "node-delete", "node-tombstone"])(
  "erases derived input through retained ancestry on %s",
  (kind) => {
    node("overview");
    node("detail");
    dependency("overview", "node", "detail");
    dependency("detail", "source", "second", true);
    const capture = captureDecisionPayloadSubjects(
      db,
      { nodeIds: ["overview"], nodeRevisions: { overview: 1 } },
      decisionPayloadErasureGeneration(db),
    )!;
    expect(capture.subjects).toEqual(
      expect.arrayContaining([
        { kind: "node", id: "detail" },
        { kind: "source", id: "second" },
      ]),
    );
    recordDecisionPayload(db, "impact", capture, payload);
    // Historical capture keeps its original ancestry even after ordinary edits.
    db.prepare("DELETE FROM knowledge_revision_dependencies WHERE node_id='detail'").run();
    if (kind.endsWith("purge"))
      db.prepare(
        "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge',?,?, 'v1',2)",
      ).run(
        kind === "source-purge" ? "source" : "node",
        kind === "source-purge" ? "second" : "detail",
      );
    if (kind === "node-delete") db.prepare("DELETE FROM knowledge_nodes WHERE id='detail'").run();
    if (kind === "node-tombstone")
      db.prepare("INSERT INTO knowledge_node_tombstones VALUES('detail',2)").run();
    expect(db.prepare("SELECT count(*) AS count FROM knowledge_decision_inputs").get()).toEqual({
      count: 0,
    });
    recordDecisionPayload(db, "late", capture, payload);
    expect(readDecisionPayload(db, "late").availability).toBe("unavailable");
  },
);
it("refuses a node snapshot whose ordinary revision changed before its privacy closure was collected", () => {
  node("page");
  const generation = decisionPayloadErasureGeneration(db);
  dependency("page", "source", "second");
  db.prepare("UPDATE knowledge_nodes SET revision=2 WHERE id='page'").run();
  db.prepare("DELETE FROM knowledge_dependencies WHERE node_id='page'").run();
  expect(
    captureDecisionPayloadSubjects(
      db,
      { nodeIds: ["page"], nodeRevisions: { page: 1 } },
      generation,
    ),
  ).toBeNull();
});
it.each(["knowledge_decisions", "cognition_decisions"])(
  "cleans payload mappings on %s deletion and normal retention",
  (name) => {
    if (name === "cognition_decisions")
      db.prepare(
        `INSERT INTO cognition_decisions
        (id,run_id,document_id,subject_document_id,purpose,lane,rubric_version,requested_model_id,threshold,verdict,created_at)
        VALUES ('verdict','fixture-run','first','first','record-check','synthesis','fixture','scripted',1,'pass',1)`,
      ).run();
    else db.prepare("INSERT INTO knowledge_decisions VALUES('verdict')").run();
    recordDecisionPayload(db, "verdict", sourceCapture(), payload, 1);
    db.prepare(`DELETE FROM ${name} WHERE id='verdict'`).run();
    expect(readDecisionPayload(db, "verdict").availability).toBe("unavailable");
    recordDecisionPayload(db, "retained", sourceCapture(), payload, 1);
    db.prepare("DELETE FROM knowledge_decision_inputs WHERE created_at<2").run();
    expect(
      db.prepare("SELECT count(*) AS count FROM knowledge_decision_input_subjects").get(),
    ).toEqual({ count: 0 });
  },
);
it("keeps over-budget and unbounded scopes unavailable without truncating captured input", () => {
  expect(
    captureDecisionPayloadSubjects(
      db,
      { sourceIds: Array.from({ length: 257 }, (_, i) => `source-${i}`) },
      decisionPayloadErasureGeneration(db),
    ),
  ).toBeNull();
  expect(
    captureDecisionPayloadSubjects(
      db,
      { sourceIds: ["missing"] },
      decisionPayloadErasureGeneration(db),
    ),
  ).toBeNull();
  recordDecisionPayload(db, "oversized", sourceCapture(), {
    ...payload,
    requestJson: "x".repeat(131073),
  });
  expect(readDecisionPayload(db, "oversized")).toEqual({
    availability: "oversized",
    request: null,
    response: null,
    error: null,
  });
});
it("upgrades legacy urgency payloads without fabricating missing historical captures", () => {
  db.exec(
    "DROP TABLE knowledge_decision_input_subjects; DROP TABLE knowledge_decision_inputs; CREATE TABLE knowledge_decision_inputs(decision_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,input_revision TEXT NOT NULL,request_json TEXT,response_json TEXT,availability TEXT NOT NULL,created_at INTEGER NOT NULL)",
  );
  db.prepare(
    "INSERT INTO knowledge_decision_inputs VALUES('legacy','first','v1',?,?,'available',1)",
  ).run(payload.requestJson, payload.responseJson);
  createDecisionPayloadTables(db);
  createDecisionPayloadTables(db);
  expect(readDecisionPayload(db, "legacy").request).toEqual(JSON.parse(payload.requestJson));
  expect(readDecisionPayload(db, "absent").availability).toBe("unavailable");
  db.prepare("DELETE FROM documents WHERE id='first'").run();
  expect(readDecisionPayload(db, "legacy").availability).toBe("unavailable");
});
it("fails safely in small stores without payload tables", () => {
  const small = new Database(":memory:");
  try {
    expect(decisionPayloadErasureGeneration(small)).toBe(-1);
    expect(captureDecisionPayloadSubjects(small, { sourceIds: ["first"] }, -1)).toBeNull();
    expect(readDecisionPayload(small, "absent").availability).toBe("unavailable");
  } finally {
    small.close();
  }
});
