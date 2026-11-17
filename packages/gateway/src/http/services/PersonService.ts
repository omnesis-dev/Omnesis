// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import {
  getDocumentPeople,
  getDocumentsPeopleSummary,
  getPersonById,
  searchPeople,
  getPersonDocuments,
  getSelfPersonId,
  getPeopleStats,
  listMergeRules,
  countMergeRules,
  type PeopleStats,
  type CreateMergeRuleInput,
  type MergeRuleAliasType,
  type MergeRuleKind,
  type MergeWinnerSide,
} from "../../people.js";
import {
  computeEnrichedMergeCandidates,
  countMergeCandidates,
  explainMergeCandidateVisibility,
  type EnrichedMergeCandidatesResult,
  type MergeCandidateClusterCursor,
  type MergeCandidateVisibility,
} from "../../merge-candidates.js";
import {
  countLiveDependentsForAnnotation,
  listLiveDependentsForAnnotation,
} from "../../brain/storage/consumption-edges.js";
import {
  listLivePersonAnnotationsForPerson,
  personAnnotationIdsOnExcludedSources,
} from "../../brain/storage/person-annotations.js";
import { resolvePersonId } from "../../domain/PeopleResolutionService.js";
import {
  listMergeRuleGroups,
  type MergeRuleGroupsOptions,
  type MergeRuleGroupsPage,
} from "../../domain/merge/rule-groups.js";
import { ValidationError } from "../errors.js";
import { listSelfIdentitySources } from "../../self-identity-sources.js";
import { matchDocumentIdPrefix } from "../../data/like-prefix-seek.js";
import type {
  PersonBrowseCursor,
  PersonSortBy,
  PersonSummary,
} from "../../data/repositories/PersonRepository.js";
import type { PersonDocumentEntry } from "../../data/repositories/DocumentPeopleRepository.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * The read-worker capabilities {@link PersonService} delegates its heavy reads
 * to. `browsePeople` powers GET /people; `enrichedMergeCandidates` powers GET
 * /people/merge-candidates; `mergeRuleGroups` powers GET
 * /people/merge-rule-groups. Absent a gate (tests, minimal servers) the
 * service falls back to a synchronous read on its own handle. The full `IoGate`
 * from the scheduler structurally satisfies this.
 */
export interface PeopleBrowseGate {
  browsePeople(
    query: string,
    limit: number,
    options: { sortBy?: PersonSortBy; after?: PersonBrowseCursor },
  ): Promise<PersonSummary[]>;
  personDocuments?(
    personId: string,
    options: NonNullable<Parameters<typeof getPersonDocuments>[2]>,
  ): Promise<PersonDocumentEntry[]>;
  enrichedMergeCandidates?(opts: {
    status: "pending" | "accepted" | "denied";
    limit: number;
    clusterLimit?: number;
    clusterAfter?: MergeCandidateClusterCursor;
    q?: string;
  }): Promise<EnrichedMergeCandidatesResult>;
  mergeCandidateVisibility?(opts: {
    status: "pending" | "accepted" | "denied";
  }): Promise<MergeCandidateVisibility[]>;
  mergeRuleGroups?(opts: MergeRuleGroupsOptions): Promise<MergeRuleGroupsPage>;
}

const log = createLogger("gateway:people");

/**
 * How long a user-facing merge mutation waits for the fast-lane
 * equivalence apply before responding anyway. On timeout the apply keeps
 * running in the background — it is OCC-guarded and idempotent, and the
 * periodic eval remains the reconciliation net — so the request never
 * hangs on a congested gateway.
 */
export const FAST_APPLY_TIMEOUT_MS = 5_000;

export class PersonService {
  constructor(
    private readonly db: Db,
    private readonly writeGate: WriteGate,
    private readonly hooks: {
      /**
       * Kicks the merge-rules eval task — the reconciliation net behind
       * the fast lane below. The fast lane usually materializes the
       * mutation first; the kicked tick then verifies it is caught up
       * (and, when the fast lane timed out or is absent, applies the
       * mutation itself instead of waiting out the idle backoff).
       */
      wakeMergeEval?: () => void;
      /**
       * The user-action fast lane: recompute + apply the merge-rule
       * equivalences NOW, at the calling request's (user) priority, so a
       * human-issued merge/undo materializes before the response instead
       * of queueing behind background work. Absent (tests, minimal
       * servers) the mutation falls back to the periodic eval alone.
       */
      fastApplyMergeRules?: () => Promise<void>;
      /** `brain.excludedSources`, read live; annotations resting on one are labelled. */
      getBrainExcludedSources?: () => readonly string[];
    } = {},
    /** Read-worker gate. When present, {@link browse} runs the heavy people
     *  query off the main event loop; absent (tests, minimal servers) it
     *  falls back to a synchronous main-thread read. */
    private readonly ioGate?: PeopleBrowseGate,
  ) {}

