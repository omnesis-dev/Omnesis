// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Leaf mutations shared by the worker and in-process test gate. */
import { enqueueCognitionRun, type EnqueueCognitionRunInput } from "../storage/run-queue.js";
import {
  queueKnowledgeProjectionCleanup,
  ackKnowledgeProjectionCleanup,
} from "./mirror-storage.js";
import { admitKnowledgeOrganization } from "./organization.js";
import {
  refreshKnowledgeWork,
  recordKnowledgeDiscoveryTargets,
  abandonKnowledgeBatch,
  scheduleKnowledgeReview,
  setKnowledgeCheckpoint,
} from "./work-lifecycle.js";
import { recordKnowledgeDecision } from "./decision-storage.js";
import { advanceKnowledgeOwnerSync } from "./owner-sync.js";
import { setKnowledgeLink } from "./links.js";
import { saveOwnedKnowledgeNode, convertKnowledgeOwner } from "./owner-adapters.js";
import {
  saveKnowledgeNode,
  registerKnowledgeEvidence,
  recordKnowledgeSourceChange,
  advanceKnowledgeCascade,
  invalidateKnowledgeDependents,
  purgeKnowledgeBySource,
  ackKnowledgeChanges,
} from "./storage.js";
import {
  enqueueKnowledgeWork,
  createKnowledgeBatch,
  appendKnowledgeFrontier,
  appendKnowledgeBatchWork,
  setKnowledgeFrontierOutcome,
  settleKnowledgeFrontier,
  finishKnowledgeBatch,
  type CreateKnowledgeBatch,
} from "./work.js";
import {
  publishKnowledgeCandidate,
  recordKnowledgeCoverage,
  proposeKnowledgeCandidate,
  settleKnowledgeCandidate,
} from "./discovery.js";
import type { WriterCallFn } from "../../write-gate.js";
import type Database from "better-sqlite3";

/** Upgrade pending, never-attempted root batches without changing their due time. */
function classifyInitialRootBatches(db: Database.Database, rootId: string): void {
  db.prepare(
    `UPDATE cognition_runs SET payload_json=json_set(payload_json,'$.schedulingClass','initial-root')
    WHERE id IN (SELECT r.id FROM knowledge_work w
      JOIN knowledge_nodes n ON n.id=w.subject_id
      JOIN knowledge_batches b ON b.id=w.batch_id
      JOIN cognition_runs r ON r.id=b.run_id
      WHERE w.subject_kind='node' AND w.subject_id=? AND w.status='batched' AND r.kind='synthesis' AND r.status='pending' AND r.attempts=0
        AND json_extract(r.payload_json,'$.focus')='knowledge-maintenance'
        AND json_extract(r.payload_json,'$.schedulingClass') IS NULL
        AND n.kind='root' AND trim(n.plain_text)=''
      ORDER BY r.enqueued_at,r.id LIMIT 32)`,
  ).run(rootId);
}

function startKnowledgeBatch(
  db: Database.Database,
  input: CreateKnowledgeBatch,
  run: EnqueueCognitionRunInput,
  now: number,
): void {
  if (run.id !== input.runId || run.kind !== "synthesis" || run.dedupeKey !== undefined)
    throw new Error("Knowledge batch requires its own synthesis run identity");
  db.transaction(() => {
    const existing = db
      .prepare<[string], { run_id: string }>("SELECT run_id FROM knowledge_batches WHERE id=?")
      .get(input.id);
    createKnowledgeBatch(db, input, now);
    if (existing) {
      if (existing.run_id !== run.id) throw new Error("Knowledge batch identity conflict");
      return;
    }
    enqueueCognitionRun(db, run, now);
  })();
}

