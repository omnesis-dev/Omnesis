// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
} from "../decision-payload.js";
import {
  WIKI_VALUE_RUBRIC_VERSION,
  WIKI_REPAIR_RUBRIC_VERSION,
} from "../record-check/wiki-rubric.js";
import { wikiFactualRepairSnapshot, type WikiRepairAssessment } from "./wiki-factual-repair.js";
import { parseClaimMarkup } from "./claims.js";
import { readKnowledgeCollectionRevision } from "./reconciliation.js";
import { getKnowledgeNode } from "./storage.js";
import { KnowledgeDependencyVersions } from "./storage-validation.js";
import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type { WikiRecordContext } from "../record-check/wiki-context.js";
import type { CheckRecord } from "../record-check/check.js";
import type { KnowledgeService } from "./service.js";
import type { BrainSourceFence } from "../source-exclusion.js";

const MAX_DRAFT = 24_000;
const MAX_REFERENCES = 128;

/** Run-local optimization; final publication still owns atomic dependency/collection checks. */
export class WikiValueCheck {
  private readonly memo = new Map<string, Awaited<ReturnType<CheckRecord>>>();
  constructor(
    private readonly service: KnowledgeService,
    private readonly check?: CheckRecord,
    /** A background run's excluded sources, whose documents the judge is never shown. */
    private readonly sourceFence?: BrainSourceFence,
  ) {}

