// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { cognitionBudgetVerdict } from "../cognition/budget.js";
import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
} from "../decision-payload.js";
import { brainSourceInclusionSql } from "../source-exclusion.js";
import { unreadablePendingClaimIds } from "./unreadable-support.js";
import { knowledgeNodeView, type KnowledgeNodeView } from "./node-view.js";
import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { WIKI_CURATION_TASK, WIKI_LOG_CURATION_TASK } from "./wiki-authoring.js";
import { CHRONOLOGICAL_LOG_REVIEW, isChronologicalLog } from "./wiki-page-shape.js";
import { oneTimePageReview } from "./related-knowledge.js";
import { knowledgeOrganizationVersion } from "./organization-context.js";
import { isHistoricalKnowledgeOwner } from "./owner-maintenance.js";
import { pendingMaintenanceClaimIds } from "./claim-maintenance.js";
import { getKnowledgeDependencies, getKnowledgeNode } from "./storage.js";
import { knowledgeHash } from "./storage-validation.js";
import {
  assertKnowledgeDiscoveryComplete,
  requiredKnowledgeDiscoveryPhases,
} from "./discovery-completion.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import {
  listKnowledgeFrontier,
  type KnowledgeFrontierInput,
  type KnowledgeFrontierItem,
} from "./work.js";
import { planMaintenanceGroups } from "./planner.js";
import { sourceHasDiscoveryObligation } from "./discovery-gate.js";
import { discoveryDecisionState, judgeKnowledge, type KnowledgeDecisionDeps } from "./decision.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery.js";
import { knowledgeSourceReadiness } from "./engine-readiness.js";
import { KnowledgeGraph } from "./engine-graph.js";
import { KnowledgeIntake } from "./engine-intake.js";
import { KnowledgeBatchPlanner } from "./engine-planning.js";
import { ownsCandidateTurn } from "./candidate-affinity.js";
import { pendingCandidateDecisions } from "./candidate-decision.js";
import { organizationCandidatesForSource } from "./organization.js";
import {
  fitKnowledgeFrontierItem,
  fitCandidateDecisions,
  MAX_SOURCE_FRONTIER_ITEMS,
  SOURCE_READ_PROGRESS_CHARS,
} from "./engine-frontier.js";
import { KnowledgeOrganization } from "./engine-organization.js";
import {
  recoverRootNavigation,
  ROOT_NAVIGATION_RECOVERY_TASK,
  type RecoverableNavigation,
} from "./navigation-recovery.js";
import { KnowledgeUpkeep } from "./engine-upkeep.js";
import { isolatedKnowledgeRetry } from "./work-retry.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeService } from "./service.js";
import type { KnowledgeWriteGate } from "./writer.js";
import type { ResolvedBrainSettings } from "../config.js";
import type Database from "better-sqlite3";
import type { DiscoveryPhase } from "./discovery.js";
import type { DerivationStage } from "../../domain/DocumentDerivation.js";
import type { InterestLookup } from "../interest/engine.js";
import type { Logger } from "@omnesis/core";

export interface KnowledgeEngineDeps {
  db: Database.Database;
  writeGate: KnowledgeWriteGate;
  service: KnowledgeService;
  decisions: KnowledgeDecisionDeps;
  /** The owner's past reactions, shown to the urgency gate. Omitted, it judges without them. */
  interest?: InterestLookup;
  getSettings: () => ResolvedBrainSettings;
  clock: () => number;
  log: Logger;
  idGen?: () => string;
  contentPending?: (ids: readonly string[]) => Set<string>;
  activeDerivationStages?: () => readonly DerivationStage[];
  publishedRetrievalBoundary?: () => string | null;
  /** Whether a run is executing in this process now; omitted, only claim age tells. */
  isRunActive?: (runId: string) => boolean;
}
interface SourceInput {
  id: string;
  title: string;
  content: string;
  contentHash: string;
  sourceRevision: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  contentTruncated?: boolean;
}
interface BatchRow {
  id: string;
  runId: string;
  status: string;
}
export interface KnowledgeFrontierView {
  batchId: string;
  done: boolean;
  organization?: ReturnType<KnowledgeOrganization["view"]>;
  candidateDecisions?: Array<{ id: string; revision: number }>;
  items: Array<{
    id: string;
    inputFingerprint: string;
    pendingClaimIds: string[];
    pendingClaimIdsOmitted?: boolean;
    inputVersions: Record<string, string | number>;
    depth: number;
    source?: SourceInput;
    completionRequirements?: { requiredPhases: DiscoveryPhase[] };
    inputVersionsOmitted?: boolean;
    fetchRequired?: {
      id: string;
      kind: string;
      title: string;
      revision: string | number;
      instruction: string;
    };
    candidates?: ReturnType<typeof organizationCandidatesForSource>;
    node?: KnowledgeNodeView | null;
    orientation?: ReturnType<KnowledgeService["list"]>;
    recoverableNavigation?: RecoverableNavigation;
    review?: boolean;
    /** Roots always reassess current orientation, even during claim-triggered repair. */
    maintenanceGoal?: "root_orientation" | "wiki_curation";
    maintenanceTask?: string;
  }>;
  interrupted?: boolean;
  /** Bounded deterministic work advanced; continue on another scheduler turn. */
  continuation?: boolean;
}
const sourceKey = (id: string) => `source:${id}`;

