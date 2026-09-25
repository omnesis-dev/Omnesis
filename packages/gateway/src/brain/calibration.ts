// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Calibration measurement — a READ-ONLY reliability report over the
 * confidence-carrying cognition artifacts (briefs, doc annotations, person
 * annotations), binning each family's stated confidence against the
 * ground-truth error signals the system already collects.
 *
 * This module measures and nothing else: it never mutates a confidence, never
 * feeds back into ranking or gating, and no behavior anywhere changes based on
 * its output. The operator wants a long baseline of v1 measurements before any
 * calibration is allowed to act; this is that baseline's definition.
 *
 * ## Label rules (the measurement definition)
 *
 * Each artifact gets exactly one label class; classes map to a verdict —
 * `correct`, `incorrect`, or `excluded` (no truth signal). Only `correct` /
 * `incorrect` artifacts enter the reliability bins and the ECE. Rules are
 * ordered; the FIRST match wins.
 *
 * ### Briefs (`briefs.state` + developer annotations)
 *  1. A `dev_annotations` row targeting the brief (`target_type='brief'`)
 *     → `operator_flagged`, **incorrect**. A brief-targeted flag addresses
 *     the artifact itself, so it is a truth verdict. Open or resolved —
 *     resolving a dev annotation closes the engineer's worklist item, it
 *     does not retract the operator's observation that the artifact was
 *     wrong.
 *  2. `state='dismissed_wrong'` → `dismissed_wrong`, **incorrect** — the
 *     user's explicit "this is untrue" verdict.
 *  3. `state='dismissed_not_relevant'` → `dismissed_not_relevant`,
 *     **excluded** — irrelevant is NOT untrue; counting it against
 *     truth-calibration would punish correct-but-unwanted briefs.
 *  4. `state='dismissed_acknowledged'` → `acknowledged`, weak **correct** —
 *     the user saw the brief and accepted it as stated.
 *  5. `state='dismissed_already_handled'` → `already_handled`, weak
 *     **correct** — relevant and true, just already dealt with. (Weakest of
 *     the positives: the engine's resolved-loop cascade also writes this
 *     state, so it mixes user and engine judgment.)
 *  6. `state='read'` → `kept_read`, weak **correct** — seen and kept in the
 *     feed without complaint.
 *  7. `state='unread'` or `'dismissed_snoozed'` → `unlabeled`, **excluded**
 *     — no verdict yet (snooze defers, it does not judge).
 *
 * ### Doc / person annotations (verification + supersession stamps)
 *  1. (doc annotations only) A `dev_annotations` row targeting the
 *     annotation's SUBJECT document (`target_type='document'`,
 *     `target_id=doc_id`) → `subject_flagged`, **excluded**. Doc-targeted
 *     dev annotations are source-data-quality notes about the document
 *     itself ("duplicate ingest", "OCR garbled") — they say nothing about
 *     whether a claim ABOUT the document is true, so the doc's annotations
 *     leave the truth bins entirely (like `dismissed_not_relevant`) rather
 *     than counting against them. Person annotations have no
 *     dev-addressable subject and skip this rule.
 *  2. `superseded_by IS NOT NULL` → `superseded`, weak **incorrect** — a
 *     later run revised this belief away.
 *  3. `invalidated_at IS NOT NULL` (with `superseded_by` NULL) →
 *     `drift_invalidated`, **excluded** — the cited document's content
 *     changed under the annotation. The evidence moved; that says nothing
 *     about whether the original claim was true when stated.
 *  4. `verification_state='verified'` → `verified`, weak **correct** — the
 *     entailment verifier judged the evidence to entail the claim.
 *  5. Anything else (`unverified` / NULL verification on a live row) →
 *     `unlabeled`, **excluded** — never adjudicated.
 *
 * Known blind spots: annotation retracts are hard-deletes with no tombstone,
 * so retracted rows cannot be counted here — they simply vanish from the
 * denominator. And there is deliberately no rule for
 * `verification_state='failed'`: the stamp exists in the storage type union
 * but no code path writes it — the entailment gate stamps
 * verified/unverified/NULL, the drift sweep re-stamps `'unverified'`, and
 * verification runs resolve a failed re-check by weakening the claim
 * (re-enters as unverified, excluded here), superseding it (counted
 * incorrect), or retracting it (hard-deleted, invisible). If a writer ever
 * starts stamping `'failed'`, restore a `verification_failed` → incorrect
 * rule between the supersession and drift rules (and its SQL CASE mirror
 * below).
 *
 * ## Evaluation — labeling runs inside SQLite
 *
 * Each family is aggregated by ONE grouped query: a CASE expression mirroring
 * the label rules above assigns the class, the confidence is binned with the
 * same edges as {@link binReliability} (equal-width, last bin closed at 1.0),
 * and GROUP BY (class, bin) returns COUNT(*) + SUM(confidence) per cell. The
 * report therefore reads O(classes × bins) rows no matter how large the
 * corpus — a full-history request never materializes per-artifact rows on the
 * gateway request thread. The pure {@link labelBrief} / {@link labelAnnotation}
 * functions are the executable specification of the same rules; a parity test
 * (calibration.test.ts) holds the SQL mirror and the spec to identical
 * reports over a randomized corpus.
 *
 * ## Report shape
 *
 * Per family: 10 equal-width confidence bins over [0,1] (last bin closed at
 * 1.0), each with n / mean stated confidence / empirical correctness / gap;
 * plus the family's ECE (Σ over bins of (n_b/N)·|gap_b|) and per-class
 * counts. A family with no labeled rows reports empty bins and a null ECE —
 * never a division by zero.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

