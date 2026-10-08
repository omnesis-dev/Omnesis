// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError, NotFoundError } from "../../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../../http/pagination-cursor.js";
import { areDecisionSourcesReadable } from "../decision-read-privacy.js";
import { readKnowledgeDecisionDebug } from "./decision-debug.js";
import { knowledgeHash } from "./storage-validation.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { getKnowledgeNode } from "./storage-read.js";
import type { KnowledgeDecisionPurpose } from "./decision.js";
import type Database from "better-sqlite3";

interface DecisionRow {
  id: string;
  purpose: KnowledgeDecisionPurpose;
  inputFingerprint: string;
  score: number | null;
  threshold: number | null;
  runId: string | null;
  batchId: string | null;
  nodeId: string | null;
  modelId: string;
  latencyMs: number;
  inputTokens: number | null;
  rubricVersion: string;
  createdAt: number;
  workId: string | null;
  sourceRevision: string | null;
  schedulingJson: string | null;
}
const projection = `id,purpose,input_fingerprint AS inputFingerprint,score,threshold,
  run_id AS runId,batch_id AS batchId,node_id AS nodeId,model_id AS modelId,
  latency_ms AS latencyMs,input_tokens AS inputTokens,rubric_version AS rubricVersion,created_at AS createdAt,work_id AS workId,source_revision AS sourceRevision,scheduling_json AS schedulingJson`;

/** Resolve display identity only through the current privacy fence, in the caller's snapshot. */
export function readDecisionSubjectRef(db: Database.Database, id: string | null) {
  if (!id) return null;
  if (id.startsWith("source:")) {
    const documentId = id.slice(7);
    if (!areDecisionSourcesReadable(db, { documentId, subjectDocumentId: documentId })) return null;
    const document = db
      .prepare<
        [string],
        { id: string; title: string; sourceId: string }
      >("SELECT id,substr(title,1,500) AS title,source_id AS sourceId FROM documents WHERE id=?")
      .get(documentId);
    return document ? { ...document, kind: "source" as const } : null;
  }
  const node = getKnowledgeNode(db, id);
  return node ? { id: node.id, kind: node.kind, title: node.title.slice(0, 500) } : null;
}

function view(
  db: Database.Database,
  row: DecisionRow,
  association: "recorded" | "historical-matched" | "unassociated",
) {
  const { schedulingJson, ...metadata } = row;
  const subjectRef = readDecisionSubjectRef(db, row.nodeId);
  return {
    ...metadata,
    scheduling: schedulingJson ? (JSON.parse(schedulingJson) as unknown) : null,
    inputInspection: true,
    nodeId: subjectRef ? row.nodeId : null,
    subjectRef,
    kind: "knowledge" as const,
    scoreScale: "normalized-0-1" as const,
    association,
    // This is the score's recommendation, not proof the engine skipped work:
    // obligations can appear while a model judgement is in flight.
    recommendation:
      row.threshold === null
        ? null
        : row.score === null
          ? ("unavailable" as const)
          : row.score < row.threshold
            ? ("skip" as const)
            : ("inspect" as const),
  };
}

/** Bounded, metadata-only run audit. Legacy discovery association is read-only and conservative. */
export function listKnowledgeDecisionsForRun(db: Database.Database, runId: string) {
  return db.transaction(() => readRunDecisions(db, runId))();
}