/**
 * Durable maintenance coordinator. The model edits state; the engine owns input
 * versions, gates, frontier expansion and completion. There is no recursive
 * model dispatch per edge, and the root aggregate is a separate coalesced job.
 */
export class KnowledgeEngine {
  private ticking = false;
  private readonly graph: KnowledgeGraph;
  private readonly upkeep: KnowledgeUpkeep;
  private readonly planner: KnowledgeBatchPlanner;
  private readonly intake: KnowledgeIntake;
  private readonly organization: KnowledgeOrganization;
  private readonly logReview: (pageId: string) => Promise<boolean>;
  constructor(readonly deps: KnowledgeEngineDeps) {
    this.logReview = oneTimePageReview(deps.service, CHRONOLOGICAL_LOG_REVIEW, () => this.id("kw"));
    this.graph = new KnowledgeGraph(deps.db, () => deps.getSettings().knowledge.maxVisitedPerSeed);
    this.upkeep = new KnowledgeUpkeep(
      deps,
      (prefix) => this.id(prefix),
      () => this.initialRoot(),
    );
    this.intake = new KnowledgeIntake({
      deps,
      id: (prefix) => this.id(prefix),
      source: (id) => this.source(id),
      pageArcs: (id, after, limit) => this.graph.page(id, after, limit),
      roots: () => this.roots(),
    });
    this.organization = new KnowledgeOrganization({
      deps,
      id: (prefix) => this.id(prefix),
      source: (id) => this.source(id),
      frontier: (id, depth) => this.frontier(id, depth),
      arcs: (id) => this.graph.arcs(id),
      roots: () => this.roots(),
    });
    this.planner = new KnowledgeBatchPlanner({
      deps,
      initialRoot: () => this.initialRoot(),
      id: (prefix) => this.id(prefix),
      frontier: (id, depth) => this.frontier(id, depth),
      arcs: (id) => this.graph.arcs(id),
      roots: () => this.roots(),
    });
  }
  private id(prefix: string): string {
    return `${prefix}_${this.deps.idGen?.() ?? randomUUID()}`;
  }
  /**
   * A readable source document, or null. A document from a source excluded
   * from the Brain (`brain.excludedSources`) reads as absent, so intake admits
   * no work for it, an already-batched frontier item settles without a model
   * turn, and a batch's change summary never carries its content.
   */
  private source(id: string): SourceInput | null {
    const inclusion = brainSourceInclusionSql(
      this.deps.getSettings().excludedSources,
      "d.source_id",
    );
    return (
      this.deps.db
        .prepare<unknown[], SourceInput>(
          `SELECT d.id,d.title,d.content,d.content_hash AS contentHash,${knowledgeSourceRevisionSql()} AS sourceRevision,d.source_created_at AS sourceCreatedAt,d.source_updated_at AS sourceUpdatedAt
      FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
      WHERE d.id=? AND COALESCE(r.deleted,0)=0 AND ${inclusion.sql}`,
        )
        .get(id, ...inclusion.params) ?? null
    );
  }
  private sourceExcerpt(id: string): SourceInput | null {
    const source = this.source(id);
    if (!source) return null;
    const cap = Math.max(
      1000,
      Math.floor(24000 / this.deps.getSettings().knowledge.maxFrontierNodes),
    );
    return {
      ...source,
      content: source.content.slice(0, cap),
      contentTruncated: source.content.length > cap,
    };
  }
  /** A stored node as the steward reads it in a frontier offer. */
  private nodeView(id: string): KnowledgeNodeView | null {
    const node = this.deps.service.fetch(id, true);
    return node ? knowledgeNodeView(node) : null;
  }

