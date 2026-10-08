// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { cognitionSpendDay } from "../storage/spend.js";
import { snapshotClaimMaintenance, settleClaimMaintenance } from "./claim-maintenance.js";
import { assertKnowledgeRunFence } from "./run-fence.js";
import { recordKnowledgeCoverage, type KnowledgeCoverageInput } from "./discovery.js";
import { sourceHasDiscoveryObligation } from "./discovery-gate.js";
import { assertKnowledgeDiscoveryComplete } from "./discovery-completion.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";
import type { MaintenanceTier } from "./planner.js";

export type KnowledgeWorkReason = "change" | "discovery" | "review" | "root" | "upgrade";
export interface EnqueueKnowledgeWork {
  id: string;
  subjectId: string;
  subjectKind: "source" | "node";
  reason: KnowledgeWorkReason;
  inputRevision: string;
  tier: MaintenanceTier;
  dueAt: number;
  readinessReason?: "pending_content" | "derivation";
}
export interface KnowledgeWork extends EnqueueKnowledgeWork {
  inputChangedAt: number;
  generation: number;
  createdAt: number;
  updatedAt: number;
  status: "pending" | "batched" | "completed" | "deferred";
  batchId: string | null;
  attempts: number;
  lastError?: string | null;
}

const projection = `id, subject_id AS subjectId, subject_kind AS subjectKind, reason,
  input_revision AS inputRevision, input_changed_at AS inputChangedAt,generation, tier, due_at AS dueAt, created_at AS createdAt,
  updated_at AS updatedAt, status, batch_id AS batchId, attempts,last_error AS lastError`;
const ranks: Record<MaintenanceTier, number> = { immediate: 0, soon: 1, routine: 2 };

export function getKnowledgeWork(db: Database.Database, id: string): KnowledgeWork | null {
  return (
    db
      .prepare<[string], KnowledgeWork>(`SELECT ${projection} FROM knowledge_work WHERE id=?`)
      .get(id) ?? null
  );
}

/** Never let delayed event delivery fold an obsolete version over current work. */
function assertCurrentWorkRevision(db: Database.Database, input: EnqueueKnowledgeWork): void {
  if (input.subjectKind === "source") {
    const live = db
      .prepare<[string], { content_hash: string }>("SELECT content_hash FROM documents WHERE id=?")
      .get(input.subjectId);
    const tombstone = db
      .prepare<
        [string],
        { deleted: number }
      >("SELECT deleted FROM knowledge_source_revisions WHERE document_id=?")
      .get(input.subjectId);
    if (!live && !tombstone?.deleted)
      throw new KnowledgeStorageError("reference_invalid", "Work source does not exist");
    const current = live?.content_hash ?? "deleted";
    if (current !== input.inputRevision)
      throw new KnowledgeStorageError("revision_conflict", "Source work revision is obsolete");
  } else {
    const node = db
      .prepare<[string], { revision: number }>("SELECT revision FROM knowledge_nodes WHERE id=?")
      .get(input.subjectId);
    if (!node) throw new KnowledgeStorageError("reference_invalid", "Work node does not exist");
    if (String(node.revision) !== input.inputRevision)
      throw new KnowledgeStorageError("revision_conflict", "Node work revision is obsolete");
  }
}