export const CALIBRATION_FAMILIES = ["brief", "doc-annotation", "person-annotation"] as const;

export type CalibrationFamily = (typeof CALIBRATION_FAMILIES)[number];

/** What a label class says about the artifact's truth. */
export type CalibrationVerdict = "correct" | "incorrect" | "excluded";

/** One artifact's resolved label: the matched class and its verdict. */
export interface CalibrationLabel {
  labelClass: string;
  verdict: CalibrationVerdict;
}

/** One confidence bin of a family's reliability table. */
export interface CalibrationBin {
  /** Inclusive lower bound of the bin's stated-confidence range. */
  lo: number;
  /** Upper bound — exclusive, except the last bin which closes at 1.0. */
  hi: number;
  /** Labeled artifacts whose stated confidence falls in this bin. */
  n: number;
  /** Mean stated confidence of the bin's artifacts; null when n = 0. */
  meanConfidence: number | null;
  /** Fraction of the bin's artifacts labeled correct; null when n = 0. */
  empiricalCorrectness: number | null;
  /** `empiricalCorrectness − meanConfidence` (signed); null when n = 0. */
  gap: number | null;
}

/** One artifact family's reliability report. */
export interface FamilyCalibrationReport {
  family: CalibrationFamily;
  /** All artifacts of the family in scope, labeled or not. */
  total: number;
  /** Artifacts with a truth verdict (correct + incorrect). */
  labeled: number;
  correct: number;
  incorrect: number;
  /** Artifacts per label class, including the excluded classes. */
  classCounts: Record<string, number>;
  /** The 10-bin reliability table over the labeled artifacts. */
  bins: CalibrationBin[];
  /** Expected calibration error over the labeled set; null when labeled = 0. */
  ece: number | null;
}

export interface CalibrationReport {
  /** Unix ms the report was computed. */
  generatedAt: number;
  /** The created-at window applied, in days; null = the full history. */
  sinceDays: number | null;
  families: FamilyCalibrationReport[];
}

// ---------------------------------------------------------------------------
// Label rules — pure, one artifact in, one label out
// ---------------------------------------------------------------------------

/**
 * Every class the brief rules can emit, with its verdict. Single source of
 * truth for verdicts: {@link labelBrief} and the grouped-row fold both read it.
 */
const BRIEF_CLASS_VERDICTS = {
  operator_flagged: "incorrect",
  dismissed_wrong: "incorrect",
  dismissed_not_relevant: "excluded",
  acknowledged: "correct",
  already_handled: "correct",
  kept_read: "correct",
  unlabeled: "excluded",
} as const satisfies Record<string, CalibrationVerdict>;

type BriefLabelClass = keyof typeof BRIEF_CLASS_VERDICTS;