export const knowledgeWriterHandlers = {
  "knowledge.classifyInitialRootBatches": classifyInitialRootBatches,
  "knowledge.admitOrganization": admitKnowledgeOrganization,
  "knowledge.queueProjectionCleanup": queueKnowledgeProjectionCleanup,
  "knowledge.ackProjectionCleanup": ackKnowledgeProjectionCleanup,
  "knowledge.refreshWork": refreshKnowledgeWork,
  "knowledge.discoveryTargets": recordKnowledgeDiscoveryTargets,
  "knowledge.publishCandidate": publishKnowledgeCandidate,
  "knowledge.decision": recordKnowledgeDecision,
  "knowledge.link": setKnowledgeLink,
  "knowledge.syncOwners": advanceKnowledgeOwnerSync,
  "knowledge.adoptWork": appendKnowledgeBatchWork,
  "knowledge.convertOwner": convertKnowledgeOwner,
  "knowledge.saveOwned": saveOwnedKnowledgeNode,
  "knowledge.checkpoint": setKnowledgeCheckpoint,
  "knowledge.scheduleReview": scheduleKnowledgeReview,
  "knowledge.abandonBatch": abandonKnowledgeBatch,
  "knowledge.save": saveKnowledgeNode,
  "knowledge.evidence": registerKnowledgeEvidence,
  "knowledge.sourceChanged": recordKnowledgeSourceChange,
  "knowledge.advanceCascade": advanceKnowledgeCascade,
  "knowledge.invalidate": invalidateKnowledgeDependents,
  "knowledge.purge": purgeKnowledgeBySource,
  "knowledge.ackChanges": ackKnowledgeChanges,
  "knowledge.enqueue": enqueueKnowledgeWork,
  "knowledge.startBatch": startKnowledgeBatch,
  "knowledge.appendFrontier": appendKnowledgeFrontier,
  "knowledge.frontierOutcome": setKnowledgeFrontierOutcome,
  "knowledge.finishBatch": finishKnowledgeBatch,
  "knowledge.settleFrontier": settleKnowledgeFrontier,
  "knowledge.coverage": recordKnowledgeCoverage,
  "knowledge.proposeCandidate": proposeKnowledgeCandidate,
  "knowledge.settleCandidate": settleKnowledgeCandidate,
} as const;

type Handlers = typeof knowledgeWriterHandlers;
type Args<F> = F extends (db: Database.Database, ...args: infer A) => unknown ? A : never;
type Result<F> = F extends (...args: never[]) => infer R ? R : never;
export type KnowledgeWriteGate = {
  [K in keyof Handlers]: (...args: Args<Handlers[K]>) => Promise<Result<Handlers[K]>>;
};
export type KnowledgeWriterCall = <K extends keyof Handlers>(
  op: K,
  args: Args<Handlers[K]>,
) => Promise<Result<Handlers[K]>>;

export function knowledgeGateFromCall(call: WriterCallFn): KnowledgeWriteGate {
  return {
    "knowledge.admitOrganization": (...args) => call("knowledge.admitOrganization", args),
    "knowledge.queueProjectionCleanup": (...args) => call("knowledge.queueProjectionCleanup", args),
    "knowledge.ackProjectionCleanup": (...args) => call("knowledge.ackProjectionCleanup", args),
    "knowledge.refreshWork": (...args) => call("knowledge.refreshWork", args),
    "knowledge.discoveryTargets": (...args) => call("knowledge.discoveryTargets", args),
    "knowledge.publishCandidate": (...args) => call("knowledge.publishCandidate", args),
    "knowledge.decision": (...args) => call("knowledge.decision", args),
    "knowledge.link": (...args) => call("knowledge.link", args),
    "knowledge.syncOwners": (...args) => call("knowledge.syncOwners", args),
    "knowledge.adoptWork": (...args) => call("knowledge.adoptWork", args),
    "knowledge.convertOwner": (...args) => call("knowledge.convertOwner", args),
    "knowledge.saveOwned": (...args) => call("knowledge.saveOwned", args),
    "knowledge.checkpoint": (...args) => call("knowledge.checkpoint", args),
    "knowledge.scheduleReview": (...args) => call("knowledge.scheduleReview", args),
    "knowledge.abandonBatch": (...args) => call("knowledge.abandonBatch", args),
    "knowledge.save": (...args) => call("knowledge.save", args),
    "knowledge.evidence": (...args) => call("knowledge.evidence", args),
    "knowledge.sourceChanged": (...args) => call("knowledge.sourceChanged", args),
    "knowledge.advanceCascade": (...args) => call("knowledge.advanceCascade", args),
    "knowledge.invalidate": (...args) => call("knowledge.invalidate", args),
    "knowledge.purge": (...args) => call("knowledge.purge", args),
    "knowledge.ackChanges": (...args) => call("knowledge.ackChanges", args),
    "knowledge.enqueue": (...args) => call("knowledge.enqueue", args),
    "knowledge.classifyInitialRootBatches": (...args) =>
      call("knowledge.classifyInitialRootBatches", args),
    "knowledge.startBatch": (...args) => call("knowledge.startBatch", args),
    "knowledge.appendFrontier": (...args) => call("knowledge.appendFrontier", args),
    "knowledge.frontierOutcome": (...args) => call("knowledge.frontierOutcome", args),
    "knowledge.finishBatch": (...args) => call("knowledge.finishBatch", args),
    "knowledge.settleFrontier": (...args) => call("knowledge.settleFrontier", args),
    "knowledge.coverage": (...args) => call("knowledge.coverage", args),
    "knowledge.proposeCandidate": (...args) => call("knowledge.proposeCandidate", args),
    "knowledge.settleCandidate": (...args) => call("knowledge.settleCandidate", args),
  };
}