/** Pending folds preserve the earliest deadline; already batched work receives a separate successor. */
export function enqueueKnowledgeWork(
  db: Database.Database,
  input: EnqueueKnowledgeWork,
  now: number,
  retryOf?: string,
): KnowledgeWork {
  return db.transaction(() => {
    assertCurrentWorkRevision(db, input);
    if (retryOf) {
      const previous = getKnowledgeWork(db, retryOf);
      if (
        !previous ||
        previous.subjectId !== input.subjectId ||
        previous.subjectKind !== input.subjectKind ||
        previous.reason !== input.reason ||
        previous.status !== "deferred"
      )
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Historical retry does not name its deferred predecessor",
        );
    }
    const pending = db
      .prepare<
        [string, string, string],
        KnowledgeWork
      >(`SELECT ${projection} FROM knowledge_work WHERE subject_kind=? AND subject_id=? AND reason=? AND status='pending'`)
      .get(input.subjectKind, input.subjectId, input.reason);
    if (pending) {
      const tier = ranks[input.tier] < ranks[pending.tier] ? input.tier : pending.tier;
      const generation =
        pending.generation + (pending.inputRevision === input.inputRevision ? 0 : 1);
      db.prepare(
        `UPDATE knowledge_work SET input_revision=?,input_changed_at=?,generation=?,tier=?,due_at=?,updated_at=?,last_error=? WHERE id=?`,
      ).run(
        input.inputRevision,
        pending.inputRevision === input.inputRevision ? pending.inputChangedAt : now,
        generation,
        tier,
        Math.min(pending.dueAt, input.dueAt),
        now,
        input.readinessReason ?? null,
        pending.id,
      );
      return getKnowledgeWork(db, pending.id)!;
    }
    const sameId = getKnowledgeWork(db, input.id);
    if (sameId) {
      if (
        sameId.subjectId !== input.subjectId ||
        sameId.subjectKind !== input.subjectKind ||
        sameId.inputRevision !== input.inputRevision ||
        sameId.reason !== input.reason
      ) {
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Work identity was reused for different inputs",
        );
      }
      return sameId;
    }
    db.prepare(
      `INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,last_error)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`,
    ).run(
      input.id,
      input.subjectId,
      input.subjectKind,
      input.reason,
      input.inputRevision,
      now,
      input.tier,
      input.dueAt,
      now,
      now,
      input.readinessReason ?? null,
    );
    if (
      !retryOf &&
      input.subjectKind === "source" &&
      ["discovery", "upgrade"].includes(input.reason)
    ) {
      db.prepare(
        "INSERT INTO knowledge_historical_admissions(day,count) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET count=count+1",
      ).run(cognitionSpendDay(now));
    }
    return getKnowledgeWork(db, input.id)!;
  })();
}

/** Identity-free counters survive corpus erasure; deleting evidence never refunds consent limits. */
export function historicalKnowledgeAdmissions(
  db: Database.Database,
  now: number,
): { total: number; today: number } {
  return db
    .prepare<
      [string],
      { total: number; today: number }
    >("SELECT COALESCE(SUM(count),0) AS total,COALESCE(SUM(CASE WHEN day=? THEN count ELSE 0 END),0) AS today FROM knowledge_historical_admissions")
    .get(cognitionSpendDay(now))!;
}