function readRunDecisions(db: Database.Database, runId: string) {
  const hasWork = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_work'")
    .get();
  const associationFilter = hasWork
    ? "run_id=@runId OR work_id IN (SELECT w.id FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id WHERE b.run_id=@runId)"
    : "run_id=@runId";
  const recorded = db
    .prepare<{ runId: string }, DecisionRow>(
      `SELECT ${projection} FROM knowledge_decisions WHERE ${associationFilter} ORDER BY created_at,id LIMIT 501`,
    )
    .all({ runId })
    .map((row) => view(db, row, "recorded"));
  let truncated = recorded.length > 500;
  let legacyIncomplete = false;
  const result = () => ({ items: recorded.slice(0, 500), truncated, legacyIncomplete });
  const run = db
    .prepare<
      [string],
      { started: number | null; finished: number | null }
    >("SELECT last_attempt_at AS started,completed_at AS finished FROM cognition_runs WHERE id=?")
    .get(runId);
  // An ongoing or retried legacy attempt cannot be bounded accurately here.
  if (run?.started == null || run.finished == null) {
    legacyIncomplete = !!db
      .prepare("SELECT 1 FROM knowledge_decisions WHERE run_id IS NULL AND work_id IS NULL LIMIT 1")
      .get();
    return result();
  }
  const sources = db
    .prepare<
      [string],
      {
        batchId: string;
        nodeId: string;
        versions: string;
        id: string;
        contentHash: string;
        title: string;
        content: string;
        sourceCreatedAt: string;
        sourceUpdatedAt: string;
      }
    >(
      `SELECT b.id AS batchId,f.node_id AS nodeId,f.input_versions_json AS versions,
    d.id,d.content_hash AS contentHash,d.title,d.content,
    d.source_created_at AS sourceCreatedAt,d.source_updated_at AS sourceUpdatedAt
    FROM knowledge_batches b JOIN knowledge_frontier f ON f.batch_id=b.id
    JOIN documents d ON f.node_id='source:'||d.id WHERE b.run_id=? AND length(d.content)<=24000 LIMIT 51`,
    )
    .all(runId);
  if (sources.length > 50) {
    legacyIncomplete = true;
    return result();
  }
  // The original state omitted document ID: identical source contents from
  // different IDs can share its hash. Inspect every overlapping source owner,
  // not only copies of the requested node, before inferring an association.
  const candidates = db
    .prepare<
      [number, number],
      {
        runId: string;
        batchId: string;
        nodeId: string;
        versions: string;
        started: number;
        finished: number;
        id: string;
        contentHash: string;
        title: string;
        content: string;
        sourceCreatedAt: string;
        sourceUpdatedAt: string;
      }
    >(
      `SELECT b.run_id AS runId,b.id AS batchId,f.node_id AS nodeId,f.input_versions_json AS versions,
    r.last_attempt_at AS started,COALESCE(r.completed_at,253402300799999) AS finished,d.id,d.content_hash AS contentHash,
    d.title,substr(d.content,1,24001) AS content,d.source_created_at AS sourceCreatedAt,d.source_updated_at AS sourceUpdatedAt
    FROM knowledge_batches b JOIN knowledge_frontier f ON f.batch_id=b.id
    JOIN cognition_runs r ON r.id=b.run_id LEFT JOIN documents d ON f.node_id='source:'||d.id
    WHERE f.node_id LIKE 'source:%' AND r.last_attempt_at<=? AND COALESCE(r.completed_at,253402300799999)>=? LIMIT 51`,
    )
    .all(run.finished, run.started);
  if (candidates.length > 50) {
    legacyIncomplete = true;
    return result();
  }
  const ownersByInterval = candidates.map((candidate) => {
    let current = false;
    try {
      current =
        typeof candidate.contentHash === "string" &&
        JSON.parse(candidate.versions)[candidate.nodeId] === candidate.contentHash;
    } catch {
      /* unknown legacy version */
    }
    // The v3 engine bypassed discovery judgement for sources over 24k
    // characters. An unchanged oversized source is provably not the owner
    // of a v3 discovery event; changed or hidden content remains unknown.
    const readableCurrent = current && isKnowledgeEvidenceReadable(db, candidate.id);
    const fingerprint = readableCurrent
      ? candidate.content.length > 24000
        ? undefined
        : knowledgeHash({
            source: {
              title: candidate.title,
              content: candidate.content,
              sourceCreatedAt: candidate.sourceCreatedAt,
              sourceUpdatedAt: candidate.sourceUpdatedAt,
            },
          })
      : null;
    return { ...candidate, fingerprint };
  });
  const matched = new Map<string, ReturnType<typeof view>>();
  for (const source of sources) {
    if (!isKnowledgeEvidenceReadable(db, source.id)) {
      legacyIncomplete = true;
      continue;
    }
    let versions: Record<string, unknown>;
    try {
      versions = JSON.parse(source.versions);
    } catch {
      continue;
    }
    if (versions[source.nodeId] !== source.contentHash) {
      legacyIncomplete = true;
      continue;
    }
    const fingerprint = knowledgeHash({
      source: {
        title: source.title,
        content: source.content,
        sourceCreatedAt: source.sourceCreatedAt,
        sourceUpdatedAt: source.sourceUpdatedAt,
      },
    });
    const decisions = db
      .prepare<[string, number, number], DecisionRow>(
        `SELECT ${projection} FROM knowledge_decisions WHERE run_id IS NULL AND purpose='discovery'
       AND rubric_version='knowledge-discovery-value-v3' AND input_fingerprint=?
       AND created_at BETWEEN ? AND ? ORDER BY created_at,id LIMIT 51`,
      )
      .all(fingerprint, run.started, run.finished);
    if (decisions.length > 50) {
      legacyIncomplete = true;
      continue;
    }
    for (const decision of decisions) {
      // Reject overlapping eligible batches, including a second copy of this
      // source in another run. Time proximity alone never establishes identity.
      const eligible = ownersByInterval.filter(
        (owner) => owner.started <= decision.createdAt && owner.finished >= decision.createdAt,
      );
      const owners = eligible.filter((owner) => owner.fingerprint === decision.inputFingerprint);
      if (eligible.some((owner) => owner.fingerprint === null)) {
        legacyIncomplete = true;
        continue;
      }
      if (
        owners.length !== 1 ||
        owners[0]!.runId !== runId ||
        owners[0]!.batchId !== source.batchId
      ) {
        legacyIncomplete = true;
        continue;
      }
      matched.set(
        decision.id,
        view(
          db,
          { ...decision, runId, batchId: source.batchId, nodeId: source.nodeId, threshold: 0.25 },
          "historical-matched",
        ),
      );
    }
  }
  const items = [...recorded, ...matched.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  truncated ||= items.length > 500;
  // Older purposes/rubrics and ambiguous identity are intentionally not inferred.
  const unassociated = db
    .prepare<
      [number, number],
      { id: string }
    >("SELECT id FROM knowledge_decisions WHERE run_id IS NULL AND work_id IS NULL AND created_at BETWEEN ? AND ? LIMIT 501")
    .all(run.started, run.finished);
  legacyIncomplete ||=
    unassociated.length > 500 || unassociated.some((row) => !matched.has(row.id));
  return { items: items.slice(0, 500), truncated, legacyIncomplete };
}

/** Global metadata view uses the same identity privacy filtering as run details. */
export function listKnowledgeDecisionAudit(db: Database.Database, limit: number) {
  return db.transaction(() =>
    db
      .prepare<[number], DecisionRow>(
        `SELECT ${projection} FROM knowledge_decisions ORDER BY created_at DESC,id LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map((row) => view(db, row, row.runId || row.workId ? "recorded" : "unassociated")),
  )();
}

export interface KnowledgeDecisionAuditOptions {
  purpose?: KnowledgeDecisionPurpose | "worth-gate" | "record-check";
  cursor?: string;
  limit?: number;
}

interface LegacyAuditRow {
  id: string;
  purpose: "worth-gate" | "record-check";
  score: number | null;
  threshold: number;
  runId: string;
  modelId: string | null;
  rubricVersion: string;
  createdAt: number;
  latencyMs: number | null;
  inputTokens: number | null;
  documentId: string;
  subjectDocumentId: string;
  verdict: string;
  enforced: number;
  reusedFrom: string | null;
}
const legacyProjection = `id,purpose,score,threshold,run_id AS runId,model_id AS modelId,rubric_version AS rubricVersion,
  created_at AS createdAt,latency_ms AS latencyMs,input_tokens AS inputTokens,document_id AS documentId,
  subject_document_id AS subjectDocumentId,verdict,enforced,reused_from AS reusedFrom`;
function legacyAuditView(db: Database.Database, row: LegacyAuditRow) {
  const { documentId, subjectDocumentId, ...metadata } = row;
  const readable = areDecisionSourcesReadable(db, { documentId, subjectDocumentId });
  return {
    ...metadata,
    kind: "legacy" as const,
    scoreScale: "ordinal-0-3" as const,
    subjectDocumentId: readable ? subjectDocumentId : null,
    subjectRef: readable ? readDecisionSubjectRef(db, `source:${subjectDocumentId}`) : null,
    runAvailable: !!db.prepare("SELECT 1 FROM cognition_runs WHERE id=?").get(row.runId),
    enforced: !!row.enforced,
    inputInspection: true,
  };
}

/** Bounded metadata from both ledgers; payloads are never part of a page query. */
export function listKnowledgeDecisionAuditPage(
  db: Database.Database,
  options: KnowledgeDecisionAuditOptions = {},
) {
  return db.transaction(() => {
    if (options.cursor && options.cursor.length > 2048)
      throw new BadRequestError("Invalid pagination cursor");
    const purpose = options.purpose ?? null;
    const cursor = decodePageCursor(options.cursor, "knowledge-decision-audit", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      return value.purpose === purpose &&
        (value.kind === "knowledge" || value.kind === "legacy") &&
        typeof value.id === "string" &&
        value.id.length <= 256 &&
        typeof value.at === "number" &&
        Number.isSafeInteger(value.at)
        ? { id: value.id, at: value.at, kind: value.kind }
        : null;
    });
    const limit = Math.max(1, Math.min(100, options.limit ?? 30));
    const predicate = (kind: "knowledge" | "legacy") => {
      const clauses: string[] = [],
        values: Record<string, string | number> = { limit: limit + 1 };
      if (purpose) {
        clauses.push("purpose=@purpose");
        values.purpose = purpose;
      }
      if (cursor) {
        clauses.push(
          "(created_at<@at OR (created_at=@at AND (@kind>@cursorKind OR (@kind=@cursorKind AND id>@id))))",
        );
        Object.assign(values, { at: cursor.at, id: cursor.id, kind, cursorKind: cursor.kind });
      }
      return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
    };
    const knowledge = predicate("knowledge"),
      legacy = predicate("legacy");
    const knowledgeRows =
      !purpose || !["worth-gate", "record-check"].includes(purpose)
        ? db
            .prepare<
              Record<string, string | number>,
              DecisionRow
            >(`SELECT ${projection} FROM knowledge_decisions ${knowledge.where} ORDER BY created_at DESC,id LIMIT @limit`)
            .all(knowledge.values)
        : [];
    const hasLegacy = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cognition_decisions'")
      .get();
    const legacyRows =
      hasLegacy && (!purpose || ["worth-gate", "record-check"].includes(purpose))
        ? db
            .prepare<
              Record<string, string | number>,
              LegacyAuditRow
            >(`SELECT ${legacyProjection} FROM cognition_decisions ${legacy.where} ORDER BY created_at DESC,id LIMIT @limit`)
            .all(legacy.values)
        : [];
    const rows = [
      ...knowledgeRows.map((row) => ({ kind: "knowledge" as const, row })),
      ...legacyRows.map((row) => ({ kind: "legacy" as const, row })),
    ].sort(
      (a, b) =>
        b.row.createdAt - a.row.createdAt ||
        (a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : a.row.id < b.row.id
              ? -1
              : a.row.id > b.row.id
                ? 1
                : 0),
    );
    const page = rows.slice(0, limit),
      last = page.at(-1),
      hasMore = rows.length > limit;
    return {
      items: page.map((entry) =>
        entry.kind === "legacy"
          ? legacyAuditView(db, entry.row)
          : {
              ...view(
                db,
                entry.row,
                entry.row.runId || entry.row.workId ? "recorded" : "unassociated",
              ),
              runAvailable:
                !!entry.row.runId &&
                !!db.prepare("SELECT 1 FROM cognition_runs WHERE id=?").get(entry.row.runId),
            },
      ),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodePageCursor("knowledge-decision-audit", {
              purpose,
              kind: last.kind,
              id: last.row.id,
              at: last.row.createdAt,
            })
          : null,
    };
  })();
}

/** Batch scheduling is linked through actual coalesced work, never guessed from timestamps. */
export function listKnowledgeDecisionsForBatch(db: Database.Database, batchId: string) {
  return db.transaction(() => {
    const rows = db
      .prepare<
        [string, string],
        DecisionRow
      >(`SELECT ${projection} FROM knowledge_decisions WHERE batch_id=? OR work_id IN (SELECT id FROM knowledge_work WHERE batch_id=?) ORDER BY created_at,id LIMIT 101`)
      .all(batchId, batchId);
    return {
      items: rows.slice(0, 100).map((row) => view(db, row, "recorded")),
      truncated: rows.length > 100,
    };
  })();
}
/** Sensitive exact snapshots are served only by the explicit admin detail endpoint. */
export function readKnowledgeDecisionAudit(db: Database.Database, id: string) {
  return db.transaction(() => {
    const row = db
      .prepare<[string], DecisionRow>(`SELECT ${projection} FROM knowledge_decisions WHERE id=?`)
      .get(id);
    if (!row) throw new NotFoundError("Knowledge decision not found");
    return {
      ...view(db, row, row.workId || row.runId ? "recorded" : "unassociated"),
      input: readKnowledgeDecisionDebug(db, id),
    };
  })();
}

/** Review context comes only from explicitly recorded node identity, never timing proximity. */
export function listKnowledgeDecisionsForNode(db: Database.Database, nodeId: string) {
  return db.transaction(() => {
    if (!getKnowledgeNode(db, nodeId)) throw new NotFoundError("Knowledge node not found");
    const rows = db
      .prepare<
        [string],
        DecisionRow
      >(`SELECT ${projection} FROM knowledge_decisions WHERE node_id=? AND purpose IN ('review','urgency') ORDER BY created_at DESC,id LIMIT 51`)
      .all(nodeId);
    return {
      items: rows
        .slice(0, 50)
        .map((row) => view(db, row, row.runId || row.workId ? "recorded" : "unassociated")),
      truncated: rows.length > 50,
    };
  })();
}

/** Work association is an explicit recorded key; no same-node inference. */
export function listKnowledgeDecisionsForWork(db: Database.Database, workId: string) {
  const rows = db
    .prepare<
      [string],
      DecisionRow
    >(`SELECT ${projection} FROM knowledge_decisions WHERE work_id=? ORDER BY created_at DESC,id LIMIT 21`)
    .all(workId);
  return {
    items: rows.slice(0, 20).map((row) => view(db, row, "recorded")),
    truncated: rows.length > 20,
  };
}