  async assess(
    node: SaveKnowledgeNodeInput,
    signal?: AbortSignal,
  ): Promise<WikiRepairAssessment | undefined> {
    const repair = node.maintenance?.curationDeferral?.factualRepair;
    if (
      repair &&
      (!this.check ||
        this.check.needsDocumentContext?.() === false ||
        this.check.enforcesOutcomePolicy?.() === false)
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Factual repair requires an available enforcing repair-integrity decision",
      );
    if (node.kind !== "wiki" || !this.check || this.check.needsDocumentContext?.() === false)
      return undefined;
    const parsed = parseClaimMarkup(node.markdown);
    const db = this.service.deps.db;
    const snapshot = db.transaction(() => {
      const previous = getKnowledgeNode(db, node.id);
      if (
        !repair &&
        previous &&
        previous.title === node.title &&
        previous.plainText === parsed.text
      )
        return null;
      const repairSnapshot = repair ? wikiFactualRepairSnapshot(db, node) : undefined;
      const generation = decisionPayloadErasureGeneration(db);
      const refs = [
        ...new Map(
          parsed.claims.flatMap((claim) => claim.refs).map((ref) => [ref.raw, ref]),
        ).values(),
      ];
      const sourceIds = refs.filter((ref) => ref.kind === "source").map((ref) => ref.id);
      const nodeIds = refs.filter((ref) => ref.kind !== "source").map((ref) => ref.id);
      if (previous) nodeIds.push(previous.id);
      const capture = captureDecisionPayloadSubjects(
        db,
        { sourceIds: [...new Set(sourceIds)], nodeIds: [...new Set(nodeIds)] },
        generation,
      );
      const excluded = this.sourceFence?.excludedDocuments(sourceIds);
      const references: WikiRecordContext["references"] = [];
      const versions: Record<string, string | number> = {};
      if (refs.length <= MAX_REFERENCES) {
        const dependencyVersions = new KnowledgeDependencyVersions(node.inputVersions);
        dependencyVersions.run(
          () => {
            for (const ref of refs) {
              const view = this.service.reference(ref.raw);
              dependencyVersions.check(ref.raw, view.revision);
              versions[ref.raw] = view.revision;
              if (references.length < 16 && !(ref.kind === "source" && excluded?.has(ref.id)))
                references.push({
                  ref: ref.raw,
                  text: view.text.slice(0, 1000),
                  truncated: view.text.length > 1000,
                });
            }
          },
          () => refs.map((ref) => ref.raw),
          (ref) => this.service.reference(ref).revision,
        );
      }
      const context: WikiRecordContext | undefined =
        capture &&
        parsed.text.length <= MAX_DRAFT &&
        node.title.length <= 500 &&
        refs.length <= MAX_REFERENCES
          ? {
              title: node.title,
              ...(repair && repairSnapshot && previous
                ? {
                    factualRepair: {
                      claimIds: repair.claimIds,
                      beforeMarkup: previous.markdown,
                      afterMarkup: node.markdown,
                      beforeStates: repairSnapshot.beforeStates,
                      afterStates: repairSnapshot.afterStates,
                    },
                  }
                : {}),
              ...(previous
                ? {
                    previous: {
                      title: previous.title.slice(0, 500),
                      text: previous.plainText.slice(0, MAX_DRAFT),
                      truncated: previous.plainText.length > MAX_DRAFT,
                    },
                  }
                : {}),
              references,
              referencesOmitted: Math.max(0, refs.length - references.length),
            }
          : undefined;
      if (repair && (!context || JSON.stringify(context).length > 128_000))
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Factual repair needs complete bounded comparison context; narrow the operation without dropping unrelated meaning",
        );
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            repair ? WIKI_REPAIR_RUBRIC_VERSION : WIKI_VALUE_RUBRIC_VERSION,
            this.check!.policyKey?.(),
            node,
            versions,
            capture,
            previous?.revision,
            readKnowledgeCollectionRevision(db, "wiki_scope"),
          ]),
        )
        .digest("hex");
      return {
        key,
        context,
        generation,
        repairSnapshot,
        policy: this.check!.policyKey?.(),
        capture,
        documentId:
          capture?.subjects.find((subject) => subject.kind === "source")?.id ??
          sourceIds[0] ??
          node.id,
      };
    })();
    if (!snapshot) return undefined;
    const result =
      this.memo.get(snapshot.key) ??
      (await this.check(
        {
          recordId: node.id,
          documentId: snapshot.documentId,
          record: {
            type: "wiki",
            kind: repair
              ? "factual_repair"
              : node.expectedRevision === 0
                ? "publication"
                : "revision",
            text: parsed.text.slice(0, MAX_DRAFT),
          },
          ...(snapshot.context ? { wikiContext: snapshot.context } : {}),
          ...(snapshot.capture ? { payloadCapture: snapshot.capture } : {}),
        },
        signal,
      ));
    // No off/shadow/outage caching: only completed enforced assessments can authorize reuse.
    if (!result.save || result.assessment) {
      this.memo.set(snapshot.key, result);
      while (this.memo.size > 64) this.memo.delete(this.memo.keys().next().value!);
    }
    if (repair) {
      if (
        !snapshot.context ||
        !snapshot.repairSnapshot ||
        !result.save ||
        result.assessment?.rubricVersion !== WIKI_REPAIR_RUBRIC_VERSION ||
        !snapshot.policy ||
        result.assessment.policy !== snapshot.policy ||
        this.check.policyKey?.() !== snapshot.policy
      )
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Factual repair not authorized: a completed enforced repair-integrity pass is required. Keep the page and pending work unchanged; do not pad prose or reinterpret an unavailable assessment as approval.",
        );
      return {
        fingerprint: snapshot.repairSnapshot.fingerprint,
        policy: result.assessment.policy,
        decisionId: result.assessment.decisionId,
        rubricVersion: WIKI_REPAIR_RUBRIC_VERSION,
        erasureGeneration: snapshot.generation,
      };
    }
    if (!result.save)
      throw new KnowledgeStorageError(
        "claim_invalid",
        `Wiki not saved: synthesis value score ${result.score.toFixed(2)} is below ${result.threshold}. The actual draft does not establish useful cross-source synthesis. Keep a new candidate unpublished or deferred, or enrich an existing useful account. Do not pad headings, references or prose or invent stronger claims to pass. Existing page content and pending work are unchanged. If bounded investigation finds no useful improvement, stop rewriting: for an existing wiki review, reread its exact current editing snapshot, review every offered claim against current evidence, and record the unchanged page with knowledge_edit and no edits (or knowledge_save of the unchanged title and visible markdown) with curationDeferral={reasonCode:"insufficient_useful_context",reason:"Explain missing useful context"} instead of placementAssessment. Supporting references may be replaced with a bounded set of current evidence references with current positively verified proof, without changing claim text or semantics. If a necessary factual correction changes prose, explicitly request curationDeferral.factualRepair={claimIds:[changed existing claim IDs]}; preserve title, headings and unrelated meaning. This requires a separate repair-integrity decision instead of value admission for that proposal and positive factual proof; it never authorizes new pages or deletion. This schedules later curation and does not bypass factual validation. Decision: ${result.decisionId}`,
      );
    return undefined;
  }
}