/** Includes future pending work so urgent overlap can be coalesced before claiming. */
export function listPendingKnowledgeWorkWindow(
  db: Database.Database,
  limit: number,
): { items: KnowledgeWork[]; hasMore: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Pending work limit must be positive");
  const rows = db
    .prepare<
      [number],
      KnowledgeWork
    >(`SELECT ${projection} FROM knowledge_work WHERE status='pending' ORDER BY due_at,created_at,id LIMIT ?`)
    .all(limit + 1);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Reserve one planning slot for historical work, even during continuous live intake. */
export function listKnowledgePlanningWork(db: Database.Database, limit: number): KnowledgeWork[] {
  const ordinary = listPendingKnowledgeWork(db, limit);
  const historical = db
    .prepare<[], KnowledgeWork>(
      `SELECT ${projection} FROM knowledge_work WHERE status='pending'
     AND reason IN ('discovery','upgrade') ORDER BY due_at,created_at,id LIMIT 1`,
    )
    .get();
  if (!historical || ordinary.some((item) => item.id === historical.id)) return ordinary;
  return [...ordinary.slice(0, Math.max(0, limit - 1)), historical].sort(
    (a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/** Bounded admission window; use the window form when planning complete overlap regions. */
export function listPendingKnowledgeWork(db: Database.Database, limit: number): KnowledgeWork[] {
  return listPendingKnowledgeWorkWindow(db, limit).items;
}

export interface KnowledgeFrontierInput {
  /** Carry only unfinished claims when a partial page save creates a successor input. */
  eligibleClaimIds?: readonly string[];
  nodeId: string;
  inputFingerprint: string;
  inputVersions: Record<string, string | number>;
  depth: number;
}
export interface KnowledgeFrontierItem extends KnowledgeFrontierInput {
  batchId: string;
  status: "pending" | "offered" | "skipped" | "unchanged" | "changed" | "deferred";
  resultRevision: number | null;
  attempts: number;
}
interface FrontierRow extends Omit<KnowledgeFrontierItem, "inputVersions"> {
  inputVersionsJson: string;
}

export function listKnowledgeFrontier(
  db: Database.Database,
  batchId: string,
): KnowledgeFrontierItem[] {
  return db
    .prepare<[string], FrontierRow>(
      `SELECT batch_id AS batchId,node_id AS nodeId,input_fingerprint AS inputFingerprint,
    input_versions_json AS inputVersionsJson,depth,status,result_revision AS resultRevision,attempts
    FROM knowledge_frontier WHERE batch_id=? ORDER BY depth,node_id,input_fingerprint`,
    )
    .all(batchId)
    .map(({ inputVersionsJson, ...row }) => ({
      ...row,
      inputVersions: JSON.parse(inputVersionsJson) as Record<string, string | number>,
    }));
}

export interface CreateKnowledgeBatch {
  id: string;
  runId: string;
  tier: MaintenanceTier;
  work: { id: string; generation: number; inputRevision: string }[];
  frontier: KnowledgeFrontierInput[];
  /** Complete potential region, excluding aggregate barriers such as the root wiki. */
  regionNodeIds: string[];
}

function batchFingerprint(input: CreateKnowledgeBatch): string {
  const stable = {
    runId: input.runId,
    tier: input.tier,
    regionNodeIds: [...new Set(input.regionNodeIds)].sort(),
    work: input.work
      .map((item) => ({
        id: item.id,
        generation: item.generation,
        inputRevision: item.inputRevision,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    frontier: input.frontier
      .map((item) => ({
        nodeId: item.nodeId,
        inputFingerprint: item.inputFingerprint,
        depth: item.depth,
        inputVersions: Object.fromEntries(
          Object.entries(item.inputVersions).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }))
      .sort(
        (a, b) =>
          a.nodeId.localeCompare(b.nodeId) || a.inputFingerprint.localeCompare(b.inputFingerprint),
      ),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** Call within the same writer transaction as cognition-run enqueueing. */
export function createKnowledgeBatch(
  db: Database.Database,
  input: CreateKnowledgeBatch,
  now: number,
): void {
  db.transaction(() => {
    const fingerprint = batchFingerprint(input);
    const existing = db
      .prepare<
        [string],
        { creation_fingerprint: string }
      >("SELECT creation_fingerprint FROM knowledge_batches WHERE id=?")
      .get(input.id);
    if (existing) {
      if (existing.creation_fingerprint !== fingerprint)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Batch identity was reused for different inputs",
        );
      return;
    }
    if (!input.work.length || new Set(input.work.map((item) => item.id)).size !== input.work.length)
      throw new KnowledgeStorageError("reference_invalid", "Batch requires distinct work seeds");
    for (const expected of input.work) {
      const work = getKnowledgeWork(db, expected.id);
      if (
        !work ||
        work.status !== "pending" ||
        work.generation !== expected.generation ||
        work.inputRevision !== expected.inputRevision
      ) {
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Maintenance inputs changed during batch planning",
        );
      }
      assertCurrentWorkRevision(db, work);
      const key = work.subjectKind === "source" ? `source:${work.subjectId}` : work.subjectId;
      if (
        !input.frontier.some(
          (item) =>
            item.nodeId === key &&
            item.depth === 0 &&
            (work.subjectKind !== "source" ||
              String(item.inputVersions[key]) === work.inputRevision),
        )
      )
        throw new KnowledgeStorageError(
          "reference_invalid",
          "Every work seed requires a matching initial frontier obligation",
        );
    }
    db.prepare(
      `INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)`,
    ).run(input.id, input.runId, fingerprint, input.tier, now, now);
    const mark = db.prepare(
      "UPDATE knowledge_work SET status='batched',batch_id=?,attempts=attempts+1,updated_at=? WHERE id=?",
    );
    for (const expected of input.work) mark.run(input.id, now, expected.id);
    reserveKnowledgeRegion(db, input.id, input.regionNodeIds);
    appendKnowledgeFrontier(db, input.id, input.frontier);
  })();
}

/** Called only inside a writer transaction. Deferred batches retain their reservation. */
function reserveKnowledgeRegion(
  db: Database.Database,
  batchId: string,
  nodeIds: readonly string[],
): void {
  const conflict = db.prepare<
    [string, string],
    { batch_id: string }
  >(`SELECT r.batch_id FROM knowledge_batch_regions r
    JOIN knowledge_batches b ON b.id=r.batch_id WHERE r.node_id=? AND r.batch_id!=? AND b.status NOT IN ('completed','abandoned') LIMIT 1`);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO knowledge_batch_regions(batch_id,node_id) VALUES(?,?)",
  );
  for (const nodeId of new Set(nodeIds)) {
    if (conflict.get(nodeId, batchId))
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Maintenance region overlaps an active batch",
      );
    insert.run(batchId, nodeId);
  }
}

export function appendKnowledgeFrontier(
  db: Database.Database,
  batchId: string,
  items: readonly KnowledgeFrontierInput[],
): void {
  db.transaction(() => {
    const batch = db
      .prepare<[string], { status: string }>("SELECT status FROM knowledge_batches WHERE id=?")
      .get(batchId);
    if (!batch || ["completed", "abandoned"].includes(batch.status))
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Cannot append to a missing or completed batch",
      );
    reserveKnowledgeRegion(
      db,
      batchId,
      items.map((item) => item.nodeId),
    );
    const insert =
      db.prepare(`INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status)
      VALUES(?,?,?,?,?,'pending') ON CONFLICT(batch_id,node_id,input_fingerprint) DO NOTHING`);
    for (const item of items) {
      if (
        !Number.isSafeInteger(item.depth) ||
        item.depth < 0 ||
        !item.inputFingerprint ||
        !item.nodeId
      )
        throw new KnowledgeStorageError("reference_invalid", "Invalid frontier identity or depth");
      const serialized = JSON.stringify(
        Object.fromEntries(
          Object.entries(item.inputVersions).sort(([a], [b]) => a.localeCompare(b)),
        ),
      );
      const existing = db
        .prepare<
          [string, string, string],
          { input_versions_json: string }
        >("SELECT input_versions_json FROM knowledge_frontier WHERE batch_id=? AND node_id=? AND input_fingerprint=?")
        .get(batchId, item.nodeId, item.inputFingerprint);
      if (existing && existing.input_versions_json !== serialized)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Frontier fingerprint was reused for different inputs",
        );
      insert.run(batchId, item.nodeId, item.inputFingerprint, serialized, item.depth);
      snapshotClaimMaintenance(
        db,
        { batchId, nodeId: item.nodeId, inputFingerprint: item.inputFingerprint },
        item.eligibleClaimIds,
      );
    }
  })();
}

export interface SetKnowledgeFrontierOutcome {
  batchId: string;
  /** Trusted caller ownership; omitted only by internal legacy/test leaves. */
  runId?: string;
  nodeId: string;
  inputFingerprint: string;
  status: KnowledgeFrontierItem["status"];
  resultRevision?: number;
}

/** The service supplies outcomes only after gating or validating the accepted mutation. */
export function setKnowledgeFrontierOutcome(
  db: Database.Database,
  input: SetKnowledgeFrontierOutcome,
  now: number,
): void {
  db.transaction(() => {
    if (input.runId) assertKnowledgeRunFence(db, { batchId: input.batchId, runId: input.runId });
    const active = db
      .prepare(
        "SELECT 1 FROM knowledge_batches WHERE id=? AND status NOT IN ('completed','abandoned')",
      )
      .get(input.batchId);
    if (!active)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Maintenance batch is missing or completed",
      );
    settleClaimMaintenance(db, input);
    const result = db
      .prepare(
        `UPDATE knowledge_frontier SET status=?,result_revision=?,attempts=attempts+1
      WHERE batch_id=? AND node_id=? AND input_fingerprint=? AND status IN ('pending','offered','deferred')`,
      )
      .run(
        input.status,
        input.resultRevision ?? null,
        input.batchId,
        input.nodeId,
        input.inputFingerprint,
      );
    if (result.changes !== 1)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Frontier input already settled or missing",
      );
    db.prepare(
      "UPDATE knowledge_batches SET status='running',revision=revision+1,updated_at=? WHERE id=?",
    ).run(now, input.batchId);
  })();
}

export interface SettleKnowledgeFrontierInput {
  outcome: SetKnowledgeFrontierOutcome;
  append: readonly KnowledgeFrontierInput[];
  coverage?: readonly KnowledgeCoverageInput[];
  /** Trusted source-completion obligation; checked against coverage in this commit. */
  requiredDiscovery?: { subjectId: string; inputRevision: string };
  regionNodeIds?: readonly string[];
}

/** Settlement and expansion share one commit; completion can never observe the gap. */
export function settleKnowledgeFrontier(
  db: Database.Database,
  input: SettleKnowledgeFrontierInput,
  now: number,
): void {
  db.transaction(() => {
    for (const coverage of input.coverage ?? []) {
      if (coverage.status !== "gated") continue;
      if (
        input.outcome.nodeId !== `source:${coverage.subjectId}` ||
        input.requiredDiscovery?.subjectId !== coverage.subjectId ||
        input.requiredDiscovery.inputRevision !== coverage.inputRevision
      )
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Gated coverage requires its exact source completion obligation",
        );
      const review = db
        .prepare(
          `SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review' LIMIT 1`,
        )
        .get(input.outcome.batchId, coverage.subjectId);
      if (review || sourceHasDiscoveryObligation(db, coverage.subjectId))
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Source gained a reconciliation obligation before the gate settled; inspect the current frontier",
        );
    }
    reserveKnowledgeRegion(db, input.outcome.batchId, input.regionNodeIds ?? []);
    for (const coverage of input.coverage ?? []) recordKnowledgeCoverage(db, coverage, now);
    if (input.requiredDiscovery)
      assertKnowledgeDiscoveryComplete(
        db,
        input.requiredDiscovery.subjectId,
        input.requiredDiscovery.inputRevision,
        [],
        now,
      );
    setKnowledgeFrontierOutcome(db, input.outcome, now);
    appendKnowledgeFrontier(db, input.outcome.batchId, input.append);
    // A verified review is useful even when accepted meaning is unchanged.
    // This trusted timestamp records examination, not a new entailment proof.
    if (
      input.outcome.resultRevision !== undefined &&
      ["changed", "unchanged"].includes(input.outcome.status)
    ) {
      db.prepare(
        `UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.lastReviewedAt',?,
          '$.nextReviewAt',CASE WHEN json_extract(metadata_json,'$.nextReviewAt')<=? THEN NULL ELSE json_extract(metadata_json,'$.nextReviewAt') END)
        WHERE id=? AND revision=? AND validity='current'
        AND EXISTS(SELECT 1 FROM knowledge_claims c WHERE c.node_id=knowledge_nodes.id)
        AND NOT EXISTS(SELECT 1 FROM knowledge_claims c WHERE c.node_id=knowledge_nodes.id AND c.verification!='verified')
        AND EXISTS(SELECT 1 FROM knowledge_work w WHERE w.batch_id=? AND w.subject_kind='node'
          AND w.subject_id=knowledge_nodes.id AND w.reason='review' AND w.status='batched')`,
      ).run(now, now, input.outcome.nodeId, input.outcome.resultRevision, input.outcome.batchId);
    }
  })();
}

