// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed payloads for Agent Run Queue rows. The queue itself stores
 * payloads opaquely (`payload_json`); producers (the waker) build them
 * through these types and consumers (the run driver's prompt builder,
 * the waker's fold path) re-validate through the zod schemas —
 * zod-at-boundary for data that round-trips through SQLite.
 *
 * `data` payloads may carry two transient fields that must never
 * outlive the run (the no-prior-version-storage rule):
 *   - `diff` — unified previous-vs-current content diff, computed at
 *     enqueue time so the agent sees exactly what changed;
 *   - `snapshot` — the pre-update body captured at first enqueue, kept
 *     ONLY so a further update folding into the pending row can
 *     recompute a diff spanning both edits.
 * When a run settles (`completeCognitionRun` / terminal
 * `failCognitionRun`) those two fields are removed and the rest of the
 * payload — reference-shaped ids, ranges, prompts — is retained, so a
 * settled row still decodes to a meaningful trigger on the operator
 * surfaces.
 */

import { z } from "zod";
import { MAX_CHANGED_ADDRESSED_ENTRY_IDS } from "./addressed-entry-context.js";
import type { CognitionRunKind } from "./storage/types.js";

/**
 * Dedupe-key prefixes, one per fold-key family. Exported so the display
 * layer (`run-payload-view.ts`) can recover a coarse trigger from the
 * surviving `dedupe_key` of a legacy settled row whose payload was wiped
 * to `{}` before settled rows started retaining their payloads.
 */
export const DATA_DOC_DEDUPE_PREFIX = "data:doc:";
export const DATA_THREAD_DEDUPE_PREFIX = "data:thread:";
export const DAILY_SOURCE_DEDUPE_PREFIX = "daily:source:";
export const MAY_DAY_DEDUPE_PREFIX = "daily:mayday:";
export const DIGEST_DEDUPE_PREFIX = "daily:digest:";
export const FEEDBACK_DEDUPE_PREFIX = "feedback:brief:";

/** Fold key for `data` runs: at most one pending run per document. */
export function dataRunDedupeKey(docId: string): string {
  return `${DATA_DOC_DEDUPE_PREFIX}${docId}`;
}

/**
 * Fold key for `data` runs keyed on a source-scoped THREAD identity rather
 * than a single document — so every message arriving in one email thread
 * (each a distinct document) folds into a single pending run and the agent
 * reacts once to the settled thread instead of per message. `threadKey` is
 * the source-scoped thread identity the waker computes
 * (`<sourceId>:<threadId>`); thread ids are only unique within a source, so
 * the scope must be baked in before it reaches here.
 */
export function dataRunThreadDedupeKey(threadKey: string): string {
  return `${DATA_THREAD_DEDUPE_PREFIX}${threadKey}`;
}

export const cognitionDataRunPayloadSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const value = { ...(input as Record<string, unknown>) };
    // Two keys the retired watch evaluator wrote: the evaluations a run had to
    // settle, and the subset of them belonging to operator watches. Nothing
    // produces them and nothing reads them.
    //
    // Dropped here rather than from the object below, because the object is
    // `.strict()` and settled rows deliberately keep their payloads. A field
    // simply deleted would make every stored payload still carrying one fail
    // to parse — and a run whose payload does not parse is granted **zero
    // write authority**, silently, which is a failure that looks like a model
    // deciding to do nothing. Stripping before the strict object sees them
    // retires the keys without retiring the rows.
    delete value.subscriptionEvaluationIds;
    delete value.operatorWatchEvaluationIds;
    return value;
  },
  z
    .object({
      /** Gateway document id of the datum that woke the agent. */
      docId: z.string().min(1),
      /** Whether the datum was newly created or an update to an existing doc. */
      event: z.enum(["created", "updated"]),
      /** Source timestamp of the datum (unix ms) — prompts state datum date vs. today. */
      datumAt: z.number(),
      /**
       * When this run would have been claimable on its debounce alone (unix ms).
       *
       * A data run's schedule answers to two independent waits: the trailing
       * debounce (has the document stopped changing?) and the readiness barrier
       * (has the deterministic derivation finished with it?). The row's
       * `next_attempt_at` is their maximum, so once derivation completes the
       * readiness pass needs this to know how far forward it may pull the run
       * without cutting the debounce short.
       */
      debounceUntil: z.number().optional(),
      /**
       * The schedule the readiness barrier imposed (unix ms) — present ONLY on a
       * run the barrier is actively holding, i.e. one whose datum was not yet
       * fully derived and whose barrier deadline is later than its debounce.
       *
       * This is the barrier's claim on the row, and the readiness pass releases
       * a run only while `next_attempt_at` still equals it. Several other writers
       * legitimately reschedule a pending run — a soft failure applies
       * exponential backoff, an in-flight fold resurrects with a fresh quiet
       * window, a fold clamps to the max-defer ceiling — and every one of them
       * leaves the payload untouched. Matching on the exact value is what keeps
       * the barrier from mistaking any of those for its own hold and cancelling
       * a wait it did not impose.
       */
      barrierUntil: z.number().optional(),
      /**
       * The datum was handed to the assistant deliberately (the generic
       * `metadata.addressedToAgent` marker), so nothing downstream may delay
       * its run — not the readiness barrier, and not the quiet window an
       * in-flight fold re-opens on resurrect. Sticky across folds: once a
       * cycle carries addressed content it keeps the guarantee.
       */
      immediate: z.boolean().optional(),
      /** Stable ids of structured addressed entries changed in this folded cycle. */
      changedAddressedEntryIds: z
        .array(z.string().min(1).max(256))
        .max(MAX_CHANGED_ADDRESSED_ENTRY_IDS)
        .optional(),
      /** The changed-entry id set exceeded its cap; the prompt states this honestly. */
      addressedEntriesTruncated: z.boolean().optional(),
      /** Unified previous→current diff; present on `updated` runs when computable. */
      diff: z.string().optional(),
      /** Transient fold snapshot — see the module doc. */
      snapshot: z
        .object({
          content: z.string(),
          capturedAt: z.number(),
        })
        .optional(),
    })
    .strict(),
);

