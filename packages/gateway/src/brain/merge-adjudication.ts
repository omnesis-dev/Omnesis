// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Merge adjudication — the background agent's pass over pending person-merge
 * candidates the deterministic auto-approve tier left undecided.
 *
 * The deterministic tier (`autoApproveHighConfidenceCandidates`) applies the
 * structurally near-certain merges; what remains pending is, by construction,
 * what name shape alone cannot settle — family members sharing a surname,
 * brand variants, cross-channel identities. Those are decidable from context
 * (shared threads, contact cards, co-interactors), so each one becomes a
 * `merge_adjudication` run: the enqueuer turns unadjudicated pending
 * candidates into queue rows, the run prompt carries a deterministic evidence
 * pack (built here, read-handle only), and the run's single mutating tool
 * (`merge_adjudicate`) records the verdict:
 *
 *   - `merge`    → a reversible `kind:"system"` merge rule whose reason is the
 *                  model's rationale (user-visible in the merge-rules UIs);
 *   - `distinct` → the candidate is denied — a permanent veto, so the pair
 *                  stops haunting the review queue;
 *   - `unsure`   → the candidate stays for manual review, annotated with the
 *                  model's reason.
 *
 * Every verdict is re-guarded on the writer (`applyMergeAdjudication` in
 * merge-candidates.ts): self stays manual and the blob guard still blocks
 * accepts, whatever the model says.
 */

import { z } from "zod";
import { getDocumentTitlesAndSources } from "../db.js";
import { getPersonById, type PersonDetail } from "../data/repositories/PersonRepository.js";
import { getPersonDocuments } from "../data/repositories/DocumentPeopleRepository.js";
import { fetchSelfPersonId } from "../domain/InteractionScoreService.js";
import { hasInternalNameConflict } from "../domain/MergeCandidateDetector.js";
import { resolveAliasSide } from "../people.js";
import {
  getMergeCandidateById,
  isAdjudicationDue,
  listAllMergeCandidates,
  type ApplyMergeAdjudicationResult,
  type MergeCandidateRow,
} from "../merge-candidates.js";
import { getCognitionEngineState } from "./storage/engine-state.js";
import { mergeAdjudicationRunDedupeKey } from "./run-payloads.js";
import type Database from "better-sqlite3";
import type { Logger, ToolResult } from "@omnesis/core";
import type { ToolHandle } from "@omnesis/agent";
import type { WriteGate } from "../write-gate.js";
import type { Clock } from "./storage/types.js";

type Db = Database.Database;

// ── evidence pack ──────────────────────────────────────────────────────────

/** Caps keeping the pack bounded on hub/firehose people. */
const EVIDENCE_MAX_ALIASES_PER_PERSON = 30;
const EVIDENCE_MAX_RECENT_DOCS = 5;
const EVIDENCE_MAX_CO_INTERACTORS = 5;
const EVIDENCE_MAX_CO_OCCURRENCE_TITLES = 5;

/** The full equivalence class (canonical + merged losers) for a person id. */
function equivalenceClassIds(db: Db, canonicalId: string): string[] {
  const losers = db
    .prepare<[string], { id: string }>("SELECT id FROM people WHERE merged_into = ?")
    .all(canonicalId)
    .map((r) => r.id);
  return [canonicalId, ...losers];
}

/** `IN (?,?,…)` placeholder fragment for `ids`. */
function placeholders(ids: readonly string[]): string {
  return ids.map(() => "?").join(",");
}

/**
 * Top co-interactors of a person class: canonical persons sharing the most
 * documents with it, both in non-neutral roles (producer/consumer — the
 * `contact`/`mentioned` roles are excluded so contact cards and mentions
 * don't read as interaction).
 */
/**
 * Bound on the class documents the co-interactor aggregation scans. The outer
 * LIMIT only bounds output rows; without this inner cap a hub person's whole
 * document set × per-doc participant fanout would be aggregated synchronously
 * on the read handle at prompt-build time.
 */
const CO_INTERACTOR_DOC_SCAN_CAP = 2000;