/** Completion is computed by the engine; a model cannot declare unprocessed work complete. */
export function finishKnowledgeBatch(
  db: Database.Database,
  batchId: string,
  now: number,
  runId?: string,
): boolean {
  return db.transaction(() => {
    const pending = db
      .prepare(
        "SELECT 1 FROM knowledge_frontier WHERE batch_id=? AND status IN ('pending','offered','deferred') LIMIT 1",
      )
      .get(batchId);
    if (pending) return false;
    // Cohort metadata may have been erased by privacy cleanup while a frontier
    // call awaited another writer slice. A missing decision must never settle it.
    const required = db
      .prepare<[string], { id: string | null }>(
        `SELECT json_extract(r.payload_json,'$.organizationCohortId') AS id
      FROM knowledge_batches b JOIN cognition_runs r ON r.id=b.run_id WHERE b.id=?`,
      )
      .get(batchId);
    if (
      required?.id &&
      !db
        .prepare(
          "SELECT 1 FROM knowledge_organization_cohorts WHERE id=? AND batch_id=? AND status IN ('completed','deferred')",
        )
        .get(required.id, batchId)
    )
      return false;
    if (
      db
        .prepare(
          "SELECT 1 FROM knowledge_organization_cohorts WHERE batch_id=? AND status='pending'",
        )
        .get(batchId)
    )
      return false;
    const batch = db
      .prepare<[string], { status: string }>("SELECT status FROM knowledge_batches WHERE id=?")
      .get(batchId);
    if (!batch)
      throw new KnowledgeStorageError("reference_invalid", "Maintenance batch does not exist");
    if (runId) {
      const owner = db
        .prepare("SELECT 1 FROM knowledge_batches WHERE id=? AND run_id=?")
        .get(batchId, runId);
      if (!owner)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Maintenance batch belongs to another run",
        );
    }
    if (batch.status === "completed") return true;
    if (batch.status === "abandoned")
      throw new KnowledgeStorageError("revision_conflict", "Batch was abandoned");
    if (!db.prepare("SELECT 1 FROM knowledge_frontier WHERE batch_id=? LIMIT 1").get(batchId))
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Cannot complete a batch without seed obligations",
      );
    db.prepare(
      "UPDATE knowledge_batches SET status='completed',finished_at=?,updated_at=?,revision=revision+1 WHERE id=?",
    ).run(now, now, batchId);
    db.prepare(
      "UPDATE knowledge_work SET status='completed',updated_at=? WHERE batch_id=? AND status='batched'",
    ).run(now, batchId);
    return true;
  })();
}