  private wakeMergeEval(): void {
    this.hooks.wakeMergeEval?.();
  }

  /**
   * The in-flight fast-lane apply, if any, plus whether another mutation
   * arrived while it ran. Concurrent mutations (a bulk undo fires one
   * DELETE per identity in parallel) coalesce onto the in-flight apply
   * and at most one trailing re-run — every apply recomputes from ALL
   * active rules, so one pass covers however many mutations preceded it.
   */
  private fastApplyInFlight: Promise<void> | null = null;
  private fastApplyRerun = false;

  /**
   * Await the fast-lane apply, bounded by {@link FAST_APPLY_TIMEOUT_MS}
   * and never throwing — a user mutation must not fail or hang because
   * the materialization lagged; the rule row is already durable and the
   * periodic eval will catch up.
   */
  private async fastApplyMergeRules(): Promise<void> {
    const fast = this.hooks.fastApplyMergeRules;
    if (!fast) return;
    if (this.fastApplyInFlight) {
      // A pass is already running; it may have snapshotted the rules
      // before this mutation's write. Request one trailing re-run and
      // share the in-flight wait.
      this.fastApplyRerun = true;
    } else {
      this.fastApplyInFlight = (async () => {
        try {
          do {
            this.fastApplyRerun = false;
            await fast();
          } while (this.fastApplyRerun);
        } catch (err) {
          log.warn(
            `fast merge-rules apply failed (periodic eval will catch up): ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          this.fastApplyInFlight = null;
        }
      })();
    }
    const inFlight = this.fastApplyInFlight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            log.info(
              `fast merge-rules apply still running after ${FAST_APPLY_TIMEOUT_MS}ms — responding; the periodic eval reconciles`,
            );
            resolve();
          }, FAST_APPLY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Validate + coerce a request body into a CreateMergeRuleInput. Throws ValidationError on bad input. */
  parseCreateMergeRuleInput(body: unknown): CreateMergeRuleInput {
    if (!body || typeof body !== "object") {
      throw new ValidationError("Request body must be an object");
    }
    const b = body as Record<string, unknown>;
    const sideA = b.sideA as Record<string, unknown> | undefined;
    const sideB = b.sideB as Record<string, unknown> | undefined;
    if (!sideA || !sideB) throw new ValidationError("sideA and sideB are required");
    const validTypes: MergeRuleAliasType[] = ["email", "phone", "lid", "name"];
    for (const [name, side] of [
      ["sideA", sideA],
      ["sideB", sideB],
    ] as const) {
      if (
        typeof side.aliasType !== "string" ||
        !validTypes.includes(side.aliasType as MergeRuleAliasType)
      ) {
        throw new ValidationError(`${name}.aliasType must be one of ${validTypes.join("/")}`);
      }
      if (typeof side.alias !== "string" || side.alias.trim().length === 0) {
        throw new ValidationError(`${name}.alias must be a non-empty string`);
      }
    }
    if (b.winnerSide !== "a" && b.winnerSide !== "b") {
      throw new ValidationError("winnerSide must be 'a' or 'b'");
    }
    const aTrim = (sideA.alias as string).trim();
    const bTrim = (sideB.alias as string).trim();
    const kind: MergeRuleKind = b.kind === "system" ? "system" : "user";
    if (kind === "user" && sideA.aliasType === sideB.aliasType && aTrim === bTrim) {
      throw new ValidationError("sideA and sideB must reference different aliases");
    }
    return {
      sideA: { aliasType: sideA.aliasType as MergeRuleAliasType, alias: aTrim },
      sideB: { aliasType: sideB.aliasType as MergeRuleAliasType, alias: bTrim },
      winnerSide: b.winnerSide as MergeWinnerSide,
      reason: typeof b.reason === "string" ? b.reason : null,
      kind,
      createdBy: typeof b.createdBy === "string" ? b.createdBy : null,
    };
  }

  async createMergeRule(input: CreateMergeRuleInput) {
    const result = await this.writeGate.createMergeRule(input);
    if (result.created) {
      this.wakeMergeEval();
      await this.fastApplyMergeRules();
    }
    return result;
  }

  async deleteMergeRule(id: string): Promise<{ deleted: boolean }> {
    const ok = await this.writeGate.deleteMergeRule(id);
    if (ok) {
      this.wakeMergeEval();
      await this.fastApplyMergeRules();
    }
    return { deleted: ok };
  }

  async deleteMergeRuleGroup(groupId: string): Promise<{ deleted: number }> {
    const deleted = await this.writeGate.deleteMergeRuleGroup(groupId);
    if (deleted > 0) {
      this.wakeMergeEval();
      await this.fastApplyMergeRules();
    }
    return { deleted };
  }

  async merge(
    winnerId: string,
    loserId: string,
  ): Promise<{ merged: true; winnerId: string; loserId: string }> {
    await this.writeGate.mergePeople(winnerId, loserId);
    return { merged: true, winnerId, loserId };
  }

  async rebuild(): Promise<void> {
    await this.writeGate.rebuildPeopleFromDocuments(listSelfIdentitySources());
  }

  async acceptCandidate(input: {
    candidateId: string;
    winnerSide: MergeWinnerSide;
    reason: string | null;
  }) {
    const result = await this.writeGate.acceptMergeCandidate(input);
    if (result.ruleCreated) {
      this.wakeMergeEval();
      await this.fastApplyMergeRules();
    }
    return result;
  }

  async denyCandidate(candidateId: string) {
    return this.writeGate.denyMergeCandidate(candidateId);
  }

  /** Unify a cluster of people (grouped candidate card) into one identity. */
  async mergeCluster(personIds: string[], opts?: { reason?: string | null }) {
    const result = await this.writeGate.mergeCluster(personIds, { reason: opts?.reason ?? null });
    if (result.rulesCreated > 0) {
      this.wakeMergeEval();
      await this.fastApplyMergeRules();
    }
    return result;
  }

  bulkAssignDocumentsSummary(ids: string[]) {
    return getDocumentsPeopleSummary(this.db, ids);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Read-side passthroughs (routes only call services).
  // ───────────────────────────────────────────────────────────────────────

  /**
   * People browse for GET /people. The query is joined and ~O(people); on the
   * main event loop it froze every other request for seconds. Route it through
   * the read-worker pool (user priority) when a gate is wired, so the loop
   * stays free; fall back to the synchronous read otherwise.
   */
  async browse(
    q: string,
    limit: number,
    opts: { sortBy?: PersonSortBy; after?: PersonBrowseCursor },
  ): Promise<PersonSummary[]> {
    return this.ioGate
      ? this.ioGate.browsePeople(q, limit, opts)
      : searchPeople(this.db, q, limit, opts);
  }

  getById(id: string) {
    return getPersonById(this.db, id);
  }

  canonicalId(id: string): string {
    return resolvePersonId(this.db, id);
  }

  getSelfId() {
    return getSelfPersonId(this.db);
  }

  getStats(): PeopleStats {
    // Base people-table counts, augmented with the merge-queue summary the
    // People list view badges. Both counts are cheap COUNT(*) primitives —
    // no enrichment/ranking — so this stays a lightweight per-visit call.
    return {
      ...getPeopleStats(this.db),
      pendingMergeCandidates: countMergeCandidates(this.db, "pending"),
      mergeRules: countMergeRules(this.db, { active: true }),
    };
  }

  /** A page of a person's documents, read off the main thread when a gate is wired. */
  async getDocuments(
    id: string,
    opts: NonNullable<Parameters<typeof getPersonDocuments>[2]>,
  ): Promise<PersonDocumentEntry[]> {
    return this.ioGate?.personDocuments
      ? this.ioGate.personDocuments(id, opts)
      : getPersonDocuments(this.db, id, opts);
  }

  getForDocument(id: string) {
    return getDocumentPeople(this.db, id);
  }

  resolveDocumentPeople(idPrefix: string): {
    matches: string[];
    people: ReturnType<typeof getDocumentPeople>;
  } {
    const matches = matchDocumentIdPrefix(this.db, idPrefix);
    return {
      matches,
      people: matches.length === 1 ? getDocumentPeople(this.db, matches[0]!) : [],
    };
  }

  listAnnotations(
    personId: string,
    options: {
      limit: number;
      before?: { sortAt: number; id: string };
      includeDependents: boolean;
    },
  ): {
    canonicalId: string;
    items: Array<{
      id: string;
      claimType: string;
      claimText: string;
      evidenceDocId: string;
      evidenceQuote: string;
      confidence: number;
      claimBasis: string;
      createdAt: string;
      verificationState: string | null;
      lastVerifiedAt: string | null;
      /** Set when the background re-check never revisits this row; its stored state is not current. */
      notRechecked?: "source_excluded";
      dependentCount: number;
      dependents?: Array<{ kind: "observation" | "loop"; id: string; title: string }>;
      sortAt: number;
    }>;
    hasMore: boolean;
  } {
    const canonicalId = resolvePersonId(this.db, personId);
    const probe = listLivePersonAnnotationsForPerson(this.db, canonicalId, {
      limit: options.limit + 1,
      ...(options.before ? { before: options.before } : {}),
    });
    const hasMore = probe.length > options.limit;
    const annotations = hasMore ? probe.slice(0, options.limit) : probe;
    const onExcludedSource = personAnnotationIdsOnExcludedSources(
      this.db,
      annotations.map((annotation) => annotation.id),
      this.hooks.getBrainExcludedSources?.() ?? [],
    );
    return {
      canonicalId,
      hasMore,
      items: annotations.map((annotation) => {
        const dependents = options.includeDependents
          ? listLiveDependentsForAnnotation(this.db, "person", annotation.id)
          : null;
        return {
          id: annotation.id,
          claimType: annotation.claimType,
          claimText: annotation.claimText,
          evidenceDocId: annotation.evidenceDocId,
          evidenceQuote: annotation.evidenceQuote,
          confidence: annotation.confidence,
          claimBasis: annotation.claimBasis,
          createdAt: new Date(annotation.createdAt).toISOString(),
          verificationState: annotation.verificationState,
          lastVerifiedAt:
            annotation.lastVerifiedAt === null
              ? null
              : new Date(annotation.lastVerifiedAt).toISOString(),
          ...(onExcludedSource.has(annotation.id)
            ? { notRechecked: "source_excluded" as const }
            : {}),
          dependentCount:
            dependents?.length ??
            countLiveDependentsForAnnotation(this.db, "person", annotation.id),
          ...(dependents
            ? {
                dependents: dependents.map((dependent) => ({
                  kind: dependent.kind,
                  id: dependent.id,
                  title: dependent.title,
                })),
              }
            : {}),
          sortAt: annotation.updatedAt ?? annotation.createdAt,
        };
      }),
    };
  }

  listMergeRules(opts: {
    active?: boolean;
    kind?: MergeRuleKind;
    withResolved?: boolean;
    withDetails?: boolean;
    preMerge?: boolean;
    touchesPersonId?: string;
    limit?: number;
    beforeCreated?: { createdAt: string; id: string };
  }) {
    return listMergeRules(this.db, opts);
  }

  /**
   * Page the merge-rule audit by whole identity (see `listMergeRuleGroups`).
   * Grouping resolves every active rule's winner, so the read runs on an io
   * worker when a gate is wired; absent one it reads on the service's handle.
   */
  async listMergeRuleGroups(opts: MergeRuleGroupsOptions): Promise<MergeRuleGroupsPage> {
    return this.ioGate?.mergeRuleGroups
      ? this.ioGate.mergeRuleGroups(opts)
      : listMergeRuleGroups(this.db, opts);
  }

  /**
   * Render the merge-candidates list with per-side resolved-person info
   * and a composite rank score so the portal's queue surfaces the
   * pairs the user actually cares about. The whole-pending scan + union-find
   * ranking (up to 5000 candidates) runs on the read-worker pool when a gate is
   * wired, so it never freezes the main event loop; absent a gate it falls back
   * to the synchronous read.
   */
  async listEnrichedCandidates(opts: {
    status: "pending" | "accepted" | "denied";
    limit: number;
    clusterLimit?: number;
    clusterAfter?: MergeCandidateClusterCursor;
    q?: string;
  }): Promise<EnrichedMergeCandidatesResult> {
    return this.ioGate?.enrichedMergeCandidates
      ? this.ioGate.enrichedMergeCandidates(opts)
      : computeEnrichedMergeCandidates(this.db, opts);
  }

  /**
   * Why the merge queue does or does not show each candidate of a status — the
   * view-layer vetoes, made legible. Same per-side resolution and gate
   * evaluation as the enriched list, so it runs on the read-worker pool for the
   * same reason; the accepted and denied sets are never pruned, which makes
   * this the one of the two whose scan grows without bound.
   */
  async explainCandidateVisibility(opts: {
    status: "pending" | "accepted" | "denied";
  }): Promise<MergeCandidateVisibility[]> {
    return this.ioGate?.mergeCandidateVisibility
      ? this.ioGate.mergeCandidateVisibility(opts)
      : explainMergeCandidateVisibility(this.db, opts);
  }
}