function topCoInteractors(
  db: Db,
  classIds: readonly string[],
  limit: number,
): Array<{ name: string; sharedDocs: number }> {
  if (classIds.length === 0) return [];
  const ph = placeholders(classIds);
  return db
    .prepare<string[], { name: string; shared: number }>(
      `SELECT p.canonical_name AS name, COUNT(DISTINCT dp1.document_id) AS shared
         FROM (SELECT document_id FROM document_people
                WHERE person_id IN (${ph})
                  AND role NOT IN ('contact','mentioned')
                ORDER BY rowid DESC
                LIMIT ${CO_INTERACTOR_DOC_SCAN_CAP}) dp1
         JOIN document_people dp2 ON dp2.document_id = dp1.document_id
         JOIN people p0 ON p0.id = dp2.person_id
         JOIN people p ON p.id = COALESCE(p0.merged_into, p0.id)
        WHERE dp2.person_id NOT IN (${ph})
          AND dp2.role NOT IN ('contact','mentioned')
        GROUP BY COALESCE(p0.merged_into, p0.id)
        ORDER BY shared DESC
        LIMIT ${limit}`,
    )
    .all(...classIds, ...classIds)
    .map((r) => ({ name: r.name, sharedDocs: r.shared }));
}

interface CoOccurrence {
  /** Documents where both sides appear via a contact-card role/type — SAME-person evidence. */
  contactDocs: number;
  /** Documents where both sides are distinct non-neutral participants — DIFFERENT-person evidence. */
  participantDocs: number;
  sampleTitles: string[];
  /** Persons the two sides' classes have in common — the sides partially overlap already. */
  sharedIdentities: number;
}

/**
 * Same-document co-occurrence of the two sides. A shared contact card listing
 * both identifiers is exactly what SHOULD merge; both sides as separate
 * non-neutral participants on one email/chat is evidence of two people.
 *
 * Persons the two classes SHARE are excluded before the join (and the join
 * skips identical rows): a shared person co-occurring with itself on its own
 * documents is not evidence of anything, and counting it would fabricate a
 * "distinct participants" signal exactly in the multi-resolution case where
 * the verdict matters most.
 */
function coOccurrence(db: Db, classA: readonly string[], classB: readonly string[]): CoOccurrence {
  const shared = new Set(classA.filter((id) => classB.includes(id)));
  const a = classA.filter((id) => !shared.has(id));
  const b = classB.filter((id) => !shared.has(id));
  if (a.length === 0 || b.length === 0) {
    return {
      contactDocs: 0,
      participantDocs: 0,
      sampleTitles: [],
      sharedIdentities: shared.size,
    };
  }
  const rows = db
    .prepare<string[], { document_id: string; role_a: string; role_b: string }>(
      `SELECT dp1.document_id, dp1.role AS role_a, dp2.role AS role_b
         FROM document_people dp1
         JOIN document_people dp2 ON dp2.document_id = dp1.document_id
        WHERE dp1.person_id IN (${placeholders(a)})
          AND dp2.person_id IN (${placeholders(b)})
          AND dp1.person_id <> dp2.person_id
        LIMIT 500`,
    )
    .all(...a, ...b);
  const contactDocs = new Set<string>();
  const participantDocs = new Set<string>();
  for (const r of rows) {
    if (r.role_a === "contact" || r.role_b === "contact") contactDocs.add(r.document_id);
    else if (r.role_a !== "mentioned" && r.role_b !== "mentioned")
      participantDocs.add(r.document_id);
  }
  const sampleIds = [...participantDocs, ...contactDocs].slice(
    0,
    EVIDENCE_MAX_CO_OCCURRENCE_TITLES,
  );
  const titles = getDocumentTitlesAndSources(db, sampleIds);
  return {
    contactDocs: contactDocs.size,
    participantDocs: participantDocs.size,
    sampleTitles: sampleIds
      .map((id) => titles.get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => `"${t.title}" (${t.sourceId})`),
    sharedIdentities: shared.size,
  };
}

