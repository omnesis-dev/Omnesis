// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { listTemporalAnnotationsAwaitingRefile } from "../../enrichment/temporal-annotations/storage.js";
import { cognitionBudgetVerdict } from "../cognition/budget.js";
import { knowledgeOrganizationVersion } from "./organization-context.js";
import { isHistoricalKnowledgeBrief } from "./owner-maintenance.js";
import { pendingMaintenanceClaimIds } from "./claim-maintenance.js";
import { getKnowledgeDependencies, getKnowledgeNode } from "./storage.js";
import { knowledgeHash } from "./storage-validation.js";
import { assertKnowledgeDiscoveryComplete } from "./discovery-completion.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import {
  listKnowledgeFrontier,
  type KnowledgeFrontierInput,
  type KnowledgeFrontierItem,
} from "./work.js";
import { planMaintenanceGroups } from "./planner.js";
import { judgeKnowledge, type KnowledgeDecisionDeps } from "./decision.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery.js";
import { knowledgeSourceReadiness } from "./engine-readiness.js";
import { KnowledgeGraph } from "./engine-graph.js";
import { KnowledgeIntake } from "./engine-intake.js";
import { KnowledgeBatchPlanner } from "./engine-planning.js";
import { organizationCandidatesForSource } from "./organization.js";
import { fitKnowledgeFrontierItem } from "./engine-frontier.js";
import { KnowledgeOrganization } from "./engine-organization.js";
import { KnowledgeUpkeep } from "./engine-upkeep.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeService } from "./service.js";
import type { KnowledgeWriteGate } from "./writer.js";
import type { ResolvedBrainSettings } from "../config.js";
import type Database from "better-sqlite3";
import type { DiscoveryPhase } from "./discovery.js";
import type { DerivationStage } from "../../domain/DocumentDerivation.js";
import type { Logger } from "@omnesis/core";

