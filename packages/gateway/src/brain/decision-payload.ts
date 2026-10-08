// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isKnowledgeEvidenceReadable } from "./knowledge/storage-source-fence.js";
import { isKnowledgeNodeReadable } from "./knowledge/storage-fence.js";
import type Database from "better-sqlite3";

export interface DecisionPayloadCapture {
  erasureGeneration: number;
  subjects: Array<{ kind: "source" | "node"; id: string }>;
}
export interface DecisionPayload {
  requestJson: string;
  responseJson: string | null;
  error?: string | null;
}
const MAX_SUBJECTS = 256;
function table(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function sourceReadable(db: Database.Database, id: string): boolean {
  return (
    table(db, "documents") &&
    !!db.prepare("SELECT 1 FROM documents WHERE id=?").get(id) &&
    table(db, "knowledge_source_revisions") &&
    isKnowledgeEvidenceReadable(db, id) &&
    (!table(db, "knowledge_cascade_jobs") ||
      !db
        .prepare(
          "SELECT 1 FROM knowledge_cascade_jobs WHERE kind='purge' AND target_kind='source' AND target_id=?",
        )
        .get(id))
  );
}
function subjectReadable(
  db: Database.Database,
  subject: DecisionPayloadCapture["subjects"][number],
  ancestry = true,
): boolean {
  if (subject.kind === "source") return sourceReadable(db, subject.id);
  return (
    table(db, "knowledge_nodes") &&
    !!db.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(subject.id) &&
    (ancestry
      ? isKnowledgeNodeReadable(db, subject.id)
      : !db.prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id=?").get(subject.id) &&
        !db
          .prepare(
            "SELECT 1 FROM knowledge_cascade_jobs WHERE kind='purge' AND target_kind='node' AND target_id=?",
          )
          .get(subject.id))
  );
}
/** Capture this generation before reading any content that the request will contain. */
export function decisionPayloadErasureGeneration(db: Database.Database): number {
  if (!table(db, "knowledge_decision_privacy")) return -1;
  return (
    db
      .prepare<
        [],
        { generation: number }
      >("SELECT generation FROM knowledge_decision_privacy WHERE id=1")
      .get()?.generation ?? -1
  );
}

/** Trusted producer subjects, including retained privacy ancestry; never model-supplied IDs. */
export function captureDecisionPayloadSubjects(
  db: Database.Database,
  seeds: {
    sourceIds?: readonly string[];
    nodeIds?: readonly string[];
    nodeRevisions?: Readonly<Record<string, number>>;
  },
  erasureGeneration: number,
): DecisionPayloadCapture | null {
  return db.transaction(() => {
    const subjects = [
      ...(seeds.sourceIds ?? []).map((id) => ({ kind: "source" as const, id })),
      ...(seeds.nodeIds ?? []).map((id) => ({ kind: "node" as const, id })),
    ];
    if (
      erasureGeneration < 0 ||
      !subjects.length ||
      subjects.length > MAX_SUBJECTS ||
      erasureGeneration !== decisionPayloadErasureGeneration(db)
    )
      return null;
    // If the producer already read a node, pin its revision while collecting the
    // privacy closure so a concurrent ordinary edit cannot remove old ancestors.
    for (const [id, revision] of Object.entries(seeds.nodeRevisions ?? {})) {
      const current = db
        .prepare<[string], { revision: number }>("SELECT revision FROM knowledge_nodes WHERE id=?")
        .get(id);
      if (!current || current.revision !== revision) return null;
    }
    const edges: string[] = [];
    for (const name of ["knowledge_dependencies", "knowledge_revision_dependencies"])
      if (table(db, name))
        edges.push(
          `UNION SELECT d.target_kind,d.target_id FROM ${name} d JOIN ancestors a ON a.kind='node' AND d.node_id=a.id`,
        );
    if (table(db, "brief_related_loops") && table(db, "knowledge_nodes"))
      edges.push(
        "UNION SELECT 'node',b.loop_id FROM brief_related_loops b JOIN ancestors a ON a.kind='node' AND b.brief_id=a.id WHERE EXISTS(SELECT 1 FROM knowledge_nodes n WHERE n.id=b.loop_id) OR EXISTS(SELECT 1 FROM knowledge_node_tombstones t WHERE t.id=b.loop_id)",
      );
    if (table(db, "knowledge_retired_loop_sources"))
      edges.push(
        "UNION SELECT 'source',r.document_id FROM knowledge_retired_loop_sources r JOIN ancestors a ON a.kind='node' AND r.loop_id=a.id",
      );
    if (table(db, "knowledge_nodes")) {
      for (const [name, ownerColumn, sourceColumn] of [
        ["open_loop_docs", "loop_id", "doc_id"],
        ["brief_citations", "brief_id", "doc_id"],
        ["doc_annotations", "id", "doc_id"],
        ["doc_annotations", "id", "evidence_doc_id"],
        ["person_annotations", "id", "evidence_doc_id"],
        ["doc_annotation_evidence", "annotation_id", "evidence_doc_id"],
        ["person_annotation_evidence", "annotation_id", "evidence_doc_id"],
      ] as const)
        if (table(db, name))
          edges.push(
            `UNION SELECT 'source',d.${sourceColumn} FROM ${name} d JOIN knowledge_nodes n ON d.${ownerColumn}=COALESCE(n.owner_id,n.id) JOIN ancestors a ON a.kind='node' AND n.id=a.id`,
          );
    }
    const rows = db
      .prepare<[string, number], { kind: "source" | "node"; id: string }>(
        `WITH RECURSIVE ancestors(kind,id) AS (
    SELECT json_extract(value,'$.kind'),json_extract(value,'$.id') FROM json_each(?)
    ${edges.join("\n")} LIMIT ?
  ) SELECT kind,id FROM ancestors`,
      )
      .all(JSON.stringify(subjects), MAX_SUBJECTS + 1);
    if (rows.length > MAX_SUBJECTS || rows.some((s) => !subjectReadable(db, s))) return null;
    return { erasureGeneration, subjects: rows };
  })();
}

/** Shared exact request/result store; subject indexes erase multi-source and derived inputs. */
export function createDecisionPayloadTables(db: Database.Database): void {
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_decision_privacy(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL); INSERT OR IGNORE INTO knowledge_decision_privacy VALUES(1,0)",
    );
    const old = table(db, "knowledge_decision_inputs")
      ? db
          .prepare<
            [],
            { name: string; notnull: number }
          >("PRAGMA table_info(knowledge_decision_inputs)")
          .all()
      : [];
    if (old.some((c) => c.name === "source_id" && c.notnull === 1)) {
      for (const name of [
        "documents",
        "knowledge_source_revisions",
        "knowledge_cascade_jobs",
        "deleted_insert",
        "removed_source",
        "record",
        "node_deleted",
        "node_tombstone",
      ])
        db.exec(`DROP TRIGGER IF EXISTS knowledge_decision_erase_${name}`);
      for (const name of ["knowledge_decisions", "cognition_decisions"])
        db.exec(`DROP TRIGGER IF EXISTS knowledge_decision_payload_erase_${name}`);
      db.exec(`CREATE TABLE knowledge_decision_inputs_upgrade(decision_id TEXT PRIMARY KEY,source_id TEXT,input_revision TEXT,request_json TEXT,response_json TEXT,availability TEXT NOT NULL,created_at INTEGER NOT NULL,error_json TEXT);
      INSERT INTO knowledge_decision_inputs_upgrade SELECT decision_id,source_id,input_revision,request_json,response_json,availability,created_at,NULL FROM knowledge_decision_inputs;
      DROP TABLE knowledge_decision_inputs; ALTER TABLE knowledge_decision_inputs_upgrade RENAME TO knowledge_decision_inputs;`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_decision_inputs(decision_id TEXT PRIMARY KEY,source_id TEXT,input_revision TEXT,request_json TEXT,response_json TEXT,availability TEXT NOT NULL,created_at INTEGER NOT NULL,error_json TEXT);
    CREATE INDEX IF NOT EXISTS knowledge_decision_inputs_source ON knowledge_decision_inputs(source_id);
    CREATE INDEX IF NOT EXISTS knowledge_decision_inputs_time ON knowledge_decision_inputs(created_at,decision_id);
    CREATE TABLE IF NOT EXISTS knowledge_decision_input_subjects(decision_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(decision_id,kind,id));
    CREATE INDEX IF NOT EXISTS knowledge_decision_input_subjects_target ON knowledge_decision_input_subjects(kind,id,decision_id);
    INSERT OR IGNORE INTO knowledge_decision_input_subjects SELECT decision_id,'source',source_id FROM knowledge_decision_inputs WHERE source_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS knowledge_decision_input_cleanup AFTER DELETE ON knowledge_decision_inputs BEGIN DELETE FROM knowledge_decision_input_subjects WHERE decision_id=OLD.decision_id; END;`);
    const erase = (kind: "source" | "node", id: string) =>
      `UPDATE knowledge_decision_privacy SET generation=generation+1 WHERE id=1; DELETE FROM knowledge_decision_inputs WHERE decision_id IN (SELECT decision_id FROM knowledge_decision_input_subjects WHERE kind='${kind}' AND id=${id});`;
    const triggers: Array<[string, string, string]> = [
      [
        "documents",
        "documents",
        `AFTER DELETE ON documents BEGIN ${erase("source", "OLD.id")} END`,
      ],
      [
        "knowledge_source_revisions",
        "knowledge_source_revisions",
        `AFTER UPDATE OF deleted ON knowledge_source_revisions WHEN NEW.deleted=1 BEGIN ${erase("source", "NEW.document_id")} END`,
      ],
      [
        "deleted_insert",
        "knowledge_source_revisions",
        `AFTER INSERT ON knowledge_source_revisions WHEN NEW.deleted=1 BEGIN ${erase("source", "NEW.document_id")} END`,
      ],
      [
        "knowledge_cascade_jobs",
        "knowledge_cascade_jobs",
        `AFTER INSERT ON knowledge_cascade_jobs WHEN NEW.kind='purge' AND NEW.target_kind IN ('source','node') BEGIN UPDATE knowledge_decision_privacy SET generation=generation+1 WHERE id=1; DELETE FROM knowledge_decision_inputs WHERE decision_id IN(SELECT decision_id FROM knowledge_decision_input_subjects WHERE kind=NEW.target_kind AND id=NEW.target_id); END`,
      ],
      [
        "node_deleted",
        "knowledge_nodes",
        `AFTER DELETE ON knowledge_nodes BEGIN ${erase("node", "OLD.id")} END`,
      ],
      [
        "node_tombstone",
        "knowledge_node_tombstones",
        `AFTER INSERT ON knowledge_node_tombstones BEGIN ${erase("node", "NEW.id")} END`,
      ],
    ];
    for (const [name, target, body] of triggers)
      if (table(db, target)) {
        db.exec(
          `DROP TRIGGER IF EXISTS knowledge_decision_erase_${name}; CREATE TRIGGER knowledge_decision_erase_${name} ${body}`,
        );
      }
    if (
      table(db, "removed_sources") &&
      db
        .prepare<[], { name: string }>("PRAGMA table_info(documents)")
        .all()
        .some((c) => c.name === "source_id")
    )
      db.exec(`DROP TRIGGER IF EXISTS knowledge_decision_erase_removed_source;
    CREATE TRIGGER knowledge_decision_erase_removed_source AFTER INSERT ON removed_sources BEGIN UPDATE knowledge_decision_privacy SET generation=generation+1 WHERE id=1; DELETE FROM knowledge_decision_inputs WHERE decision_id IN(SELECT s.decision_id FROM knowledge_decision_input_subjects s JOIN documents d ON s.kind='source' AND s.id=d.id WHERE d.source_id=NEW.id); END`);
    for (const name of ["knowledge_decisions", "cognition_decisions"])
      if (table(db, name))
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS knowledge_decision_payload_erase_${name} AFTER DELETE ON ${name} BEGIN UPDATE knowledge_decision_privacy SET generation=generation+1 WHERE id=1; DELETE FROM knowledge_decision_inputs WHERE decision_id=OLD.id; END`,
        );
  })();
}