export type CognitionDataRunPayload = z.infer<typeof cognitionDataRunPayloadSchema>;

/** Parse an opaque queue payload as a `data` payload; null when malformed. */
export function parseCognitionDataRunPayload(payload: unknown): CognitionDataRunPayload | null {
  const res = cognitionDataRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/**
 * Projection of a run payload safe to persist beyond the run's lifetime
 * (the operator transcript). Drops the transient `snapshot` — the
 * pre-update body may live only on the pending queue row (the
 * no-prior-version-storage rule); everything else in a payload is
 * reference-shaped and fine to keep for debugging.
 */
export function transcriptSafeRunPayload(payload: unknown): unknown {
  if (payload !== null && typeof payload === "object" && "snapshot" in payload) {
    const { snapshot: _snapshot, ...rest } = payload as Record<string, unknown>;
    return rest;
  }
  return payload;
}

/**
 * `daily` runs batch one source's previous-day data points: the prompt
 * hands the agent the source id + date range only — data points are never
 * inlined (the agent queries them itself). Producer: the daily enqueuer.
 */
export const cognitionDailyRunPayloadSchema = z
  .object({
    /** Source whose data points the run should review. */
    sourceId: z.string().min(1),
    /** Inclusive range start (ISO 8601). */
    dateFrom: z.string().min(1),
    /** Inclusive range end (ISO 8601). */
    dateTo: z.string().min(1),
  })
  .strict();

export type CognitionDailyRunPayload = z.infer<typeof cognitionDailyRunPayloadSchema>;

export function parseCognitionDailyRunPayload(payload: unknown): CognitionDailyRunPayload | null {
  const res = cognitionDailyRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/** Fold key for a source's daily batch run: at most one pending per source+day. */
export function dailySourceRunDedupeKey(sourceId: string, day: string): string {
  return `${DAILY_SOURCE_DEDUPE_PREFIX}${sourceId}:${day}`;
}

/**
 * The May-day flavour of a `daily` run — the open-ended calendar lookahead for
 * the day just started (no source, no date range; the agent worked from
 * "today").
 *
 * Historical. The lookahead is now the `may-day` system sweep, so nothing
 * enqueues this shape any more; the parser stays because settled rows carrying
 * it are still rendered by the run inspector, the decision view and the
 * workflow classifier.
 */
export const cognitionMayDayRunPayloadSchema = z
  .object({
    mayDay: z.literal(true),
    /** The local day (`YYYY-MM-DD`) the run looks ahead over. */
    date: z.string().min(1),
  })
  .strict();

export type CognitionMayDayRunPayload = z.infer<typeof cognitionMayDayRunPayloadSchema>;

export function parseCognitionMayDayRunPayload(payload: unknown): CognitionMayDayRunPayload | null {
  const res = cognitionMayDayRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/**
 * The morning-digest flavour of a `daily` run — the once-a-morning pass
 * that composes ONE "Morning brief" card from the substrates (temporal
 * horizon, due/overdue loops, overnight briefs). Enqueued by its own
 * boundary at `brain.digest.hour`, after the overnight batches settle.
 */
export const cognitionDigestRunPayloadSchema = z
  .object({
    digest: z.literal(true),
    /** The local day (`YYYY-MM-DD`) the digest covers. */
    date: z.string().min(1),
  })
  .strict();

export type CognitionDigestRunPayload = z.infer<typeof cognitionDigestRunPayloadSchema>;

export function parseCognitionDigestRunPayload(payload: unknown): CognitionDigestRunPayload | null {
  const res = cognitionDigestRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/** Fold key for the digest run: at most one pending per day. */
export function digestRunDedupeKey(day: string): string {
  return `${DIGEST_DEDUPE_PREFIX}${day}`;
}

/**
 * `time_based` runs carry the open-ended prompt stored by the
 * `schedule_agent_run` call that scheduled them.
 *
 * `loopId` is the optional structured link to the open loop the check is
 * about. When present, the check is auto-cancelled if that loop resolves
 * or is deleted before it fires (see `cancelScheduledRunsForLoop`), so an
 * already-handled loop never burns a model call to rediscover it. Absent
 * on loop-less checks (e.g. a pre-event refresh) and on pre-link runs
 * scheduled before this field existed — those keep their fire-and-no-op
 * behaviour.
 */
export const cognitionTimeBasedRunPayloadSchema = z
  .object({
    prompt: z.string().min(1),
    loopId: z.string().min(1).optional(),
  })
  .strict();

/** Longest instruction a single `schedule_agent_run` call may carry. */
export const SCHEDULED_INSTRUCTION_REQUEST_MAX_CHARS = 4000;

/**
 * The text a merge puts between the stored instruction and the one joining
 * it: a paragraph break and the hour the joining check asked for, so the run
 * that carries the merged check out can see that part of its instruction was
 * written for a different hour.
 */
export function mergedInstructionSeparator(requestedAt: number): string {
  return `\n\nAlso requested for ${new Date(requestedAt).toISOString()}: `;
}

/**
 * Ceiling on a scheduled check's stored instruction, in characters: three
 * full-size instructions plus the two separators that join them. A merge into
 * an already-pending same-loop, same-day check appends the new instruction to
 * the one stored; past this cap the merge is refused, so a busy loop's check
 * cannot grow all day into a prompt that does a dozen unrelated things. A
 * check that needs more is a second run.
 */
export const SCHEDULED_INSTRUCTION_MAX_CHARS =
  3 * SCHEDULED_INSTRUCTION_REQUEST_MAX_CHARS + 2 * mergedInstructionSeparator(0).length;

export type CognitionTimeBasedRunPayload = z.infer<typeof cognitionTimeBasedRunPayloadSchema>;

export function parseCognitionTimeBasedRunPayload(
  payload: unknown,
): CognitionTimeBasedRunPayload | null {
  const res = cognitionTimeBasedRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/**
 * `feedback` runs carry the dismissed brief's id; the run's prompt
 * builder loads the brief's live state (dismissal reason, free text,
 * related loops) at claim time. A snooze dismissal where the user picked
 * a concrete re-surface time also carries that time — it is a one-shot
 * user signal, not brief state, so it rides in the payload.
 */
export const cognitionFeedbackRunPayloadSchema = z
  .object({
    briefId: z.string().min(1),
    /** User-picked snooze re-surface time (unix ms); absent = agent decides. */
    snoozeUntil: z.number().optional(),
  })
  .strict();

export type CognitionFeedbackRunPayload = z.infer<typeof cognitionFeedbackRunPayloadSchema>;

export function parseCognitionFeedbackRunPayload(
  payload: unknown,
): CognitionFeedbackRunPayload | null {
  const res = cognitionFeedbackRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/**
 * Fold key for a brief's feedback run: at most one pending per brief. A
 * re-dismissal while the previous dismissal's run is still pending folds
 * into it — the newest signal wins, and the prompt builder reads the
 * brief's live state at claim time anyway.
 */
export function feedbackRunDedupeKey(briefId: string): string {
  return `${FEEDBACK_DEDUPE_PREFIX}${briefId}`;
}

// ── provenance recheck — a `feedback` payload variant ──────────────────────

export const PROVENANCE_RECHECK_DEDUPE_PREFIX = "feedback:provenance:";

/**
 * Fold key for a dependent's provenance recheck: at most one pending per
 * brief/loop. This is the anti-stampede fold — N priors dying while a
 * dependent's recheck is pending collapse into the one run, and the prompt
 * builder reads the dependent's consumed priors (and their liveness) at
 * claim time, so the folded run always judges the full current dead set.
 */
export function provenanceRecheckDedupeKey(kind: "brief" | "loop", dependentId: string): string {
  return `${PROVENANCE_RECHECK_DEDUPE_PREFIX}${kind}:${dependentId}`;
}

/**
 * The provenance-recheck variant of a `feedback` run — "a prior you rested
 * on died; re-examine this dependent". Reference-shaped by design: it names
 * only the dependent; the dead priors are re-derived from the consumption
 * edges at claim time (`listConsumedPriorsForDependent`), so enqueue-time
 * state never goes stale in the payload. A hard retract adds an opaque
 * generation token so a fold that lands while an identical recheck is in
 * flight is byte-distinct and is resurrected after that attempt settles.
 * Producer: the provenance-recheck sweep
 * (`rhythm/provenance-recheck-sweep.ts`) and hard-retract writer path.
 */
export const cognitionProvenanceRecheckPayloadSchema = z
  .object({
    recheckDependentKind: z.enum(["brief", "loop"]),
    recheckDependentId: z.string().min(1),
    recheckGeneration: z.string().uuid().optional(),
  })
  .strict();

export type CognitionProvenanceRecheckPayload = z.infer<
  typeof cognitionProvenanceRecheckPayloadSchema
>;

export function parseCognitionProvenanceRecheckPayload(
  payload: unknown,
): CognitionProvenanceRecheckPayload | null {
  const res = cognitionProvenanceRecheckPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/**
 * The decay-check flavour of a `time_based` run — the decay engine's
 * scheduled status-check on one stale loop. Carries only the loop id;
 * the prompt builder loads the loop's live state (ledger, doc
 * existence) at claim time so the agent judges current reality, not a
 * snapshot from enqueue time.
 */
export const cognitionDecayCheckRunPayloadSchema = z
  .object({
    decayCheckLoopId: z.string().min(1),
  })
  .strict();

export type CognitionDecayCheckRunPayload = z.infer<typeof cognitionDecayCheckRunPayloadSchema>;

export function parseCognitionDecayCheckRunPayload(
  payload: unknown,
): CognitionDecayCheckRunPayload | null {
  const res = cognitionDecayCheckRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

/**
 * The open loop a run is itself scoped to, if any — the "triggering loop"
 * the engine reads to auto-attach a `loopId` onto a follow-up
 * `schedule_agent_run` a loop-scoped check makes without passing one. A
 * `time_based` check carries it as `loopId`; a decay check carries it as
 * `decayCheckLoopId`. Returns undefined for run kinds with no single loop
 * scope (`data`, `daily`, `feedback`, and loop-less `time_based` checks).
 */
export function runScopeLoopId(payload: unknown): string | undefined {
  const timeBased = parseCognitionTimeBasedRunPayload(payload);
  if (timeBased?.loopId !== undefined) return timeBased.loopId;
  const decay = parseCognitionDecayCheckRunPayload(payload);
  if (decay) return decay.decayCheckLoopId;
  return undefined;
}

/** Prefix of every decay-check fold key — the sweep's reconciliation scan. */
export const DECAY_CHECK_DEDUPE_PREFIX = "decay:loop:";

/** Fold key for a loop's decay check: at most one pending per loop. */
export function decayCheckRunDedupeKey(loopId: string): string {
  return `${DECAY_CHECK_DEDUPE_PREFIX}${loopId}`;
}

// ── synthesis — the generative "Noticing" + collision-judge runs ───

export const SYNTHESIS_DEDUPE_PREFIX = "synthesis:";

/** Fold key for a day's noticing pass — bounds concurrent pending passes. */
export function synthesisNoticingDedupeKey(day: string): string {
  return `${SYNTHESIS_DEDUPE_PREFIX}noticing:${day}`;
}

/**
 * Fold key for a collision-judge run, keyed on the SORTED colliding loop set so
 * the same pair re-detected on a later sweep folds into the one pending judge.
 */
export function synthesisCollisionDedupeKey(loopSetKey: string): string {
  return `${SYNTHESIS_DEDUPE_PREFIX}collision:${loopSetKey}`;
}

/**
 * Fold key for an annotation-contradiction judge run, keyed on the SORTED
 * disagreeing annotation-id set (the established sorted-suffix convention) so
 * the same group re-detected on a later sweep folds into the one pending
 * judge. Doc (`anno_…`) and person (`panno_…`) ids share the suffix space
 * without colliding — the id prefixes keep them distinct.
 */
export function synthesisAnnotationContradictionDedupeKey(annotationSetKey: string): string {
  return `${SYNTHESIS_DEDUPE_PREFIX}anno-contradiction:${annotationSetKey}`;
}

/**
 * A `synthesis` run's payload. `focus` "noticing" = a corpus-wide reflection
 * pass; "collision" = judge whether a set of structurally-colliding loops
 * really relate; "annotation-contradiction" = re-ground a group of live
 * annotations that share a subject + claimType yet disagree on the claim, and
 * repair by supersession. All carry only reference-shaped data — nothing
 * transient, so the transcript-safe projection keeps it whole.
 */
export const cognitionSynthesisRunPayloadSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const value = { ...(input as Record<string, unknown>) };
    // Pending collision runs written before the terminology split remain
    // claimable, but all newly parsed payloads expose the canonical field.
    if (value.temporalAnnotationIds === undefined && value.entryIds !== undefined) {
      value.temporalAnnotationIds = value.entryIds;
    }
    delete value.entryIds;
    return value;
  },
  z
    .object({
      focus: z.enum(["noticing", "collision", "annotation-contradiction"]),
      /** noticing: the local day the pass covers. */
      date: z.string().min(1).optional(),
      /** collision: the colliding loop ids to judge. */
      loopIds: z.array(z.string().min(1)).optional(),
      /** collision: the overlapping temporal-annotation ids to judge. */
      temporalAnnotationIds: z.array(z.string().min(1)).optional(),
      /** collision: why they collided (`person:`/`doc:`/`deadline-day:`/`time-overlap:` tags). */
      matchedBy: z.array(z.string()).optional(),
      /** annotation-contradiction: the disagreeing live annotation ids to re-ground. */
      annotationIds: z.array(z.string().min(1)).optional(),
      /** annotation-contradiction: which annotation store the ids live in. */
      store: z.enum(["doc", "person"]).optional(),
    })
    .strict(),
);

export type CognitionSynthesisRunPayload = z.infer<typeof cognitionSynthesisRunPayloadSchema>;

export function parseCognitionSynthesisRunPayload(
  payload: unknown,
): CognitionSynthesisRunPayload | null {
  const res = cognitionSynthesisRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

// ── sweep — operator-declared, prompt-steered scheduled themes ─────────

export const SWEEP_DEDUPE_PREFIX = "sweep:";

/** Fold key for a sweep occurrence, keyed on the theme id + local day. */
export function sweepDedupeKey(sweepId: string, day: string): string {
  return `${SWEEP_DEDUPE_PREFIX}${sweepId}:${day}`;
}

/**
 * A `sweep` run's payload — one occurrence of a scheduled theme. Carries the
 * sweep id, the local day it covers, whether the definition shipped with the
 * gateway or came from the operator's own file, and the steering prose
 * verbatim (snapshotted so an in-flight run is unaffected by a mid-run edit of
 * its file). Reference-shaped; transcript-safe whole.
 *
 * `origin` is optional because runs enqueued before sweeps had an origin are
 * still claimable; the prompt builder and the inspector both treat an absent
 * value as `system`, which is what every such run was.
 *
 * `briefLane` is the editorial charter a SYSTEM sweep may declare (see
 * `CognitionBriefLane`), snapshotted like the steering so a mid-run edit
 * cannot widen the bar an in-flight run faces. Absent means the strict
 * reactive bar, which is what every operator-authored sweep gets.
 */
export const cognitionSweepRunPayloadSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const value = { ...(input as Record<string, unknown>) };
    // Pending persisted runs from pre-rename builds remain claimable.
    if (value.temporalAnnotationPrimeDays === undefined && value.timeIndexPrimeDays !== undefined) {
      value.temporalAnnotationPrimeDays = value.timeIndexPrimeDays;
    }
    delete value.timeIndexPrimeDays;
    return value;
  },
  z
    .object({
      sweepId: z.string().min(1),
      date: z.string().min(1),
      steeringPrompt: z.string().min(1),
      origin: z.enum(["system", "user"]).optional(),
      briefLane: z.enum(["lookahead", "noticing"]).optional(),
      temporalAnnotationPrimeDays: z.number().int().positive().optional(),
    })
    .strict(),
);

export type CognitionSweepRunPayload = z.infer<typeof cognitionSweepRunPayloadSchema>;

export function parseCognitionSweepRunPayload(payload: unknown): CognitionSweepRunPayload | null {
  const res = cognitionSweepRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

// ── verification — the re-verification sweep's re-grounding runs ───────────

export const VERIFICATION_DEDUPE_PREFIX = "verify:";

/**
 * Fold key for a `verification` run: the store plus the SORTED annotation-id
 * batch (the established sorted-suffix convention), so the same due batch
 * re-detected on a later sweep folds into the one pending run.
 */
export function verificationRunDedupeKey(
  store: "doc" | "person",
  annotationIds: readonly string[],
): string {
  return `${VERIFICATION_DEDUPE_PREFIX}${store}:${[...annotationIds].sort().join(",")}`;
}

/**
 * A `verification` run's payload — one batch of live annotations due a
 * re-grounding check, all from ONE store. Reference-shaped by design: the
 * prompt builder loads each annotation's LIVE state at claim time, so the
 * run judges current reality, not a snapshot from enqueue time. Producer:
 * the re-verification sweep (`rhythm/reverification-sweep.ts`).
 */
export const cognitionVerificationRunPayloadSchema = z
  .object({
    /** The annotation ids to re-ground. */
    annotationIds: z.array(z.string().min(1)).min(1),
    /** Which annotation store the ids live in. */
    store: z.enum(["doc", "person"]),
  })
  .strict();

export type CognitionVerificationRunPayload = z.infer<typeof cognitionVerificationRunPayloadSchema>;

export function parseCognitionVerificationRunPayload(
  payload: unknown,
): CognitionVerificationRunPayload | null {
  const res = cognitionVerificationRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

// ── merge_adjudication — one pending person-merge candidate to adjudicate ──

export const MERGE_ADJUDICATION_DEDUPE_PREFIX = "merge-adjudication:candidate:";

/** Fold key for `merge_adjudication` runs: at most one pending run per candidate. */
export function mergeAdjudicationRunDedupeKey(candidateId: string): string {
  return `${MERGE_ADJUDICATION_DEDUPE_PREFIX}${candidateId}`;
}

/**
 * A `merge_adjudication` run's payload — the one pending merge candidate the
 * run adjudicates. Reference-shaped by design: the prompt builder loads the
 * candidate's LIVE state and evidence pack at claim time, so a candidate that
 * was decided or reconciled away between enqueue and claim yields a no-op run.
 * Producer: the merge-adjudication enqueue pass (`merge-adjudication.ts`).
 */
export const cognitionMergeAdjudicationRunPayloadSchema = z
  .object({
    candidateId: z.string().min(1),
  })
  .strict();

export type CognitionMergeAdjudicationRunPayload = z.infer<
  typeof cognitionMergeAdjudicationRunPayloadSchema
>;

export function parseCognitionMergeAdjudicationRunPayload(
  payload: unknown,
): CognitionMergeAdjudicationRunPayload | null {
  const res = cognitionMergeAdjudicationRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

// ── notes_compaction — background curation of the agent-notes blob ─────────

/**
 * Fixed fold key for `notes_compaction` runs: at most ONE pending compaction
 * at a time. An over-cap write enqueues only when no compaction row is
 * already pending, and the run reads the live notes at claim time, so a
 * skipped enqueue loses nothing.
 */
export const NOTES_COMPACTION_DEDUPE_KEY = "notes-compaction";

export function notesCompactionRunDedupeKey(): string {
  return NOTES_COMPACTION_DEDUPE_KEY;
}

/**
 * A `notes_compaction` run's payload. Reference-free by design: the run
 * rewrites the live notes blob read at claim time, so the payload carries
 * only the human-readable reason compaction was scheduled (the byte state
 * that crossed the cap) for the operator ledger.
 */
export const cognitionNotesCompactionRunPayloadSchema = z
  .object({
    /** Why compaction was scheduled — e.g. the byte count that crossed the cap. */
    reason: z.string().min(1),
  })
  .strict();

export type CognitionNotesCompactionRunPayload = z.infer<
  typeof cognitionNotesCompactionRunPayloadSchema
>;

export function parseCognitionNotesCompactionRunPayload(
  payload: unknown,
): CognitionNotesCompactionRunPayload | null {
  const res = cognitionNotesCompactionRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

// ── subscription_compile — one watch compilation, recorded already settled ──

/**
 * A `subscription_compile` run's payload. Unlike the queued kinds this is
 * written at settle time by the watch compiler's run recorder — the run never
 * sits pending, so nothing transient ever needs stripping. Producer:
 * `watch/compile-run.ts`.
 *
 * The shape is the compile's own: one request, one agent session against this
 * install's ontology, a repair loop, and an answer. `request` is the run's
 * whole subject (the analogue of a `data` run's document), and the ledger is
 * admin-only, so carrying it keeps a refusal inspectable even when no model
 * turn ran and there is no transcript.
 */
export const cognitionSubscriptionCompileRunPayloadSchema = z
  .object({
    /** The condition that was compiled, in the asker's own words. */
    request: z.string().min(1),
    /** Who asked for the watch — the operator's surface, or an agent's. */
    authoredBy: z.enum(["operator", "integration"]),
    /**
     * Which compile ran.
     *
     * `session` — an agent turn holding the gateway's read surface, so the
     * compiler could resolve the people a request names and look at what a
     * source actually contains. `single-shot` — one prompt to a completion
     * backend, on an install with no chat runtime to look things up with. The
     * two produce the same shape of watch and differ in how well bounded it
     * is, which is exactly the thing a ledger has to be able to say.
     */
    path: z.enum(["session", "single-shot"]),
    /** The watch this compile rewrites, when it replaces one. */
    replaces: z.string().min(1).optional(),
    /**
     * How many model attempts the repair loop took. Absent when the compile
     * never reached an answer to validate — no model assigned, or a deadline.
     */
    attempts: z.number().int().min(0).optional(),
    /**
     * What about the request could not be written. Present only on a refusal;
     * these are the codes, not the reasons — a reason can quote the corpus the
     * compiler read, and lives in the transcript rather than on the row.
     */
    refusalCodes: z.array(z.string().min(1)).optional(),
    /**
     * Whether this compile was a preview: the DSL was produced and handed back
     * without installing or arming anything.
     *
     * On the row rather than inferred from the absence of a watch, because
     * from the ledger's side those two are identical — a compile that
     * installed nothing looks exactly like one whose install failed after it,
     * and an operator reading the runs list has no other way to tell a
     * measurement run from an attempt that went wrong.
     *
     * Absent on any compile that installed.
     */
    compileOnly: z.literal(true).optional(),
    /**
     * This compile was asked to skip replaying its own candidate.
     *
     * The row carries the compile's duration, so it is where the replay's cost
     * has to be attributable from — and the arm cannot be inferred from a
     * missing backtest, which also happens when the install has no runtime, when
     * the replay declined the candidate, and on every refusal.
     *
     * Absent on any compile that replayed.
     */
    withoutBacktest: z.literal(true).optional(),
  })
  .strict();

export type CognitionSubscriptionCompileRunPayload = z.infer<
  typeof cognitionSubscriptionCompileRunPayloadSchema
>;

export function parseCognitionSubscriptionCompileRunPayload(
  payload: unknown,
): CognitionSubscriptionCompileRunPayload | null {
  const res = cognitionSubscriptionCompileRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

// ---------------------------------------------------------------------------
// bootstrap — the one-time retrospective pass over a PAST document that still
// carries a future-dated semantic time. One run per document; the dedupe key
// folds a re-enqueue and shares the keyspace so a live `data` run and a
// bootstrap run for related work don't both fire (they key differently, so
// they don't fold — but the per-doc marker prevents re-enqueue).
// ---------------------------------------------------------------------------

export const BOOTSTRAP_DEDUPE_PREFIX = "bootstrap:doc:";

/** Fold key for `bootstrap` runs: at most one pending run per document. */
export function bootstrapRunDedupeKey(docId: string): string {
  return `${BOOTSTRAP_DEDUPE_PREFIX}${docId}`;
}

export const cognitionBootstrapRunPayloadSchema = z
  .object({
    /** Gateway document id of the historical document being reviewed. */
    docId: z.string().min(1),
    /** Source emission timestamp of the document (unix ms) — prompts state its age. */
    datumAt: z.number(),
  })
  .strict();

export type CognitionBootstrapRunPayload = z.infer<typeof cognitionBootstrapRunPayloadSchema>;

export function parseCognitionBootstrapRunPayload(
  payload: unknown,
): CognitionBootstrapRunPayload | null {
  const res = cognitionBootstrapRunPayloadSchema.safeParse(payload);
  return res.success ? res.data : null;
}

// ---------------------------------------------------------------------------
// Brief lane — the editorial axis the push bar is calibrated on.
// ---------------------------------------------------------------------------

/**
 * Which editorial lane a run's briefs belong to.
 *
 * The push bar (`brief-judge.ts`) asks "does this earn an interrupt?", and the
 * four gates that answer it are written for a REACTIVE card: one that fires
 * because a datum arrived. Three lanes are not reactive, and for each of them
 * one gate contradicts the very instruction that commissioned the card:
 *
 *   - `digest` — the once-a-morning composition. Scheduled, capped at one card
 *     a day, and the only brief that pushes. "Does this tell the user
 *     something new" is the wrong question to ask of a daily summary.
 *   - `lookahead` — the day-ahead sweep, whose steering orders it to write
 *     informative briefs preparing the user: what, when, with whom. Its
 *     product IS restating today with context, which the awareness gate reads
 *     as an echo.
 *   - `dated_reminder` — a `schedule_agent_run` check resurfacing a dated item
 *     on its day, which `DATED_REMINDER_RULE` asks for precisely because the
 *     user's own to-do app may not remind them.
 *   - `noticing` — the synthesis awareness pass, chartered to surface patterns
 *     with no action attached, which the consequence gate reads as costless.
 *
 * Everything else is `reactive` and faces all four gates.
 */
export type CognitionBriefLane =
  | "digest"
  | "lookahead"
  | "dated_reminder"
  | "noticing"
  | "reactive";

/**
 * The lane every run kind resolves to before its payload is consulted. Keyed
 * by the full `CognitionRunKind` union so a newly added kind must state its
 * lane here rather than inheriting one by omission. The four kinds mapped to
 * `null` fan out to more than one lane and are resolved from their payload
 * below.
 */
const LANE_BY_KIND: Record<CognitionRunKind, CognitionBriefLane | null> = {
  data: "reactive",
  daily: null,
  time_based: null,
  synthesis: null,
  feedback: "reactive",
  sweep: null,
  bootstrap: "reactive",
  verification: "reactive",
  merge_adjudication: "reactive",
  notes_compaction: "reactive",
  subscription_compile: "reactive",
};

/**
 * Resolve a claimed run's brief lane from its kind and payload flavour.
 *
 * Every fallback is `reactive`, the strict bar: an unrecognized kind (the
 * run-queue row's `kind` is an unchecked cast, so a corrupt or forward-compat
 * row can carry one) or a payload that fails its schema faces the full four
 * gates rather than a laxer subset. A lane is only ever widened by a payload
 * that positively parses.
 */
export function cognitionBriefLane(run: { kind: string; payload: unknown }): CognitionBriefLane {
  const byKind = LANE_BY_KIND[run.kind as CognitionRunKind];
  if (byKind !== undefined && byKind !== null) return byKind;
  switch (run.kind) {
    case "daily":
      if (parseCognitionDigestRunPayload(run.payload)) return "digest";
      // Historical: the day-ahead pass was a `daily` flavour before it became
      // a sweep, and settled rows of that shape are still read back.
      return parseCognitionMayDayRunPayload(run.payload) ? "lookahead" : "reactive";
    case "sweep":
      // Only a system sweep can carry a lane, and only while its prose is the
      // prose the lane was granted for; everything else faces all four gates.
      return parseCognitionSweepRunPayload(run.payload)?.briefLane ?? "reactive";
    case "time_based": {
      // A scheduled check earns the preparation bar only when it is what
      // DATED_REMINDER_RULE describes — a re-verification tied to a specific
      // loop, on the day that loop's item comes due. A loop-less
      // `schedule_agent_run` is a free-form follow-up the agent wrote for
      // itself, and letting that reach the laxer bar would hand it a way to
      // route around the echo check by scheduling its own card.
      const scheduled = parseCognitionTimeBasedRunPayload(run.payload);
      return scheduled?.loopId !== undefined ? "dated_reminder" : "reactive";
    }
    case "synthesis":
      return parseCognitionSynthesisRunPayload(run.payload)?.focus === "noticing"
        ? "noticing"
        : "reactive";
    default:
      return "reactive";
  }
}