  private roots(): Set<string> {
    return new Set(
      this.deps.db
        .prepare<[], { id: string }>("SELECT id FROM knowledge_nodes WHERE kind='root'")
        .all()
        .map((row) => row.id),
    );
  }
  private frontier(id: string, depth: number, batchId?: string): KnowledgeFrontierInput | null {
    const versions: Record<string, string | number> = {};
    if (id.startsWith("source:")) {
      const source = this.source(id.slice(7));
      if (!source) return null;
      versions[id] = source.sourceRevision;
    } else {
      const node = getKnowledgeNode(this.deps.db, id);
      if (!node || node.canonicalFields.withdrawn === true) return null;
      versions[`node:${id}`] = node.revision;
      if (node.kind === "wiki" || node.kind === "root")
        versions[`organization:${id}`] = knowledgeOrganizationVersion(this.deps.db, id);
      // Selection is durable input context, not a claim-support relationship.
      // Scope it to source generations actually retained by this batch.
      if (batchId) {
        const discovered = this.deps.db
          .prepare<[string, string], { id: string; revision: string }>(
            `SELECT DISTINCT t.source_id AS id,t.source_revision AS revision
          FROM knowledge_discovery_targets t
          JOIN documents d ON d.id=t.source_id AND ${knowledgeSourceRevisionSql()}=t.source_revision
          JOIN knowledge_frontier f ON f.batch_id=? AND f.node_id='source:'||t.source_id
          JOIN json_each(f.input_versions_json) v ON v.key='source:'||t.source_id
            AND v.value=t.source_revision
          WHERE t.node_id=? ORDER BY t.source_id`,
          )
          .all(batchId, id);
        for (const source of discovered)
          if (isKnowledgeEvidenceReadable(this.deps.db, source.id))
            versions[sourceKey(source.id)] = source.revision;
      }

      if (node.kind === "root")
        for (const candidate of this.orientation())
          versions[`orientation:${candidate.id}`] = candidate.meaningRevision;
      const blockers =
        node.kind === "loop" && Array.isArray(node.canonicalFields.blockedBy)
          ? node.canonicalFields.blockedBy
          : [];
      for (const blocker of blockers)
        if (typeof blocker === "string") {
          versions[`blocked_by:${blocker}`] =
            getKnowledgeNode(this.deps.db, blocker)?.meaningRevision ?? "missing";
        }
      for (const dep of getKnowledgeDependencies(this.deps.db, id)) {
        try {
          versions[dep.ref] = this.deps.service.reference(dep.ref).revision;
        } catch {
          versions[dep.ref] = "missing";
        }
      }
    }
    return {
      nodeId: id,
      inputFingerprint: knowledgeHash(versions),
      inputVersions: versions,
      depth,
    };
  }
  private initialRoot(): string | null {
    const root = this.deps.db
      .prepare<
        [],
        { id: string }
      >("SELECT id FROM knowledge_nodes WHERE kind='root' AND trim(plain_text)='' LIMIT 1")
      .get();
    return root && this.orientation().some((node) => node.plainText.trim()) ? root.id : null;
  }
  private orientation(): Array<
    ReturnType<KnowledgeService["list"]>[number] & {
      contentTruncated: boolean;
      orientationIncomplete: boolean;
    }
  > {
    const ids = this.deps.db
      .prepare<
        [number],
        { id: string }
      >("SELECT id FROM knowledge_nodes WHERE kind!='root' ORDER BY COALESCE(json_extract(metadata_json,'$.importance'),0) DESC,updated_at DESC,id LIMIT ?")
      .all(this.deps.getSettings().knowledge.maxFrontierNodes + 1);
    const limit = this.deps.getSettings().knowledge.maxFrontierNodes;
    return ids.slice(0, limit).flatMap(({ id }) => {
      const node = this.deps.service.fetch(id);
      if (!node) return [];
      const { claims: _claims, ...summary } = node;
      return [
        {
          ...summary,
          contentTruncated: node.plainText.length > 1200,
          orientationIncomplete: ids.length > limit,
          markdown: node.plainText.slice(0, 1200),
          plainText: node.plainText.slice(0, 1200),
        },
      ];
    });
  }
  diagnostics() {
    return {
      work: this.deps.db
        .prepare("SELECT status,COUNT(*) AS count FROM knowledge_work GROUP BY status")
        .all(),
      batches: this.deps.db
        .prepare("SELECT status,COUNT(*) AS count FROM knowledge_batches GROUP BY status")
        .all(),
      frontier: this.deps.db
        .prepare("SELECT status,COUNT(*) AS count FROM knowledge_frontier GROUP BY status")
        .all(),
    };
  }
  private batch(batchId: string, runId: string): BatchRow {
    const batch = this.deps.db
      .prepare<
        [string],
        BatchRow
      >("SELECT id,run_id AS runId,status FROM knowledge_batches WHERE id=?")
      .get(batchId);
    if (!batch || batch.runId !== runId)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Maintenance batch is not owned by this run",
      );
    return batch;
  }

  /** Each scheduler tick is bounded; unfinished intake and cascades remain durable. */
  async tick(): Promise<{ cascading: boolean; enqueued: number }> {
    if (this.ticking) return { cascading: false, enqueued: 0 };
    this.ticking = true;
    try {
      const cfg = this.deps.getSettings().knowledge;
      const cascade = await this.deps.writeGate["knowledge.advanceCascade"](
        cfg.cascadeBatchSize,
        this.deps.clock(),
      );
      for (const id of [...cascade.deletedNodeIds, ...cascade.invalidatedNodeIds])
        await this.deps.service.deps.mirror?.refresh(id);
      if (cascade.pending) return { cascading: true, enqueued: 0 };
      const owners = await this.deps.writeGate["knowledge.syncOwners"](
        Math.min(512, cfg.cascadeBatchSize),
        this.deps.clock(),
      );
      for (const id of [...owners.updatedNodeIds, ...owners.deletedNodeIds])
        await this.deps.service.deps.mirror?.refresh(id);
      await this.upkeep.recover();
      await this.upkeep.root();
      await this.upkeep.convert();
      if (
        cognitionBudgetVerdict(this.deps.db, this.deps.getSettings().budget, this.deps.clock())
          .exhausted
      )
        return { cascading: false, enqueued: 0 };
      const publishedThrough = this.deps.publishedRetrievalBoundary?.();
      if (publishedThrough)
        await this.deps.writeGate["knowledge.reconsiderRetrieval"](
          { publishedThrough, limit: cfg.discoveryBatchSize },
          this.deps.clock(),
        );
      await this.intake.intake();
      await this.intake.bootstrap();
      await this.upkeep.reviews();
      await this.upkeep.organization();
      await this.intake.retireExcluded();
      const enqueued = await this.planner.plan();
      return { cascading: false, enqueued: enqueued + (await this.organization.plan()) };
    } finally {
      this.ticking = false;
    }
  }

  async next(batchId: string, runId: string): Promise<KnowledgeFrontierView> {
    // A shutdown can leave the run pending after its batch committed completion.
    // Settle that queue receipt without reopening work or resolving a backend.
    if (this.batch(batchId, runId).status === "completed")
      return { batchId, done: true, items: [] };
    if (!ownsCandidateTurn(this.deps.db, batchId)) return { batchId, done: false, items: [] };
    if (!(await this.organization.current(batchId)))
      return { batchId, done: true, interrupted: true, items: [] };
    const result = await this.nextMaintenance(batchId, runId);
    if (!(await this.organization.current(batchId)))
      return { batchId, done: true, interrupted: true, items: [] };
    if (!ownsCandidateTurn(this.deps.db, batchId)) return { batchId, done: false, items: [] };
    const organization = this.organization.view(batchId);
    return fitCandidateDecisions(
      organization ? { ...result, organization } : result,
      this.deps.getSettings().knowledge.maxFrontierChars,
    );
  }
  private async nextMaintenance(batchId: string, runId: string): Promise<KnowledgeFrontierView> {
    if (this.batch(batchId, runId).status === "abandoned")
      return { batchId, done: true, interrupted: true, items: [] };
    if (!ownsCandidateTurn(this.deps.db, batchId)) return { batchId, done: false, items: [] };
    const cfg = this.deps.getSettings().knowledge;
    if (
      cognitionBudgetVerdict(this.deps.db, this.deps.getSettings().budget, this.deps.clock())
        .exhausted
    )
      return { batchId, done: false, items: [] };
    await this.planner.adoptOverlappingWork(batchId);
    if (this.batch(batchId, runId).status === "abandoned")
      return { batchId, done: true, interrupted: true, items: [] };
    const cascade = await this.deps.writeGate["knowledge.advanceCascade"](
      cfg.cascadeBatchSize,
      this.deps.clock(),
    );
    for (const id of [...cascade.deletedNodeIds, ...cascade.invalidatedNodeIds])
      await this.deps.service.deps.mirror?.refresh(id);
    if (cascade.pending) return { batchId, done: false, items: [] };
    let progressed = false;
    for (let pass = 0; pass < cfg.maxFrontierNodes; pass++) {
      if (this.batch(batchId, runId).status === "abandoned")
        return { batchId, done: true, interrupted: true, items: [] };
      const all = listKnowledgeFrontier(this.deps.db, batchId);
      if (all.length > cfg.maxFrontierNodes * cfg.maxVisitedPerSeed) {
        await this.deps.writeGate["knowledge.abandonBatch"](
          { batchId, notBefore: this.deps.clock() + cfg.soonDelayMs },
          this.deps.clock(),
        );
        return { batchId, done: true, interrupted: true, items: [] };
      }
      const unresolved = all.filter((item) =>
        ["pending", "offered", "deferred"].includes(item.status),
      );
      if (!unresolved.length)
        return {
          batchId,
          done: await this.deps.writeGate["knowledge.finishBatch"](
            batchId,
            this.deps.clock(),
            runId,
          ),
          items: [],
          candidateDecisions: pendingCandidateDecisions(this.deps.db, batchId),
        };
      const depth = Math.min(...unresolved.map((item) => item.depth));
      const offered: KnowledgeFrontierView["items"] = [];
      let offeredSources = 0;
      let remainingChars =
        cfg.maxFrontierChars - JSON.stringify({ batchId, done: false, items: [] }).length;
      // On a retry, inputs not yet offered come first, so an input an earlier
      // attempt left pending cannot hold the offer window and starve the rest
      // of the batch. A first attempt keeps the stable order it is working in.
      const retrying =
        (this.deps.db
          .prepare<[string], { attempts: number }>("SELECT attempts FROM cognition_runs WHERE id=?")
          .get(runId)?.attempts ?? 0) > 1;
      for (const item of unresolved
        .filter((row) => row.depth === depth)
        .sort((a, b) =>
          retrying ? Number(a.status === "offered") - Number(b.status === "offered") : 0,
        )
        .slice(0, cfg.maxFrontierNodes)) {
        // Bound the presented source chunk, not batch membership or independent regions.
        // Complete reads and per-source settlement need room within the run tool budget.
        if (item.nodeId.startsWith("source:") && offeredSources >= MAX_SOURCE_FRONTIER_ITEMS)
          continue;
        if (
          !item.nodeId.startsWith("source:") &&
          getKnowledgeNode(this.deps.db, item.nodeId)?.ownerId
        ) {
          // Canonical tools can leave deterministic owner projection queued.
          // Drain this owner before offering a revision that the queued update
          // would immediately supersede, without waiting for unrelated work.
          const owner = await this.deps.writeGate["knowledge.syncOwners"](
            1,
            this.deps.clock(),
            item.nodeId,
          );
          for (const id of [...owner.updatedNodeIds, ...owner.deletedNodeIds])
            await this.deps.service.deps.mirror?.refresh(id);
        }
        const fresh = this.frontier(item.nodeId, item.depth, batchId);
        if (!fresh) {
          await this.settle(item, runId, "unchanged", []);
          progressed = true;
          continue;
        }
        if (fresh.inputFingerprint !== item.inputFingerprint) {
          await this.settle(item, runId, "unchanged", [fresh]);
          progressed = true;
          continue;
        }
        const currentNode = item.nodeId.startsWith("source:")
          ? null
          : getKnowledgeNode(this.deps.db, item.nodeId);
        if (
          currentNode &&
          isHistoricalKnowledgeOwner(this.deps.db, currentNode, this.deps.clock())
        ) {
          await this.settle(
            item,
            runId,
            "skipped",
            this.children(item.nodeId, item.depth),
            undefined,
            currentNode.revision,
          );
          progressed = true;
          continue;
        }
        // A page already shaped as a log gets one whole-page consolidation
        // review, whatever brought it into this pass. A review is that pass.
        if (
          currentNode?.kind === "wiki" &&
          item.status !== "offered" &&
          isChronologicalLog(currentNode.plainText) &&
          !this.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review'",
            )
            .get(batchId, currentNode.id) &&
          (await this.logReview(currentNode.id))
        )
          this.deps.log.info(
            `Wiki ${currentNode.id} queued for review: most of its sections are named by dates`,
          );
        if (item.nodeId.startsWith("source:")) {
          const seed = this.deps.db
            .prepare<
              [string, string],
              { inputChangedAt: number | null }
            >("SELECT MIN(input_changed_at) AS inputChangedAt FROM knowledge_work WHERE subject_id=? AND input_revision=?")
            .get(item.nodeId.slice(7), String(item.inputVersions[item.nodeId]));
          if (
            !knowledgeSourceReadiness(
              this.deps,
              item.nodeId.slice(7),
              seed?.inputChangedAt ?? this.deps.clock(),
            ).ready
          )
            continue;
        }
        if (item.status !== "offered") {
          const payloadGeneration = decisionPayloadErasureGeneration(this.deps.db);
          const source = item.nodeId.startsWith("source:")
            ? this.source(item.nodeId.slice(7))
            : null;
          // The source became unreadable (deleted or excluded) after the
          // frontier read above: it has nothing left to offer.
          if (item.nodeId.startsWith("source:") && !source) {
            await this.settle(item, runId, "unchanged", []);
            progressed = true;
            continue;
          }
          const node = source ? null : this.deps.service.fetch(item.nodeId, true);
          const isReview = !!this.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review'",
            )
            .get(batchId, item.nodeId.startsWith("source:") ? item.nodeId.slice(7) : item.nodeId);
          // An agent already selected these repair targets while interpreting a
          // source. Do not let a second, cheaper gate discard that explicit work.
          // A selection stays outstanding until the page next changes, so it
          // survives its source's batch being abandoned after the source settled.
          const isDiscoveryTarget =
            !source &&
            !!this.deps.db
              .prepare(
                `SELECT 1 FROM knowledge_discovery_targets t
             JOIN documents d ON d.id=t.source_id AND ${knowledgeSourceRevisionSql()}=t.source_revision
             WHERE t.node_id=? AND (
               EXISTS(SELECT 1 FROM knowledge_frontier f WHERE f.node_id='source:'||t.source_id AND f.batch_id=?)
               OR t.created_at>=(SELECT n.updated_at FROM knowledge_nodes n WHERE n.id=t.node_id)) LIMIT 1`,
              )
              .get(item.nodeId, batchId);
          const rootOrientation = node?.kind === "root" ? this.orientation() : undefined;
          const isInitialRoot =
            !!rootOrientation &&
            !node!.plainText.trim() &&
            rootOrientation.some((candidate) => candidate.plainText.trim());
          // A cheap gate cannot judge root changes from opaque revision IDs alone.
          // If bounded context cannot fit, leave the decision to synthesis.
          const rootContextUnavailable =
            rootOrientation !== undefined &&
            (rootOrientation.length === 0 ||
              rootOrientation.some(
                (candidate) => candidate.contentTruncated || candidate.orientationIncomplete,
              ) ||
              JSON.stringify(rootOrientation).length > Math.min(cfg.maxFrontierChars, 24000));
          const changedInputs =
            source ||
            isReview ||
            isDiscoveryTarget ||
            isInitialRoot ||
            rootContextUnavailable ||
            node?.validity === "stale"
              ? []
              : this.batchSources(batchId);
          const score =
            isReview ||
            isDiscoveryTarget ||
            isInitialRoot ||
            rootContextUnavailable ||
            node?.validity === "stale" ||
            (source && sourceHasDiscoveryObligation(this.deps.db, source.id))
              ? null
              : await judgeKnowledge(
                  this.deps.decisions,
                  source ? "discovery" : "impact",
                  source
                    ? discoveryDecisionState(source)
                    : {
                        inputVersions: item.inputVersions,
                        node,
                        changedInputs,
                        ...(rootOrientation ? { orientation: rootOrientation } : {}),
                      },
                  {
                    runId,
                    batchId,
                    nodeId: item.nodeId,
                    threshold: 0.25,
                    payloadCapture:
                      captureDecisionPayloadSubjects(
                        this.deps.db,
                        {
                          sourceIds: source ? [source.id] : changedInputs.map((input) => input.id),
                          nodeIds: source
                            ? []
                            : [item.nodeId, ...(rootOrientation ?? []).map((input) => input.id)],
                          nodeRevisions: node
                            ? Object.fromEntries(
                                [node, ...(rootOrientation ?? [])].map((input) => [
                                  input.id,
                                  input.revision,
                                ]),
                              )
                            : undefined,
                        },
                        payloadGeneration,
                      ) ?? undefined,
                  },
                );
          if (
            !isReview &&
            !isDiscoveryTarget &&
            !isInitialRoot &&
            score !== null &&
            score < 0.25 &&
            (source
              ? !sourceHasDiscoveryObligation(this.deps.db, source.id)
              : node?.validity !== "stale")
          ) {
            if (source)
              await this.completeSource(batchId, runId, item.nodeId, item.inputFingerprint, true);
            else {
              // Skipping inspection is not verification. Its older claim
              // attestations must not survive a changed support version.
              await this.settle(item, runId, "skipped", []);
            }
            progressed = true;
            continue;
          }
          await this.deps.writeGate["knowledge.frontierOutcome"](
            {
              batchId,
              runId,
              nodeId: item.nodeId,
              inputFingerprint: item.inputFingerprint,
              status: "offered",
            },
            this.deps.clock(),
          );
        }
        // A claim resting on a source excluded from the Brain cannot be
        // re-checked by this run; unless its own references changed, it is
        // kept as it is rather than offered for review (unreadable-support.ts).
        const excluded = this.deps.getSettings().excludedSources;
        if (unreadablePendingClaimIds(this.deps.db, { ...item, batchId }, excluded).length > 0)
          await this.deps.writeGate["knowledge.exemptUnreadableClaims"]({
            batchId,
            runId,
            nodeId: item.nodeId,
            inputFingerprint: item.inputFingerprint,
            excluded,
          });
        const excerpt = item.nodeId.startsWith("source:")
          ? this.sourceExcerpt(item.nodeId.slice(7))
          : null;
        if (item.nodeId.startsWith("source:") && !excerpt) {
          await this.settle(item, runId, "unchanged", []);
          progressed = true;
          continue;
        }
        const candidate: KnowledgeFrontierView["items"][number] = {
          id: item.nodeId,
          pendingClaimIds: pendingMaintenanceClaimIds(this.deps.db, item),
          inputFingerprint: item.inputFingerprint,
          inputVersions: item.inputVersions,
          depth: item.depth,
          ...(item.nodeId.startsWith("source:")
            ? {
                source: excerpt!,
                completionRequirements: {
                  requiredPhases: requiredKnowledgeDiscoveryPhases(
                    this.deps.db,
                    item.nodeId.slice(7),
                    String(item.inputVersions[item.nodeId]),
                    this.deps.clock(),
                  ),
                },
                candidates: organizationCandidatesForSource(this.deps.db, item.nodeId.slice(7)),
              }
            : { node: this.nodeView(item.nodeId) }),
          ...(this.roots().has(item.nodeId)
            ? { orientation: this.orientation(), maintenanceGoal: "root_orientation" as const }
            : {}),
          review: !!this.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review'",
            )
            .get(batchId, item.nodeId.startsWith("source:") ? item.nodeId.slice(7) : item.nodeId),
        };
        if (candidate.node?.kind === "wiki" && candidate.review) {
          candidate.maintenanceGoal = "wiki_curation";
          candidate.maintenanceTask = isChronologicalLog(candidate.node.markdown)
            ? WIKI_LOG_CURATION_TASK
            : WIKI_CURATION_TASK;
        }
        if (candidate.maintenanceGoal === "root_orientation") {
          candidate.recoverableNavigation = recoverRootNavigation(
            this.deps.db,
            item.nodeId,
            cfg.maxFrontierNodes,
          );
          if (candidate.recoverableNavigation)
            candidate.maintenanceTask = ROOT_NAVIGATION_RECOVERY_TASK;
        }
        const progressChars = candidate.source ? SOURCE_READ_PROGRESS_CHARS : 0;
        const fitted = fitKnowledgeFrontierItem(
          candidate,
          remainingChars - progressChars - 1,
          offered.length === 0,
        );
        if (!fitted) break;
        offered.push(fitted);
        if (item.nodeId.startsWith("source:")) offeredSources++;
        remainingChars -= JSON.stringify(fitted).length + progressChars + 1;
      }
      if (offered.length) return { batchId, done: false, items: offered };
    }
    return { batchId, done: false, items: [], ...(progressed ? { continuation: true } : {}) };
  }

  private batchSources(batchId: string): Array<{
    id: string;
    title: string;
    content: string;
    contentHash: string;
    sourceRevision: string;
  }> {
    const rows = this.deps.db
      .prepare<
        [string],
        { subject_id: string }
      >("SELECT subject_id FROM knowledge_work WHERE batch_id=? AND subject_kind='source'")
      .all(batchId);
    return rows.flatMap((row) => {
      const source = this.source(row.subject_id);
      return source
        ? [
            {
              ...source,
              content: source.content.slice(
                0,
                Math.max(500, Math.floor(24000 / Math.max(1, rows.length))),
              ),
            },
          ]
        : [];
    });
  }
  private async settle(
    item: KnowledgeFrontierItem,
    runId: string,
    status: "skipped" | "unchanged" | "changed",
    append: KnowledgeFrontierInput[],
    resultRevision?: number,
    historicalOwnerRevision?: number,
  ): Promise<void> {
    try {
      await this.deps.writeGate["knowledge.settleFrontier"](
        {
          outcome: {
            batchId: item.batchId,
            runId,
            nodeId: item.nodeId,
            inputFingerprint: item.inputFingerprint,
            status,
            resultRevision,
          },
          append,
          historicalOwnerRevision,
        },
        this.deps.clock(),
      );
    } catch (error) {
      if (
        error instanceof KnowledgeStorageError &&
        error.code === "revision_conflict" &&
        error.message.includes("overlaps an active batch")
      ) {
        await this.deps.writeGate["knowledge.abandonBatch"](
          { batchId: item.batchId, notBefore: this.deps.clock() },
          this.deps.clock(),
        );
      } else throw error;
    }
  }
  /** Recover omitted input context without depending on a predecessor's transcript. */
  maintenanceInputs(batchId: string, runId: string, nodeId: string, after?: string, limit = 32) {
    const batch = this.batch(batchId, runId);
    if (["completed", "abandoned"].includes(batch.status))
      throw new KnowledgeStorageError("revision_conflict", "Maintenance batch is no longer active");
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new KnowledgeStorageError("claim_invalid", "Input page limit must be between 1 and 32");
    const offered = listKnowledgeFrontier(this.deps.db, batchId).find(
      (item) => item.nodeId === nodeId && item.status === "offered",
    );
    if (!offered)
      throw new KnowledgeStorageError("revision_conflict", "Inputs require an offered frontier");
    const item = this.currentItem(batchId, nodeId, offered.inputFingerprint);
    const keys = Object.keys(item.inputVersions)
      .sort()
      .filter((key) => !after || key > after);
    const page = keys.slice(0, limit);
    return {
      inputFingerprint: item.inputFingerprint,
      inputVersions: Object.fromEntries(page.map((key) => [key, item.inputVersions[key]!])),
      ...(keys.length > limit ? { nextAfter: page.at(-1)! } : {}),
    };
  }

  private currentItem(batchId: string, nodeId: string, fingerprint: string): KnowledgeFrontierItem {
    const item = listKnowledgeFrontier(this.deps.db, batchId).find(
      (row) =>
        row.nodeId === nodeId &&
        row.inputFingerprint === fingerprint &&
        ["pending", "offered", "deferred"].includes(row.status),
    );
    if (!item)
      throw new KnowledgeStorageError("revision_conflict", "Frontier item is no longer current");
    const fresh = this.frontier(nodeId, item.depth, batchId);
    if (!fresh || fresh.inputFingerprint !== fingerprint)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Frontier inputs changed; request the next frontier again",
      );
    return item;
  }
  private children(nodeId: string, depth: number): KnowledgeFrontierInput[] {
    const roots = this.roots();
    return this.graph
      .arcs(nodeId)
      .filter((arc) => !roots.has(arc.dependent))
      .flatMap((arc) => {
        const node = getKnowledgeNode(this.deps.db, arc.dependent);
        // A dependent a failed batch could not finish keeps its obligation in
        // its own isolated retry, or is parked; repeating it here would hold
        // this batch open on the same input.
        if (node && isolatedKnowledgeRetry(this.deps.db, node.id, node.revision)) return [];
        const refs = getKnowledgeDependencies(this.deps.db, arc.dependent).filter(
          (dep) =>
            dep.relation !== "context" &&
            (dep.targetKind === "source" ? sourceKey(dep.targetId) : dep.targetId) === nodeId,
        );
        // Exact claim versions can stay stable while another claim on the same
        // page changes. Do not turn an unrelated claim edit into a repair task.
        const operational =
          node?.kind === "loop" &&
          Array.isArray(node.canonicalFields.blockedBy) &&
          node.canonicalFields.blockedBy.includes(nodeId);
        if (
          !nodeId.startsWith("source:") &&
          !operational &&
          node?.validity === "current" &&
          refs.length &&
          refs.every((dep) => {
            try {
              return dep.inputVersion === this.deps.service.reference(dep.ref).revision;
            } catch {
              return false;
            }
          })
        )
          return [];
        const item = this.frontier(arc.dependent, depth + 1);
        return item ? [item] : [];
      });
  }

  async completeSource(
    batchId: string,
    runId: string,
    nodeId: string,
    inputFingerprint: string,
    gated = false,
    phases: DiscoveryPhase[] = ["interpretation", "organization"],
    proposedTargets: string[] = [],
    retrievalBoundary?: string,
  ): Promise<void> {
    this.batch(batchId, runId);
    if (!nodeId.startsWith("source:"))
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Discovery completion requires a source frontier",
      );
    const item = this.currentItem(batchId, nodeId, inputFingerprint);
    if (!gated && item.status !== "offered")
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Read the offered source before completing discovery",
      );
    const sourceRevision = String(item.inputVersions[nodeId]);
    assertKnowledgeDiscoveryComplete(
      this.deps.db,
      nodeId.slice(7),
      sourceRevision,
      phases,
      this.deps.clock(),
    );
    if (proposedTargets.length)
      await this.deps.writeGate["knowledge.discoveryTargets"](
        {
          runFence: { batchId, runId },
          sourceId: nodeId.slice(7),
          sourceRevision: String(item.inputVersions[nodeId]),
          nodeIds: proposedTargets,
        },
        this.deps.clock(),
      );
    const children = gated ? [] : this.children(nodeId, item.depth);
    const cfg = this.deps.getSettings().knowledge;
    const region = children.length
      ? planMaintenanceGroups(
          [
            {
              id: nodeId,
              revision: inputFingerprint,
              changedAt: 0,
              dueAt: 0,
              tier: "immediate",
              targets: children.map((child) => child.nodeId),
            },
          ],
          (id) => this.graph.arcs(id).map((arc) => arc.dependent),
          this.roots(),
          { maxSeeds: 1, maxVisitedPerSeed: cfg.maxVisitedPerSeed },
        )[0]!.nodes
      : [];
    try {
      await this.deps.writeGate["knowledge.settleFrontier"](
        {
          outcome: {
            batchId,
            runId,
            nodeId,
            inputFingerprint,
            status: gated ? "skipped" : "changed",
          },
          append: children,
          regionNodeIds: region,
          requiredDiscovery: { subjectId: nodeId.slice(7), inputRevision: sourceRevision },
          coverage: [...new Set(phases)].map((phase) => ({
            subjectId: nodeId.slice(7),
            inputRevision: String(item.inputVersions[nodeId]),
            phase,
            policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
            status: gated ? "gated" : "considered",
            ...(!gated && retrievalBoundary ? { retrievalBoundary } : {}),
            ...(gated
              ? {
                  reconsiderAt:
                    this.deps.clock() + this.deps.getSettings().knowledge.maxReviewIntervalMs,
                }
              : {}),
          })),
        },
        this.deps.clock(),
      );
    } catch (error) {
      if (
        error instanceof KnowledgeStorageError &&
        error.code === "revision_conflict" &&
        error.message.includes("overlaps an active batch")
      ) {
        await this.deps.writeGate["knowledge.abandonBatch"](
          { batchId, notBefore: this.deps.clock() },
          this.deps.clock(),
        );
      } else throw error;
    }
  }

  /** Same frontier check used by saveNode, exposed before caller-side paid checks. */
  preflightSaveNode(batchId: string, runId: string, nodeId: string, inputFingerprint: string) {
    this.batch(batchId, runId);
    const item = this.currentItem(batchId, nodeId, inputFingerprint);
    if (item.status !== "offered")
      throw new KnowledgeStorageError("claim_invalid", "Save must match an offered synthesis node");
    return item;
  }

  /** A successful canonical write, not an agent's declaration, determines changed versus unchanged. */
  async saveNode(
    batchId: string,
    runId: string,
    nodeId: string,
    inputFingerprint: string,
    input: Parameters<KnowledgeService["save"]>[0],
    reviewedClaimIds?: readonly string[],
    runFence?: import("./run-fence.js").KnowledgeRunFence,
    placementAssessment?: import("./placement-assessment.js").KnowledgePlacementAssessment,
    outcomeFence?: import("../storage/outcome-write-fence.js").OutcomeWriteFence,
    curationDeferral?: NonNullable<
      import("./types.js").SaveKnowledgeNodeInput["maintenance"]
    >["curationDeferral"],
  ) {
    const item = this.preflightSaveNode(batchId, runId, nodeId, inputFingerprint);
    if (item.nodeId !== input.id)
      throw new KnowledgeStorageError("claim_invalid", "Save must match an offered synthesis node");
    const result = await this.deps.service.save(
      {
        ...input,
        maintenance: {
          batchId,
          runId,
          inputFingerprint,
          reviewedClaimIds,
          placementAssessment,
          curationDeferral,
          placementRetryDelayMs: this.deps.getSettings().knowledge.routineDelayMs,
        },
      },
      undefined,
      runFence,
      outcomeFence,
    );
    const pending = pendingMaintenanceClaimIds(this.deps.db, item);
    const append = result.meaningChanged ? this.children(nodeId, item.depth) : [];
    if (pending.length) {
      const successor = this.frontier(nodeId, item.depth, batchId);
      if (successor) append.unshift({ ...successor, eligibleClaimIds: pending });
    }
    await this.settle(
      item,
      runId,
      result.meaningChanged ? "changed" : "unchanged",
      append,
      pending.length || result.curationDeferral || result.placementAssessment?.status === "deferred"
        ? undefined
        : result.node.revision,
    );
    // Settlement yields to the writer too: recheck before exposing saved prose.
    const current = getKnowledgeNode(this.deps.db, nodeId);
    if (!current)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Saved synthesis is no longer available",
      );
    if (current.revision !== result.node.revision)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Saved synthesis changed during settlement",
      );
    return { ...result, node: current };
  }
}