/** Priority inheritance changes neither reservations nor a run's retry deadline. */
export function promoteBlockingKnowledgeBatches(
  db: Database.Database,
  input: { work: CreateKnowledgeBatch["work"][number]; regionNodeIds: string[] },
  now: number,
): number {
  return db.transaction(() => {
    // One real witness is sufficient; writer reads never scale with group size.
    const expected = input.work;
    const work = getKnowledgeWork(db, expected.id);
    if (
      !work ||
      work.status !== "pending" ||
      work.generation !== expected.generation ||
      work.inputRevision !== expected.inputRevision
    )
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Blocking work changed before promotion",
      );
    assertCurrentWorkRevision(db, work);
    const tier = work.tier;
    if (
      tier === "routine" ||
      work.dueAt > now ||
      ["pending_content", "derivation"].includes(work.lastError ?? "")
    )
      return 0;
    return db
      .prepare(
        `UPDATE knowledge_batches SET tier=?,updated_at=?,revision=revision+1
      WHERE status IN ('pending','running','deferred')
        AND CASE tier WHEN 'immediate' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END > ?
        AND id IN (SELECT batch_id FROM knowledge_batch_regions
          WHERE node_id IN (SELECT value FROM json_each(?)))`,
      )
      .run(tier, now, ranks[tier], JSON.stringify(input.regionNodeIds)).changes;
  })();
}