/** Must share the verdict writer transaction; erased or unbounded scopes retain metadata only. */
export function recordDecisionPayload(
  db: Database.Database,
  id: string,
  capture: DecisionPayloadCapture,
  payload: DecisionPayload,
  now = Date.now(),
): void {
  db.transaction(() => {
    if (
      !capture.subjects.length ||
      capture.subjects.length > MAX_SUBJECTS ||
      capture.erasureGeneration !== decisionPayloadErasureGeneration(db) ||
      capture.subjects.some((s) => !subjectReadable(db, s, false))
    )
      return;
    const exact =
      Buffer.byteLength(payload.requestJson, "utf8") <= 131072 &&
      (payload.responseJson === null || Buffer.byteLength(payload.responseJson, "utf8") <= 16384) &&
      Buffer.byteLength(payload.error ?? "", "utf8") <= 2048;
    db.prepare(
      "INSERT INTO knowledge_decision_inputs(decision_id,source_id,input_revision,request_json,response_json,availability,created_at,error_json) VALUES(?,NULL,NULL,?,?,?,?,?)",
    ).run(
      id,
      exact ? payload.requestJson : null,
      exact ? payload.responseJson : null,
      exact ? "available" : "oversized",
      now,
      exact ? JSON.stringify(payload.error ?? null) : null,
    );
    const insert = db.prepare(
      "INSERT OR IGNORE INTO knowledge_decision_input_subjects VALUES(?,?,?)",
    );
    for (const s of capture.subjects) insert.run(id, s.kind, s.id);
  })();
}
export function readDecisionPayload(db: Database.Database, id: string) {
  return db.transaction(() => {
    if (!table(db, "knowledge_decision_inputs") || !table(db, "knowledge_decision_input_subjects"))
      return { availability: "unavailable" as const, request: null, response: null, error: null };
    const row = db
      .prepare<
        [string],
        {
          requestJson: string | null;
          responseJson: string | null;
          errorJson: string | null;
          availability: string;
        }
      >(
        "SELECT request_json AS requestJson,response_json AS responseJson,error_json AS errorJson,availability FROM knowledge_decision_inputs WHERE decision_id=?",
      )
      .get(id);
    const subjects = db
      .prepare<
        [string],
        { kind: "source" | "node"; id: string }
      >("SELECT kind,id FROM knowledge_decision_input_subjects WHERE decision_id=? LIMIT 257")
      .all(id);
    if (
      !row ||
      !subjects.length ||
      subjects.length > MAX_SUBJECTS ||
      subjects.some((s) => !subjectReadable(db, s))
    )
      return { availability: "unavailable" as const, request: null, response: null, error: null };
    return {
      availability: row.availability,
      request: row.requestJson ? (JSON.parse(row.requestJson) as unknown) : null,
      response: row.responseJson ? (JSON.parse(row.responseJson) as unknown) : null,
      error: row.errorJson ? (JSON.parse(row.errorJson) as string | null) : null,
    };
  })();
}