function briefLabelClass(state: string, operatorFlagged: boolean): BriefLabelClass {
  if (operatorFlagged) return "operator_flagged";
  switch (state) {
    case "dismissed_wrong":
      return "dismissed_wrong";
    case "dismissed_not_relevant":
      return "dismissed_not_relevant";
    case "dismissed_acknowledged":
      return "acknowledged";
    case "dismissed_already_handled":
      return "already_handled";
    case "read":
      return "kept_read";
    default:
      // `unread`, `dismissed_snoozed`, `retired` (the agent's own withdrawal,
      // which is not a user signal and must not read as one), and anything
      // unrecognized.
      return "unlabeled";
  }
}

/** Apply the brief label rules (see module doc, "Briefs"). */
export function labelBrief(state: string, operatorFlagged: boolean): CalibrationLabel {
  const labelClass = briefLabelClass(state, operatorFlagged);
  return { labelClass, verdict: BRIEF_CLASS_VERDICTS[labelClass] };
}

/**
 * Every class the annotation rules can emit, with its verdict. Single source
 * of truth for verdicts: {@link labelAnnotation} and the grouped-row fold
 * both read it.
 */
const ANNOTATION_CLASS_VERDICTS = {
  subject_flagged: "excluded",
  superseded: "incorrect",
  drift_invalidated: "excluded",
  verified: "correct",
  unlabeled: "excluded",
} as const satisfies Record<string, CalibrationVerdict>;

type AnnotationLabelClass = keyof typeof ANNOTATION_CLASS_VERDICTS;

/** The verification/supersession columns the annotation label rules read. */
export interface AnnotationLabelInput {
  verificationState: string | null;
  invalidatedAt: number | null;
  supersededBy: string | null;
}

function annotationLabelClass(
  row: AnnotationLabelInput,
  subjectFlagged: boolean,
): AnnotationLabelClass {
  if (subjectFlagged) return "subject_flagged";
  if (row.supersededBy !== null) return "superseded";
  if (row.invalidatedAt !== null) return "drift_invalidated";
  if (row.verificationState === "verified") return "verified";
  // `unverified`, NULL, and any unrecognized stamp (incl. the never-written
  // `'failed'` — see the module doc's known-blind-spots paragraph).
  return "unlabeled";
}

/**
 * Apply the annotation label rules (see module doc, "Doc / person
 * annotations"). `subjectFlagged` = a dev annotation targets the annotation's
 * subject DOCUMENT (doc annotations only; always false for person
 * annotations).
 */
export function labelAnnotation(
  row: AnnotationLabelInput,
  subjectFlagged: boolean,
): CalibrationLabel {
  const labelClass = annotationLabelClass(row, subjectFlagged);
  return { labelClass, verdict: ANNOTATION_CLASS_VERDICTS[labelClass] };
}

// ---------------------------------------------------------------------------
// Binning + ECE — pure math over labeled samples
// ---------------------------------------------------------------------------

const CALIBRATION_BIN_COUNT = 10;

/** One labeled artifact, reduced to what the reliability math needs. */
export interface LabeledSample {
  /** Stated confidence, 0-1. */
  confidence: number;
  correct: boolean;
}

interface BinSums {
  n: number;
  confidence: number;
  correct: number;
}

function emptyBinSums(): BinSums[] {
  return Array.from({ length: CALIBRATION_BIN_COUNT }, () => ({
    n: 0,
    confidence: 0,
    correct: 0,
  }));
}

/** Turn per-bin running sums into the report's bin rows. */
function finalizeBins(sums: readonly BinSums[]): CalibrationBin[] {
  return sums.map((b, i) => {
    const meanConfidence = b.n > 0 ? b.confidence / b.n : null;
    const empiricalCorrectness = b.n > 0 ? b.correct / b.n : null;
    return {
      lo: i / CALIBRATION_BIN_COUNT,
      hi: (i + 1) / CALIBRATION_BIN_COUNT,
      n: b.n,
      meanConfidence,
      empiricalCorrectness,
      gap:
        empiricalCorrectness !== null && meanConfidence !== null
          ? empiricalCorrectness - meanConfidence
          : null,
    };
  });
}