export interface KnowledgeEngineDeps {
  db: Database.Database;
  writeGate: KnowledgeWriteGate;
  service: KnowledgeService;
  decisions: KnowledgeDecisionDeps;
  getSettings: () => ResolvedBrainSettings;
  clock: () => number;
  log: Logger;
  idGen?: () => string;
  contentPending?: (ids: readonly string[]) => Set<string>;
  activeDerivationStages?: () => readonly DerivationStage[];
}
interface SourceInput {
  id: string;
  title: string;
  content: string;
  contentHash: string;
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
  items: Array<{
    id: string;
    inputFingerprint: string;
    pendingClaimIds: string[];
    pendingClaimIdsOmitted?: boolean;
    inputVersions: Record<string, string | number>;
    depth: number;
    source?: SourceInput;
    inputVersionsOmitted?: boolean;
    fetchRequired?: {
      id: string;
      kind: string;
      title: string;
      revision: string | number;
      instruction: string;
    };
    candidates?: ReturnType<typeof organizationCandidatesForSource>;
    node?: ReturnType<KnowledgeService["fetch"]>;
    orientation?: ReturnType<KnowledgeService["list"]>;
    review?: boolean;
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
  constructor(readonly deps: KnowledgeEngineDeps) {
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
  private source(id: string): SourceInput | null {
    return (
      this.deps.db
        .prepare<[string], SourceInput>(
          `SELECT d.id,d.title,d.content,d.content_hash AS contentHash,d.source_created_at AS sourceCreatedAt,d.source_updated_at AS sourceUpdatedAt
      FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id
      WHERE d.id=? AND COALESCE(r.deleted,0)=0`,
        )
        .get(id) ?? null
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
      versions[id] = source.contentHash;
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
          JOIN documents d ON d.id=t.source_id AND d.content_hash=t.source_revision
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
      await this.intake.intake();
      await this.intake.bootstrap();
      await this.upkeep.reviews();
      await this.upkeep.organization();
      const enqueued = await this.planner.plan();
      return { cascading: false, enqueued: enqueued + (await this.organization.plan()) };
    } finally {
      this.ticking = false;
    }
  }

  async next(batchId: string, runId: string): Promise<KnowledgeFrontierView> {
    this.batch(batchId, runId);
    if (!(await this.organization.current(batchId)))
      return { batchId, done: true, interrupted: true, items: [] };
    const result = await this.nextMaintenance(batchId, runId);
    if (!(await this.organization.current(batchId)))
      return { batchId, done: true, interrupted: true, items: [] };
    const organization = this.organization.view(batchId);
    return organization ? { ...result, organization } : result;
  }
  private async nextMaintenance(batchId: string, runId: string): Promise<KnowledgeFrontierView> {
    if (this.batch(batchId, runId).status === "abandoned")
      return { batchId, done: true, interrupted: true, items: [] };
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
        };
      const depth = Math.min(...unresolved.map((item) => item.depth));
      const offered: KnowledgeFrontierView["items"] = [];
      let remainingChars =
        cfg.maxFrontierChars - JSON.stringify({ batchId, done: false, items: [] }).length;
      for (const item of unresolved
        .filter((row) => row.depth === depth)
        .slice(0, cfg.maxFrontierNodes)) {
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
          isHistoricalKnowledgeBrief(this.deps.db, currentNode, this.deps.clock())
        ) {
          await this.settle(item, runId, "skipped", this.children(item.nodeId, item.depth));
          progressed = true;
          continue;
        }
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
          const source = item.nodeId.startsWith("source:")
            ? this.source(item.nodeId.slice(7))
            : null;
          const node = source ? null : this.deps.service.fetch(item.nodeId, true);
          const isReview = !!this.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review'",
            )
            .get(batchId, item.nodeId.startsWith("source:") ? item.nodeId.slice(7) : item.nodeId);
          // An agent already selected these repair targets while interpreting a
          // source. Do not let a second, cheaper gate discard that explicit work.
          const isDiscoveryTarget =
            !source &&
            !!this.deps.db
              .prepare(
                `SELECT 1 FROM knowledge_discovery_targets t
             JOIN knowledge_frontier f ON f.node_id='source:'||t.source_id AND f.batch_id=?
             JOIN documents d ON d.id=t.source_id AND d.content_hash=t.source_revision
             WHERE t.node_id=? LIMIT 1`,
              )
              .get(batchId, item.nodeId);
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
          const score =
            isDiscoveryTarget || isInitialRoot || rootContextUnavailable
              ? null
              : await judgeKnowledge(this.deps.decisions, source ? "discovery" : "impact", {
                  inputVersions: item.inputVersions,
                  source: source
                    ? { ...source, content: source.content.slice(0, 24000) }
                    : undefined,
                  node,
                  changedInputs: this.batchSources(batchId),
                  ...(rootOrientation ? { orientation: rootOrientation } : {}),
                });
          if (
            !isReview &&
            !isDiscoveryTarget &&
            !isInitialRoot &&
            score !== null &&
            score < 0.25 &&
            (source
              ? this.graph.arcs(sourceKey(source.id)).length === 0 &&
                listTemporalAnnotationsAwaitingRefile(this.deps.db, source.id, 1).length === 0
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
        const candidate: KnowledgeFrontierView["items"][number] = {
          id: item.nodeId,
          pendingClaimIds: pendingMaintenanceClaimIds(this.deps.db, item),
          inputFingerprint: item.inputFingerprint,
          inputVersions: item.inputVersions,
          depth: item.depth,
          ...(item.nodeId.startsWith("source:")
            ? {
                source: this.sourceExcerpt(item.nodeId.slice(7))!,
                candidates: organizationCandidatesForSource(this.deps.db, item.nodeId.slice(7)),
              }
            : { node: this.deps.service.fetch(item.nodeId, true) }),
          ...(this.roots().has(item.nodeId) ? { orientation: this.orientation() } : {}),
          review: !!this.deps.db
            .prepare(
              "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND reason='review'",
            )
            .get(batchId, item.nodeId.startsWith("source:") ? item.nodeId.slice(7) : item.nodeId),
        };
        const fitted = fitKnowledgeFrontierItem(
          candidate,
          remainingChars - 1,
          offered.length === 0,
        );
        if (!fitted) break;
        offered.push(fitted);
        remainingChars -= JSON.stringify(fitted).length + 1;
      }
      if (offered.length) return { batchId, done: false, items: offered };
    }
    return { batchId, done: false, items: [], ...(progressed ? { continuation: true } : {}) };
  }

  private batchSources(
    batchId: string,
  ): Array<{ id: string; title: string; content: string; contentHash: string }> {
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

  /** A successful canonical write, not an agent's declaration, determines changed versus unchanged. */
  async saveNode(
    batchId: string,
    runId: string,
    nodeId: string,
    inputFingerprint: string,
    input: Parameters<KnowledgeService["save"]>[0],
    reviewedClaimIds?: readonly string[],
    runFence?: import("./run-fence.js").KnowledgeRunFence,
  ) {
    this.batch(batchId, runId);
    const item = this.currentItem(batchId, nodeId, inputFingerprint);
    if (item.nodeId !== input.id || item.status !== "offered")
      throw new KnowledgeStorageError("claim_invalid", "Save must match an offered synthesis node");
    const result = await this.deps.service.save(
      {
        ...input,
        maintenance: { batchId, runId, inputFingerprint, reviewedClaimIds },
      },
      undefined,
      runFence,
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
      pending.length ? undefined : result.node.revision,
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