function describePerson(db: Db, person: PersonDetail): string {
  const lines: string[] = [];
  const classIds = equivalenceClassIds(db, person.id);
  const hasContactRole =
    db
      .prepare<string[], { one: number }>(
        `SELECT 1 AS one FROM document_people
          WHERE person_id IN (${placeholders(classIds)})
            AND role = 'contact' LIMIT 1`,
      )
      .get(...classIds) !== undefined;
  const onContactCard = person.source === "contacts" || hasContactRole;
  lines.push(
    `  person ${person.id} "${person.canonicalName}"` +
      ` — interactionRecent=${person.interactionScoreRecent.toFixed(4)}` +
      `, source=${person.source}` +
      `, onContactCard=${onContactCard ? "yes" : "no"}` +
      (person.isSelf ? ", IS SELF" : ""),
  );
  const aliases = person.aliases.slice(0, EVIDENCE_MAX_ALIASES_PER_PERSON);
  for (const al of aliases) {
    lines.push(`    alias ${al.aliasType}: ${al.alias}${al.sourceId ? ` (${al.sourceId})` : ""}`);
  }
  if (person.aliases.length > aliases.length) {
    lines.push(`    … ${person.aliases.length - aliases.length} more aliases (capped)`);
  }
  const docs = getPersonDocuments(db, person.id, { limit: EVIDENCE_MAX_RECENT_DOCS });
  const titles = getDocumentTitlesAndSources(
    db,
    docs.map((d) => d.id),
  );
  for (const d of docs) {
    const t = titles.get(d.id);
    if (t) lines.push(`    recent doc: "${t.title}" (${t.sourceId})`);
  }
  const co = topCoInteractors(db, classIds, EVIDENCE_MAX_CO_INTERACTORS);
  if (co.length > 0) {
    lines.push(
      `    top co-interactors: ${co.map((c) => `${c.name} (${c.sharedDocs} docs)`).join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * The deterministic evidence pack for one pending candidate, rendered as the
 * prompt section the run opens with. The caller (the run-prompt builder)
 * handles the gone/decided cases before calling this — the candidate passed
 * in is live. Read-handle only; every query is bounded by the caps above.
 */
export function buildMergeAdjudicationEvidence(db: Db, candidate: MergeCandidateRow): string {
  const lines: string[] = [];
  lines.push(
    `Merge candidate ${candidate.id} (detected ${candidate.detectedAt}):` +
      ` score=${candidate.score.toFixed(3)}, matchStrength=${candidate.matchStrength ?? "n/a"},` +
      ` matchedTokens=[${candidate.matchedTokens.join(", ")}], detection=${candidate.detectionKind}`,
  );

  const sides = [
    { label: "A", side: candidate.sideA },
    { label: "B", side: candidate.sideB },
  ];
  const classBySide: string[][] = [];
  for (const { label, side } of sides) {
    lines.push(`Side ${label}: ${side.aliasType} "${side.alias}" resolves to:`);
    const resolved = resolveAliasSide(db, side);
    const classIds: string[] = [];
    if (resolved.length === 0) lines.push("  (no person currently carries this alias)");
    for (const r of resolved) {
      const person = getPersonById(db, r.id);
      if (!person) continue;
      classIds.push(...equivalenceClassIds(db, person.id));
      lines.push(describePerson(db, person));
    }
    if (resolved.length > 1) {
      lines.push(
        `  NOTE: this side resolves to ${resolved.length} SEPARATE people — accepting the` +
          ` candidate would weld ALL of them. If any looks like a wrong rider, verdict "unsure"` +
          ` and name it.`,
      );
    }
    classBySide.push(classIds);
  }

  const co = coOccurrence(db, classBySide[0] ?? [], classBySide[1] ?? []);
  lines.push(
    `Cross-side co-occurrence: ${co.contactDocs} shared contact-card doc(s) [SAME-person signal],` +
      ` ${co.participantDocs} doc(s) with both sides as distinct participants` +
      ` [DIFFERENT-person signal]${co.sampleTitles.length > 0 ? ` — e.g. ${co.sampleTitles.join("; ")}` : ""}`,
  );
  if (co.sharedIdentities > 0) {
    lines.push(
      `NOTE: the two sides already share ${co.sharedIdentities} resolved identit${co.sharedIdentities === 1 ? "y" : "ies"}` +
        ` — they partially overlap, and co-occurrence above covers only the non-shared remainder.`,
    );
  }

  const bagA = resolveAliasSide(db, candidate.sideA, { withDetails: true }).flatMap(
    (p) => p.aliases ?? [],
  );
  const bagB = resolveAliasSide(db, candidate.sideB, { withDetails: true }).flatMap(
    (p) => p.aliases ?? [],
  );
  const blobA = hasInternalNameConflict(bagA);
  const blobB = hasInternalNameConflict(bagB);
  if (blobA || blobB) {
    lines.push(
      `Deterministic guard note: side ${blobA && blobB ? "A and B carry" : blobA ? "A carries" : "B carries"}` +
        ` internally conflicting name aliases (a possible multi-person blob). A "merge" verdict` +
        ` will be REFUSED by the writer guard; if you judge them the same person anyway, answer` +
        ` "unsure" and explain, so the operator sees your reasoning.`,
    );
  }
  return lines.join("\n");
}

// ── enqueuer ───────────────────────────────────────────────────────────────

/** Engine-state marker key for the enqueuer's last-fire time. */
export const MERGE_ADJUDICATION_LAST_RUN_KEY = "merge-adjudication:last-run";

/** Minimum time between enqueue passes. */
export const MERGE_ADJUDICATION_CADENCE_MS = 15 * 60_000;

/**
 * Per-pass enqueue cap. Bounds the pending-run queue while the backlog
 * drains (runs serialize on the drainer); the next pass picks up the rest.
 */
export const MERGE_ADJUDICATION_MAX_PER_PASS = 40;

export interface MergeAdjudicationEnqueuerDeps {
  db: Db;
  writeGate: Pick<WriteGate, "enqueueCognitionRun" | "setCognitionEngineState">;
  clock: Clock;
  log: Logger;
  idGen?: () => string;
}

/**
 * One due-gated pass: enqueue a `merge_adjudication` run for each pending
 * candidate that either has never been judged, or whose evidence has changed
 * since the verdict that covers it. A verdict is bound to the evidence it saw
 * (`adjudication_evidence_fingerprint`), so re-judging happens when there is
 * something new to judge — never because a timestamp moved.
 *
 * Self-touching candidates are skipped — a wrong self-merge silently corrupts
 * first-person answers, so self stays entirely manual. Marker written LAST so
 * a crash replays into the per-candidate dedupe fold.
 */
export async function runMergeAdjudicationEnqueuePass(
  deps: MergeAdjudicationEnqueuerDeps,
): Promise<{ fired: number }> {
  const now = deps.clock();
  const lastRaw = getCognitionEngineState(deps.db, MERGE_ADJUDICATION_LAST_RUN_KEY);
  const last = lastRaw === null ? 0 : Number(lastRaw);
  if (Number.isFinite(last) && now - last < MERGE_ADJUDICATION_CADENCE_MS) return { fired: 0 };

  const selfId = fetchSelfPersonId(deps.db);
  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  // Oldest evidence first, so a capped pass drains the backlog deterministically
  // instead of letting whatever row order the table returns starve newcomers.
  const due = listAllMergeCandidates(deps.db, "pending")
    .filter((c) => isAdjudicationDue(c))
    .sort((x, y) => x.detectedAt.localeCompare(y.detectedAt));
  let fired = 0;
  for (const cand of due) {
    if (fired >= MERGE_ADJUDICATION_MAX_PER_PASS) break;
    if (selfId) {
      const touchesSelf = [cand.sideA, cand.sideB].some((side) =>
        resolveAliasSide(deps.db, side).some((p) => p.id === selfId),
      );
      if (touchesSelf) continue;
    }
    await deps.writeGate.enqueueCognitionRun(
      {
        id: `run_${idGen()}`,
        kind: "merge_adjudication",
        payload: { candidateId: cand.id },
        dedupeKey: mergeAdjudicationRunDedupeKey(cand.id),
      },
      now,
    );
    fired += 1;
  }
  await deps.writeGate.setCognitionEngineState(MERGE_ADJUDICATION_LAST_RUN_KEY, String(now));
  if (fired > 0) deps.log.info(`merge adjudication: ${fired} candidate run(s) enqueued`);
  return { fired };
}

// ── the verdict tool ───────────────────────────────────────────────────────

const mergeAdjudicateSchema = z
  .object({
    verdict: z.enum(["merge", "distinct", "unsure"]),
    /**
     * User-visible rationale. On `merge` it becomes the merge rule's reason
     * shown in the portal/iOS/Android merge-rules UIs — one or two concrete
     * sentences citing the decisive evidence.
     */
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export interface MergeAdjudicationToolDeps {
  db: Db;
  writeGate: Pick<WriteGate, "applyMergeAdjudication">;
  /** The run this tool executes inside (stamped onto the candidate + rule). */
  runId: string;
  /** The one candidate this run may adjudicate — anything else is refused. */
  candidateId: string;
  /**
   * Fingerprint of the candidate's evidence as the run's prompt presented it,
   * captured when the toolset is assembled. The verdict is bound to this
   * rather than to whatever the row holds by the time the model answers.
   */
  judgedEvidenceFingerprint?: string;
  log: Logger;
}

function describeOutcome(res: ApplyMergeAdjudicationResult): string {
  switch (res.outcome) {
    case "merged":
      return "verdict recorded; merge rule created (reversible in the merge-rules UI)";
    case "already_merged":
      return "verdict recorded; the sides had already collapsed to one person";
    case "denied":
      return "verdict recorded; candidate denied (permanent veto — never re-proposed)";
    case "recorded":
      return "verdict recorded; candidate left for manual review";
    case "guard_blocked":
      return "verdict recorded, but the writer guard refused the merge (self or blob protection); candidate left for manual review";
    case "not_pending":
      return "no-op: the candidate is no longer pending";
    case "not_found":
      return "no-op: the candidate no longer exists";
  }
}

/**
 * The single mutating tool a `merge_adjudication` run gets. Scoped to the
 * run's own candidate; the writer re-guards every accept, so a confused or
 * adversarial verdict can never grow a blob or touch self.
 */
export function buildMergeAdjudicationTool(deps: MergeAdjudicationToolDeps): ToolHandle {
  return {
    name: "merge_adjudicate",
    description:
      "Record your verdict on THIS run's merge candidate. Call it exactly once, " +
      "after weighing the evidence. verdict `merge` = same real-world identity → " +
      "a reversible system merge rule is created carrying your reason (shown to " +
      "the user); `distinct` = different identities → the proposal is permanently " +
      "denied and never re-proposed; `unsure` = the evidence genuinely cannot " +
      "settle it (relatives sharing a surname, a poisoned side, thin data) → it " +
      "stays for the user, annotated with your reason.",
    schema: mergeAdjudicateSchema,
    mutates: true,
    summarize: (args) => (args as { verdict?: string })?.verdict,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = mergeAdjudicateSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          kind: "error",
          code: "invalid_args",
          message: issue?.message ?? "invalid arguments",
        };
      }
      const { verdict, reason } = parsed.data;
      // Fingerprint the sides' resolution at verdict time, so the writer can
      // refuse a merge if a person gained one of the aliases mid-run — the
      // model would be welding someone its evidence never showed.
      const cand = getMergeCandidateById(deps.db, deps.candidateId);
      const expectedPersonIds = cand
        ? [
            ...new Set(
              [cand.sideA, cand.sideB].flatMap((side) =>
                resolveAliasSide(deps.db, side).map((p) => p.id),
              ),
            ),
          ]
        : [];
      const res = await deps.writeGate.applyMergeAdjudication({
        candidateId: deps.candidateId,
        verdict,
        reason,
        runId: deps.runId,
        expectedPersonIds,
        // The evidence as the run's pack presented it. A detector pass landing
        // between that pack and this verdict must leave its new evidence due,
        // not silently covered by a judgment made without it.
        ...(deps.judgedEvidenceFingerprint === undefined
          ? {}
          : { judgedEvidenceFingerprint: deps.judgedEvidenceFingerprint }),
      });
      deps.log.info(
        `merge adjudication run ${deps.runId}: candidate ${deps.candidateId} → ${verdict} (${res.outcome})`,
      );
      return {
        kind: "structured",
        resultType: "merge_adjudication.recorded",
        data: {
          candidateId: deps.candidateId,
          verdict,
          outcome: res.outcome,
          detail: describeOutcome(res),
        },
      };
    },
  };
}