/**
 * Fold labeled samples into the 10 equal-width reliability bins. Bin `i`
 * covers `[i/10, (i+1)/10)`; the last bin closes at 1.0 so a confidence of
 * exactly 1 lands in it. Out-of-range confidences clamp into the edge bins.
 * Always returns all 10 bins — empty ones carry n=0 and null stats.
 *
 * This is the binning specification the SQL mirror (`binExprSql`) must match
 * exactly; the report itself aggregates in SQL and never calls this per
 * artifact.
 */
export function binReliability(samples: readonly LabeledSample[]): CalibrationBin[] {
  const sums = emptyBinSums();
  for (const s of samples) {
    const idx = Math.min(
      CALIBRATION_BIN_COUNT - 1,
      Math.max(0, Math.floor(s.confidence * CALIBRATION_BIN_COUNT)),
    );
    const bin = sums[idx]!;
    bin.n += 1;
    bin.confidence += s.confidence;
    if (s.correct) bin.correct += 1;
  }
  return finalizeBins(sums);
}

/**
 * Expected calibration error: Σ over bins of `(n_b / N) · |gap_b|`. Null when
 * no samples are labeled (an empty family is honest, not perfectly calibrated).
 */
export function expectedCalibrationError(bins: readonly CalibrationBin[]): number | null {
  const total = bins.reduce((acc, b) => acc + b.n, 0);
  if (total === 0) return null;
  let sum = 0;
  for (const b of bins) {
    if (b.n > 0 && b.gap !== null) sum += (b.n / total) * Math.abs(b.gap);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// The report — grouped SQL aggregation + an O(classes × bins) fold
// ---------------------------------------------------------------------------

export interface CalibrationReportOptions {
  /** Restrict to one family; default all. */
  family?: CalibrationFamily;
  /** Only artifacts created in the trailing window, in days; default all history. */
  sinceDays?: number;
  /**
   * The wall-clock instant (unix ms) — stamps the report and anchors the
   * `sinceDays` window. Always injected (briefs clock discipline: no module
   * here reads the wall clock on its own).
   */
  now: number;
}

/**
 * The SQL mirror of {@link binReliability}'s bin assignment:
 * `min(9, max(0, floor(confidence · 10)))`. CAST truncates toward zero where
 * Math.floor rounds down, but the two only disagree on negative inputs, and
 * the clamp sends every negative to bin 0 either way — so the clamped result
 * is identical for all doubles, including the closed last bin at 1.0.
 */
function binExprSql(col: string): string {
  return `MAX(0, MIN(${CALIBRATION_BIN_COUNT - 1}, CAST(${col} * ${CALIBRATION_BIN_COUNT} AS INTEGER)))`;
}

/** One (label class × confidence bin) aggregate cell of a family query. */
interface GroupedLabelRow {
  label_class: string;
  bin: number;
  n: number;
  confidence_sum: number;
}

/** SQL CASE mirroring {@link briefLabelClass} — kept in lockstep by the parity test. */
const BRIEF_LABEL_CASE_SQL = `CASE
  WHEN EXISTS(SELECT 1 FROM dev_annotations da
               WHERE da.target_type = 'brief' AND da.target_id = b.id) THEN 'operator_flagged'
  WHEN b.state = 'dismissed_wrong' THEN 'dismissed_wrong'
  WHEN b.state = 'dismissed_not_relevant' THEN 'dismissed_not_relevant'
  WHEN b.state = 'dismissed_acknowledged' THEN 'acknowledged'
  WHEN b.state = 'dismissed_already_handled' THEN 'already_handled'
  WHEN b.state = 'read' THEN 'kept_read'
  ELSE 'unlabeled'
END`;

function loadBriefGroups(db: Db, sinceMs: number | null): GroupedLabelRow[] {
  return db
    .prepare<unknown[], GroupedLabelRow>(
      `SELECT ${BRIEF_LABEL_CASE_SQL} AS label_class,
              ${binExprSql("b.confidence")} AS bin,
              COUNT(*) AS n,
              SUM(b.confidence) AS confidence_sum
         FROM briefs b
        ${sinceMs !== null ? "WHERE b.created_at >= ?" : ""}
        GROUP BY label_class, bin`,
    )
    .all(...(sinceMs !== null ? [sinceMs] : []));
}

/**
 * SQL CASE mirroring {@link annotationLabelClass} — kept in lockstep by the
 * parity test. The dev target-type vocabulary can address a document but not
 * a person (nor an annotation row), so only doc annotations carry the
 * subject-flag rule; person annotations start at the supersession rule.
 */
function annotationLabelCaseSql(table: "doc_annotations" | "person_annotations"): string {
  const subjectFlagRule =
    table === "doc_annotations"
      ? `WHEN EXISTS(SELECT 1 FROM dev_annotations da
               WHERE da.target_type = 'document' AND da.target_id = a.doc_id) THEN 'subject_flagged'`
      : "";
  return `CASE
  ${subjectFlagRule}
  WHEN a.superseded_by IS NOT NULL THEN 'superseded'
  WHEN a.invalidated_at IS NOT NULL THEN 'drift_invalidated'
  WHEN a.verification_state = 'verified' THEN 'verified'
  ELSE 'unlabeled'
END`;
}

function loadAnnotationGroups(
  db: Db,
  table: "doc_annotations" | "person_annotations",
  sinceMs: number | null,
): GroupedLabelRow[] {
  return db
    .prepare<unknown[], GroupedLabelRow>(
      `SELECT ${annotationLabelCaseSql(table)} AS label_class,
              ${binExprSql("a.confidence")} AS bin,
              COUNT(*) AS n,
              SUM(a.confidence) AS confidence_sum
         FROM ${table} a
        ${sinceMs !== null ? "WHERE a.created_at >= ?" : ""}
        GROUP BY label_class, bin`,
    )
    .all(...(sinceMs !== null ? [sinceMs] : []));
}

/**
 * Fold the O(classes × bins) aggregate cells into one family report. The
 * verdict map is the same one the family's pure labeler reads, so class →
 * verdict cannot drift between the two paths; a class the map does not know
 * (impossible while the CASE mirrors the labeler) is treated as excluded.
 */
function foldGroupedRows(
  family: CalibrationFamily,
  rows: readonly GroupedLabelRow[],
  verdicts: Readonly<Record<string, CalibrationVerdict>>,
): FamilyCalibrationReport {
  const classCounts: Record<string, number> = {};
  const sums = emptyBinSums();
  let total = 0;
  let correct = 0;
  let incorrect = 0;
  for (const row of rows) {
    total += row.n;
    classCounts[row.label_class] = (classCounts[row.label_class] ?? 0) + row.n;
    const verdict = verdicts[row.label_class] ?? "excluded";
    if (verdict === "excluded") continue;
    const bin = sums[row.bin]!;
    bin.n += row.n;
    bin.confidence += row.confidence_sum;
    if (verdict === "correct") {
      bin.correct += row.n;
      correct += row.n;
    } else {
      incorrect += row.n;
    }
  }
  const bins = finalizeBins(sums);
  return {
    family,
    total,
    labeled: correct + incorrect,
    correct,
    incorrect,
    classCounts,
    bins,
    ece: expectedCalibrationError(bins),
  };
}

/**
 * Compute the calibration report. Read-only — no table is written, no
 * confidence is touched, and nothing downstream consumes this for behavior.
 * Aggregation happens inside SQLite (see module doc, "Evaluation"), so the
 * fold here handles O(classes × bins) rows regardless of corpus size.
 */
export function computeCalibrationReport(
  db: Db,
  opts: CalibrationReportOptions,
): CalibrationReport {
  const now = opts.now;
  const sinceDays = opts.sinceDays ?? null;
  const sinceMs = sinceDays !== null ? now - sinceDays * 86_400_000 : null;
  const wanted = opts.family ? [opts.family] : CALIBRATION_FAMILIES;
  const families = wanted.map((family) => {
    switch (family) {
      case "brief":
        return foldGroupedRows(family, loadBriefGroups(db, sinceMs), BRIEF_CLASS_VERDICTS);
      case "doc-annotation":
        return foldGroupedRows(
          family,
          loadAnnotationGroups(db, "doc_annotations", sinceMs),
          ANNOTATION_CLASS_VERDICTS,
        );
      case "person-annotation":
        return foldGroupedRows(
          family,
          loadAnnotationGroups(db, "person_annotations", sinceMs),
          ANNOTATION_CLASS_VERDICTS,
        );
    }
  });
  return { generatedAt: now, sinceDays, families };
}