/** Adopt newly queued overlapping evidence before the next BFS offer, under the same locks. */
export function appendKnowledgeBatchWork(
  db: Database.Database,
  input: {
    batchId: string;
    work: CreateKnowledgeBatch["work"];
    frontier: KnowledgeFrontierInput[];
    regionNodeIds: string[];
  },
  now: number,
): void {
  db.transaction(() => {
    let tier: MaintenanceTier = "routine";
    for (const expected of input.work) {
      const work = getKnowledgeWork(db, expected.id);
      if (
        !work ||
        work.status !== "pending" ||
        work.generation !== expected.generation ||
        work.inputRevision !== expected.inputRevision
      )
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Overlapping work changed before adoption",
        );
      assertCurrentWorkRevision(db, work);
      if (ranks[work.tier] < ranks[tier]) tier = work.tier;
      const key = work.subjectKind === "source" ? `source:${work.subjectId}` : work.subjectId;
      if (
        !input.frontier.some(
          (item) =>
            item.nodeId === key &&
            (work.subjectKind !== "source" ||
              String(item.inputVersions[key]) === work.inputRevision),
        )
      )
        throw new KnowledgeStorageError(
          "reference_invalid",
          "Adopted work requires its own frontier obligation",
        );
    }
    db.prepare(
      `UPDATE knowledge_batches SET tier=?,updated_at=?,revision=revision+1
      WHERE id=? AND status IN ('pending','running','deferred')
        AND CASE tier WHEN 'immediate' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END > ?`,
    ).run(tier, now, input.batchId, ranks[tier]);
    reserveKnowledgeRegion(db, input.batchId, input.regionNodeIds);
    appendKnowledgeFrontier(db, input.batchId, input.frontier);
    for (const expected of input.work)
      db.prepare(
        "UPDATE knowledge_work SET status='batched',batch_id=?,attempts=attempts+1,updated_at=? WHERE id=?",
      ).run(input.batchId, now, expected.id);
  })();
}