export function directKnowledgeGate(db: Database.Database): KnowledgeWriteGate {
  return {
    "knowledge.admitOrganization": async (...args) => admitKnowledgeOrganization(db, ...args),
    "knowledge.queueProjectionCleanup": async (...args) =>
      queueKnowledgeProjectionCleanup(db, ...args),
    "knowledge.ackProjectionCleanup": async (...args) => ackKnowledgeProjectionCleanup(db, ...args),
    "knowledge.refreshWork": async (...args) => refreshKnowledgeWork(db, ...args),
    "knowledge.discoveryTargets": async (...args) => recordKnowledgeDiscoveryTargets(db, ...args),
    "knowledge.publishCandidate": async (...args) => publishKnowledgeCandidate(db, ...args),
    "knowledge.decision": async (...args) => recordKnowledgeDecision(db, ...args),
    "knowledge.link": async (...args) => setKnowledgeLink(db, ...args),
    "knowledge.syncOwners": async (...args) => advanceKnowledgeOwnerSync(db, ...args),
    "knowledge.adoptWork": async (...args) => appendKnowledgeBatchWork(db, ...args),
    "knowledge.convertOwner": async (...args) => convertKnowledgeOwner(db, ...args),
    "knowledge.saveOwned": async (...args) => saveOwnedKnowledgeNode(db, ...args),
    "knowledge.checkpoint": async (...args) => setKnowledgeCheckpoint(db, ...args),
    "knowledge.scheduleReview": async (...args) => scheduleKnowledgeReview(db, ...args),
    "knowledge.abandonBatch": async (...args) => abandonKnowledgeBatch(db, ...args),
    "knowledge.save": async (...args) => saveKnowledgeNode(db, ...args),
    "knowledge.evidence": async (...args) => registerKnowledgeEvidence(db, ...args),
    "knowledge.sourceChanged": async (...args) => recordKnowledgeSourceChange(db, ...args),
    "knowledge.advanceCascade": async (...args) => advanceKnowledgeCascade(db, ...args),
    "knowledge.invalidate": async (...args) => invalidateKnowledgeDependents(db, ...args),
    "knowledge.purge": async (...args) => purgeKnowledgeBySource(db, ...args),
    "knowledge.ackChanges": async (...args) => ackKnowledgeChanges(db, ...args),
    "knowledge.enqueue": async (...args) => enqueueKnowledgeWork(db, ...args),
    "knowledge.classifyInitialRootBatches": async (...args) =>
      classifyInitialRootBatches(db, ...args),
    "knowledge.startBatch": async (...args) => startKnowledgeBatch(db, ...args),
    "knowledge.appendFrontier": async (...args) => appendKnowledgeFrontier(db, ...args),
    "knowledge.frontierOutcome": async (...args) => setKnowledgeFrontierOutcome(db, ...args),
    "knowledge.finishBatch": async (...args) => finishKnowledgeBatch(db, ...args),
    "knowledge.settleFrontier": async (...args) => settleKnowledgeFrontier(db, ...args),
    "knowledge.coverage": async (...args) => recordKnowledgeCoverage(db, ...args),
    "knowledge.proposeCandidate": async (...args) => proposeKnowledgeCandidate(db, ...args),
    "knowledge.settleCandidate": async (...args) => settleKnowledgeCandidate(db, ...args),
  };
}
