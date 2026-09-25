// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fuzzy merge-candidate detection.
 *
 * Distinct from `merge_rules` (which directly drive `people.merged_into`):
 * candidates are *suggestions* surfaced to the operator. The user
 * accepts → a `kind='user'` rule is created; the user denies → the
 * candidate row stays as a permanent veto so the detector never re-
 * proposes the same pair.
 *
 * Detection is name-token overlap with IDF weighting. Cross-type
 * (email ↔ name) is supported by tokenizing emails into their
 * underlying name parts (`bondeve@gmail.com` → ["bond",
 * "eve"]). Substring fallback handles concatenated locals
 * without separators. See `scoreTokenBags` for the full formula.
 *
 * Auto-detect (shared email/phone/lid + matching contact-card name)
 * fires *before* this — those pairs are already merged by the eval
 * pass, so they fall out of the unmerged-people scan here. The
 * candidates surfaced are precisely those autoDetect can't catch.
 *
 * Pure scoring + tokenization live in `./domain/MergeCandidateDetector.ts`
 * so the algorithm is testable without a database. This file owns the
 * SQL persistence and the orchestration that pairs the scorer with the
 * `merge_candidates` / `merge_rules` tables.
 */

import { createHash, randomUUID } from "node:crypto";
import { createLogger, hasValidEmailTld } from "@omnesis/core";

import { createMergeRule, getMergeRuleById, getSelfPersonId, resolveAliasSide } from "./people.js";
import {
  ROLE_TOKEN_MIN_SPREAD,
  buildDomainSpread,
  distinctNameConcepts,
  findIdentityBridges,
  hasFirstNameConflict,
  hasInternalNameConflict,
  hasSurnameConflict,
  isGenericOrgPair,
  isHighConfidenceMerge,
  isHubPerson,
  isPersonEntity,
  rankCandidateClusters,
  shouldSuppressCandidate,
  type MergeCandidateProposal,
  type SuppressionContext,
  type TokenLabel,
} from "./domain/MergeCandidateDetector.js";
import { loadNonIdentifyingEmails } from "./data/repositories/PersonRepository.js";
import { scoreMergeCandidates } from "./merge-candidates-cpu.js";
import { mergeCandidatesMatchedTokensCodec } from "./data/json-columns.js";
import type { ResolvedSidePerson } from "./domain/merge/index.js";
import type {
  CreateMergeRuleResult,
  MergeRule,
  MergeRuleAliasType,
  MergeRuleKind,
  MergeWinnerSide,
} from "./people.js";
import type Database from "better-sqlite3";

export {
  DEFAULT_SCORE_THRESHOLD,
  DEFAULT_MERGE_CANDIDATE_MAX_RESULTS,
  scoreTokenBags,
  tokenizeAlias,
  tokenizeEmail,
  tokenizeName,
  type IdfContext,
  type MergeCandidateProposal,
  type ScoreResult,
  type TokenIdf,
} from "./domain/MergeCandidateDetector.js";

type Db = Database.Database;
const log = createLogger("gateway:merge-candidates");

// ─── Candidate computation ───────────────────────────────────────────

interface PersonAliasRow {
  person_id: string;
  alias_type: string;
  alias: string;
  /** 1 on the dominant name alias; 0 otherwise (and on non-name aliases). */
  is_primary: number;
}

const STRENGTH_RANK: Record<MergeRuleAliasType, number> = {
  email: 0,
  phone: 1,
  lid: 2,
  name: 3,
};

// ─── Token identity labels (role-mailbox suppression) ────────────────

/** Read the full token → identity-label map. Tiny table; loaded whole. */
export function loadTokenLabels(db: Db): Map<string, TokenLabel> {
  const rows = db
    .prepare<[], { token: string; label: string }>("SELECT token, label FROM token_identity_labels")
    .all();
  const map = new Map<string, TokenLabel>();
  for (const r of rows) map.set(r.token, r.label as TokenLabel);
  return map;
}

export interface TokenLabelRow {
  token: string;
  label: TokenLabel;
  domainSpread: number;
}

/** Upsert classifier verdicts. Idempotent; last write wins per token. */
export function upsertTokenLabels(db: Db, rows: readonly TokenLabelRow[]): { upserted: number } {
  if (rows.length === 0) return { upserted: 0 };
  const stmt = db.prepare(
    `INSERT INTO token_identity_labels (token, label, domain_spread, classified_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       label = excluded.label,
       domain_spread = excluded.domain_spread,
       classified_at = excluded.classified_at`,
  );
  const now = new Date().toISOString();
  const tx = db.transaction((batch: readonly TokenLabelRow[]) => {
    for (const r of batch) stmt.run(r.token, r.label, r.domainSpread, now);
  });
  tx(rows);
  return { upserted: rows.length };
}

/** Unmerged, non-self email aliases — the corpus that drives domain-spread. */
function unmergedEmailAliases(db: Db): Array<{ alias_type: string; alias: string }> {
  return db
    .prepare<[], { alias_type: string; alias: string }>(
      `SELECT pa.alias_type, pa.alias
       FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       WHERE p.merged_into IS NULL AND COALESCE(p.is_self, 0) = 0 AND pa.alias_type = 'email'`,
    )
    .all();
}

/**
 * Build the suppression context straight from the DB: domain-spread over the
 * unmerged-people email aliases, the token labels, and the non-identifying
 * email blocklist. Used by the in-process detector, the prune sweep, and the
 * candidate-list view layer; the CPU path reconstructs the same context from
 * pre-fetched data.
 */
export function loadSuppressionContext(db: Db): SuppressionContext {
  return {
    domainSpread: buildDomainSpread(unmergedEmailAliases(db)),
    tokenLabels: loadTokenLabels(db),
    blockedEmails: new Set([...loadNonIdentifyingEmails(db)].map((e) => e.toLowerCase())),
  };
}

export interface TokenClassificationCandidate {
  token: string;
  domainSpread: number;
}

/**
 * High-spread email-local tokens that have no identity label yet — the work
 * queue for the classifier task. Sorted by spread desc (most-generic-looking
 * first) and capped. Returns empty once every high-spread token is labeled,
 * which is the steady state.
 */
export function selectTokensNeedingClassification(
  db: Db,
  opts: { minSpread?: number; limit?: number } = {},
): TokenClassificationCandidate[] {
  const minSpread = opts.minSpread ?? ROLE_TOKEN_MIN_SPREAD;
  const limit = opts.limit ?? 200;
  const spread = buildDomainSpread(unmergedEmailAliases(db));
  const labeled = new Set(loadTokenLabels(db).keys());
  const out: TokenClassificationCandidate[] = [];
  for (const [token, n] of spread) {
    if (n < minSpread || labeled.has(token)) continue;
    out.push({ token, domainSpread: n });
  }
  out.sort((a, b) => b.domainSpread - a.domainSpread);
  if (out.length > limit) out.length = limit;
  return out;
}

export interface ComputeMergeCandidatesOpts {
  scoreThreshold?: number;
  /** Cap candidate proposals per run. Defaults to
   *  {@link DEFAULT_MERGE_CANDIDATE_MAX_RESULTS}; the lenient scorer surfaces
   *  many high-confidence containment pairs (bag ⊆ bag scores 1.0 whenever one
   *  side's tokens are all matched), so the cap needs headroom to still reach
   *  lower-scoring family-name matches (a full "First Last" ↔ phone-only First). */
  maxResults?: number;
  /**
   * Interaction-score percentile gate. A candidate is only proposed
   * if AT LEAST ONE side's person has `interaction_score_recent`
   * above the percentile boundary. This gates noise — long-tail
   * system mailboxes / newsletter senders all sit at score 0 and
   * generate the bulk of the false positives. Default 0.90 (top
   * 10%) on a typical graph keeps real-contact pairs but kills the
   * "noreply A ↔ noreply B" class. Set to 0 to disable.
   */
  headPercentile?: number;
}

/**
 * Read-only fuzzy candidate computation. Compute-worker compatible.
 *
 * 1. Load every unmerged non-self person's aliases.
 * 2. Tokenize each alias; build per-person token bags.
 * 3. Build IDF over the token corpus.
 * 4. Inverted index: token → personIds (skip very-common tokens).
 * 5. Generate candidate pairs from the index, dedupe, score each.
 * 6. Filter by threshold; skip pairs already in `merge_candidates`
 *    (status `denied` = veto, `accepted` = rule already exists).
 *
 * Distinct from `computeAutoMergePairs` in `people.ts`, which only
 * emits exact-match pairs (shared identifier or contact-curated name)
 * that flow into automatic merges. This function emits cross-identifier
 * scored proposals that are surfaced for user review.
 */
export function computeFuzzyMergeCandidates(
  db: Db,
  opts: ComputeMergeCandidatesOpts = {},
): MergeCandidateProposal[] {
  // Synchronous wrapper over the production three-phase pipeline: fetch the raw
  // rows (the IO phase) then run the pure CPU scorer. Kept so unit tests can
  // drive the full detector from a `db` in one call without the worker hop.
  return scoreMergeCandidates(fetchMergeCandidatesData(db), opts);
}

/**
 * IO-only fetch for the three-phase merge-candidate pipeline. Returns
 * the raw SQL data the CPU pool needs for scoring.
 */
export function fetchMergeCandidatesData(
  db: Db,
): import("./merge-candidates-cpu.js").MergeCandidatesFetchData {
  const aliasRows = db
    .prepare<[], PersonAliasRow>(
      // Every alias is fetched (with is_primary), but only the DOMINANT name is
      // tokenized for matching downstream — minority names accreted onto a shared
      // identifier are kept for the hub / conflict gates to inspect, yet can no
      // longer drive a candidate. The CPU enforces the tokenize split.
      `SELECT pa.person_id, pa.alias_type, pa.alias, pa.is_primary
       FROM person_aliases pa
       JOIN people p ON p.id = pa.person_id
       WHERE p.merged_into IS NULL AND COALESCE(p.is_self, 0) = 0`,
    )
    .all();
  const scoreRows = db
    .prepare<[], { id: string; score: number }>(
      `SELECT id, COALESCE(interaction_score_recent, 0) AS score
       FROM people
       WHERE merged_into IS NULL AND COALESCE(is_self, 0) = 0`,
    )
    .all();
  const existingDecided = db
    .prepare<
      [],
      {
        side_a_alias_type: string;
        side_a_alias: string;
        side_b_alias_type: string;
        side_b_alias: string;
      }
    >(
      `SELECT side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias
       FROM merge_candidates
       WHERE status IN ('accepted','denied')`,
    )
    .all();
  const decidedKeys = existingDecided.map((r) => {
    const [lo, hi] =
      r.side_a_alias_type < r.side_b_alias_type ||
      (r.side_a_alias_type === r.side_b_alias_type && r.side_a_alias <= r.side_b_alias)
        ? [r, { aliasType: r.side_b_alias_type, alias: r.side_b_alias }]
        : [{ aliasType: r.side_b_alias_type, alias: r.side_b_alias }, r];
    const a =
      "side_a_alias_type" in lo
        ? { aliasType: (lo as typeof r).side_a_alias_type, alias: (lo as typeof r).side_a_alias }
        : (lo as { aliasType: string; alias: string });
    const b =
      "side_b_alias_type" in hi
        ? { aliasType: (hi as typeof r).side_b_alias_type, alias: (hi as typeof r).side_b_alias }
        : (hi as { aliasType: string; alias: string });
    return `${a.aliasType}|${a.alias}|${b.aliasType}|${b.alias}`;
  });
  const tokenLabels = db
    .prepare<[], { token: string; label: string }>("SELECT token, label FROM token_identity_labels")
    .all();
  const blockedEmails = [...loadNonIdentifyingEmails(db)];
  return { aliasRows, scoreRows, decidedKeys, tokenLabels, blockedEmails };
}

/**
 * Canonical (sorted) key for a candidate's (sideA, sideB). Same
 * convention as `merge_rules` so the unique index aligns. The lex
 * order is on (aliasType, alias).
 */
function canonicalCandidateKey(
  a: { aliasType: MergeRuleAliasType; alias: string },
  b: { aliasType: MergeRuleAliasType; alias: string },
): string {
  const cmp =
    a.aliasType !== b.aliasType
      ? a.aliasType.localeCompare(b.aliasType)
      : a.alias.localeCompare(b.alias);
  if (cmp <= 0) return `${a.aliasType}|${a.alias}|${b.aliasType}|${b.alias}`;
  return `${b.aliasType}|${b.alias}|${a.aliasType}|${a.alias}`;
}

function canonicalSides<T extends { aliasType: MergeRuleAliasType; alias: string }>(
  a: T,
  b: T,
): { sideA: T; sideB: T; flipped: boolean } {
  const cmp =
    a.aliasType !== b.aliasType
      ? a.aliasType.localeCompare(b.aliasType)
      : a.alias.localeCompare(b.alias);
  if (cmp <= 0) return { sideA: a, sideB: b, flipped: false };
  return { sideA: b, sideB: a, flipped: true };
}

// ─── Storage / writer ops ────────────────────────────────────────────

export type MergeCandidateStatus = "pending" | "accepted" | "denied";

/** The background agent's verdict on a candidate (merge adjudication). */
export type MergeAdjudicationVerdict = "merge" | "distinct" | "unsure";

export interface MergeCandidateRow {
  id: string;
  sideA: { aliasType: MergeRuleAliasType; alias: string };
  sideB: { aliasType: MergeRuleAliasType; alias: string };
  score: number;
  detectionKind: string;
  matchedTokens: string[];
  /** Name-match strength multiplier for the rank; null on legacy rows. */
  matchStrength: number | null;
  status: MergeCandidateStatus;
  detectedAt: string;
  decidedAt: string | null;
  ruleId: string | null;
  /** When the background agent last adjudicated this candidate; null = never. */
  adjudicatedAt: string | null;
  /** The agent's verdict; null when never adjudicated. */
  adjudicationVerdict: MergeAdjudicationVerdict | null;
  /** The agent's user-visible rationale; null when never adjudicated. */
  adjudicationReason: string | null;
  /**
   * Fingerprint of the evidence the last adjudication saw. The re-adjudication
   * filter compares it with the row's current evidence, so a candidate is
   * re-judged when what it rests on changed — not when a clock moved.
   */
  adjudicationEvidenceFingerprint: string | null;
  /** How many times the agent has adjudicated this candidate. */
  adjudicationCount: number;
}

interface MergeCandidateDbRow {
  id: string;
  side_a_alias_type: string;
  side_a_alias: string;
  side_b_alias_type: string;
  side_b_alias: string;
  score: number;
  detection_kind: string;
  matched_tokens: string | null;
  match_strength: number | null;
  status: string;
  detected_at: string;
  decided_at: string | null;
  rule_id: string | null;
  adjudicated_at: string | null;
  adjudication_verdict: string | null;
  adjudication_reason: string | null;
  adjudication_evidence_fingerprint: string | null;
  adjudication_count: number | null;
}

/** The candidate columns every SELECT in this module reads. */
const CANDIDATE_COLUMNS =
  "id, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias, " +
  "score, detection_kind, matched_tokens, match_strength, status, detected_at, decided_at, rule_id, " +
  "adjudicated_at, adjudication_verdict, adjudication_reason, " +
  "adjudication_evidence_fingerprint, adjudication_count";

/**
 * Quantization bands for the evidence fingerprint. The detection score and
 * match strength are computed from corpus-wide token statistics (IDF over the
 * whole alias set), so ingesting an unrelated person moves them in the far
 * decimals while this pair's evidence is untouched. Rounding to the precision
 * the evidence pack actually shows makes "the evidence changed" mean what it
 * says.
 */
const EVIDENCE_SCORE_DECIMALS = 3;
const EVIDENCE_STRENGTH_DECIMALS = 2;

function quantize(value: number, decimals: number): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : "nan";
}

/**
 * Stable fingerprint of a candidate's pair-local evidence: which tokens
 * matched, and how strongly, at display precision.
 *
 * Two consumers share it, and must: the detector uses it to decide whether a
 * re-proposal is a real change (and so whether `detected_at` moves), and the
 * adjudication enqueuer uses it to decide whether a judged candidate deserves
 * a fresh verdict. If they disagreed, one of them would be wrong every time
 * the other was right.
 */
export function mergeCandidateEvidenceFingerprint(evidence: {
  matchedTokens: readonly string[];
  score: number;
  matchStrength: number | null;
}): string {
  const canonical = JSON.stringify({
    t: [...evidence.matchedTokens].sort(),
    s: quantize(evidence.score, EVIDENCE_SCORE_DECIMALS),
    m:
      evidence.matchStrength === null
        ? null
        : quantize(evidence.matchStrength, EVIDENCE_STRENGTH_DECIMALS),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function rowToCandidate(r: MergeCandidateDbRow): MergeCandidateRow {
  const matched = r.matched_tokens
    ? mergeCandidatesMatchedTokensCodec.parseWithFallback(r.matched_tokens, { rowId: r.id })
    : [];
  return {
    id: r.id,
    sideA: { aliasType: r.side_a_alias_type as MergeRuleAliasType, alias: r.side_a_alias },
    sideB: { aliasType: r.side_b_alias_type as MergeRuleAliasType, alias: r.side_b_alias },
    score: r.score,
    detectionKind: r.detection_kind,
    matchedTokens: matched,
    matchStrength: r.match_strength,
    status: r.status as MergeCandidateStatus,
    detectedAt: r.detected_at,
    decidedAt: r.decided_at,
    ruleId: r.rule_id,
    adjudicatedAt: r.adjudicated_at,
    adjudicationVerdict: r.adjudication_verdict as MergeAdjudicationVerdict | null,
    adjudicationReason: r.adjudication_reason,
    adjudicationEvidenceFingerprint: r.adjudication_evidence_fingerprint,
    adjudicationCount: r.adjudication_count ?? 0,
  };
}

/** The fingerprint of the evidence this row currently rests on. */
export function currentEvidenceFingerprint(cand: MergeCandidateRow): string {
  return mergeCandidateEvidenceFingerprint({
    matchedTokens: cand.matchedTokens,
    score: cand.score,
    matchStrength: cand.matchStrength,
  });
}

/**
 * How many times one candidate may be adjudicated before it stops being
 * offered to the agent.
 *
 * The evidence fingerprint already stops the common loop, but a pair whose
 * evidence genuinely keeps moving could still be re-judged indefinitely, and
 * some pairs are not resolvable by an agent at all: when the writer guards
 * will refuse a merge and `distinct` would be wrong, `unsure` is the only
 * honest verdict, and repeating it spends a full run to learn nothing. Past
 * this many verdicts the candidate is the operator's to settle.
 */
export const MERGE_ADJUDICATION_MAX_PER_CANDIDATE = 3;

/**
 * Does this pending candidate deserve a (fresh) verdict?
 *
 * Never judged → yes. Judged, and the evidence still fingerprints the same →
 * no: the verdict on the row already answers the question being asked. Judged
 * against different evidence → yes, up to the per-candidate ceiling.
 */
export function isAdjudicationDue(cand: MergeCandidateRow): boolean {
  if (cand.adjudicatedAt === null) return true;
  if (cand.adjudicationCount >= MERGE_ADJUDICATION_MAX_PER_CANDIDATE) return false;
  // A verdict from before fingerprints existed carries no record of what it
  // saw. Falling back to the timestamp comparison would re-open exactly the
  // rows this exists to close, so treat it as covering the current evidence;
  // the next real change writes a fingerprint and normal service resumes.
  if (cand.adjudicationEvidenceFingerprint === null) return false;
  return cand.adjudicationEvidenceFingerprint !== currentEvidenceFingerprint(cand);
}

/**
 * A judged candidate the agent cannot take further.
 *
 * Being still `pending` after a verdict is itself the signal, so this needs no
 * list of verdicts to look for: `distinct` denies the candidate and an applied
 * `merge` accepts it, so either way it leaves the pending set. What remains
 * pending is what the agent could not settle — an `unsure`, or a `merge` the
 * writer guards refused — and once that verdict covers the current evidence
 * nothing will revisit it. Surfacing these is the difference between "the
 * Brain is still working on it" and "this one is waiting for you".
 */
export function needsOperatorAdjudication(cand: MergeCandidateRow): boolean {
  if (cand.status !== "pending" || cand.adjudicatedAt === null) return false;
  return !isAdjudicationDue(cand);
}

/**
 * Apply a set of computed proposals. For each proposal:
 *   - If a row exists with status `denied` or `accepted`: leave it
 *     (decision is durable).
 *   - If a row exists with status `pending` and the proposal MATERIALLY
 *     differs — a different evidence fingerprint, i.e. different matched
 *     tokens or a score/strength that moved at display precision — update the
 *     stored evidence and bump detected_at.
 *   - If it differs only below that precision, store the refreshed numbers but
 *     leave detected_at where it is: detected_at marks when the evidence last
 *     changed, not when the detector last ran. The score is derived from
 *     corpus-wide token frequencies, so it drifts in the far decimals whenever
 *     anything is ingested anywhere; treating that as change re-armed every
 *     consumer keyed on the timestamp.
 *   - Otherwise insert a new pending row.
 *
 * Returns counts of inserted vs refreshed vs skipped rows. Sub-precision drift
 * counts as skipped — nothing downstream should react to it.
 */
export interface UpsertMergeCandidatesResult {
  inserted: number;
  refreshed: number;
  skipped: number;
}

export function upsertMergeCandidates(
  db: Db,
  proposals: readonly MergeCandidateProposal[],
): UpsertMergeCandidatesResult {
  const out: UpsertMergeCandidatesResult = { inserted: 0, refreshed: 0, skipped: 0 };
  if (proposals.length === 0) return out;

  const findStmt = db.prepare<
    [string, string, string, string],
    {
      id: string;
      status: string;
      score: number;
      matched_tokens: string | null;
      match_strength: number | null;
    }
  >(
    `SELECT id, status, score, matched_tokens, match_strength FROM merge_candidates
     WHERE side_a_alias_type = ? AND side_a_alias = ?
       AND side_b_alias_type = ? AND side_b_alias = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO merge_candidates
       (id, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias,
        score, detection_kind, matched_tokens, match_strength, status, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const refreshStmt = db.prepare(
    `UPDATE merge_candidates
        SET score = ?, matched_tokens = ?, match_strength = ?, detected_at = ?
      WHERE id = ?`,
  );
  // Sub-precision drift: keep the numbers current for display and ranking, but
  // do not touch detected_at.
  const restateStmt = db.prepare(
    `UPDATE merge_candidates
        SET score = ?, matched_tokens = ?, match_strength = ?
      WHERE id = ?`,
  );

  const now = new Date().toISOString();
  const tx = db.transaction((rows: readonly MergeCandidateProposal[]) => {
    for (const p of rows) {
      const canon = canonicalSides(p.sideA, p.sideB);
      const existing = findStmt.get(
        canon.sideA.aliasType,
        canon.sideA.alias,
        canon.sideB.aliasType,
        canon.sideB.alias,
      );
      if (existing) {
        if (existing.status === "pending") {
          const tokens = mergeCandidatesMatchedTokensCodec.serialize([...p.matchedTokens]);
          const identical =
            existing.score === p.score &&
            existing.matched_tokens === tokens &&
            (existing.match_strength ?? null) === (p.matchStrength ?? null);
          if (identical) {
            out.skipped += 1;
            continue;
          }
          const before = mergeCandidateEvidenceFingerprint({
            matchedTokens: existing.matched_tokens
              ? mergeCandidatesMatchedTokensCodec.parseWithFallback(existing.matched_tokens, {
                  rowId: existing.id,
                })
              : [],
            score: existing.score,
            matchStrength: existing.match_strength ?? null,
          });
          const after = mergeCandidateEvidenceFingerprint({
            matchedTokens: p.matchedTokens,
            score: p.score,
            matchStrength: p.matchStrength ?? null,
          });
          if (before === after) {
            restateStmt.run(p.score, tokens, p.matchStrength ?? null, existing.id);
            out.skipped += 1;
          } else {
            refreshStmt.run(p.score, tokens, p.matchStrength ?? null, now, existing.id);
            out.refreshed += 1;
          }
        } else {
          // accepted / denied — durable, never re-propose.
          out.skipped += 1;
        }
        continue;
      }
      insertStmt.run(
        randomUUID(),
        canon.sideA.aliasType,
        canon.sideA.alias,
        canon.sideB.aliasType,
        canon.sideB.alias,
        p.score,
        p.detectionKind,
        mergeCandidatesMatchedTokensCodec.serialize([...p.matchedTokens]),
        p.matchStrength ?? null,
        now,
      );
      out.inserted += 1;
    }
  });
  tx(proposals);
  return out;
}

export interface ListMergeCandidatesOpts {
  status?: MergeCandidateStatus;
  limit?: number;
}

/**
 * Reconcile the pending set to the latest detection output: delete `pending`
 * rows whose pair is no longer in `proposals`. Without this, a candidate that
 * the detector stops surfacing (because the algorithm changed — e.g. a name
 * that no longer fragments, or a newly-excluded hub) lingers forever, since
 * `upsertMergeCandidates` only inserts / refreshes. `denied` (durable veto)
 * and `accepted` rows are never touched. Caller must pass a COMPLETE proposal
 * set (skip when the detector hit its result cap, or this would delete the
 * uncapped tail).
 */
export function reconcilePendingMergeCandidates(
  db: Db,
  proposals: readonly MergeCandidateProposal[],
): { deleted: number } {
  const keep = new Set<string>();
  for (const p of proposals) keep.add(canonicalCandidateKey(p.sideA, p.sideB));
  const pending = db
    .prepare<
      [],
      {
        id: string;
        side_a_alias_type: string;
        side_a_alias: string;
        side_b_alias_type: string;
        side_b_alias: string;
      }
    >(
      `SELECT id, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias
       FROM merge_candidates WHERE status = 'pending'`,
    )
    .all();
  const toDelete = pending
    .filter(
      (r) =>
        !keep.has(
          canonicalCandidateKey(
            { aliasType: r.side_a_alias_type as MergeRuleAliasType, alias: r.side_a_alias },
            { aliasType: r.side_b_alias_type as MergeRuleAliasType, alias: r.side_b_alias },
          ),
        ),
    )
    .map((r) => r.id);
  if (toDelete.length === 0) return { deleted: 0 };
  const tx = db.transaction((ids: string[]) => {
    const stmt = db.prepare("DELETE FROM merge_candidates WHERE id = ? AND status = 'pending'");
    for (const id of ids) stmt.run(id);
  });
  tx(toDelete);
  log.info(`Reconciled pending candidates: deleted ${toDelete.length} no longer proposed`);
  return { deleted: toDelete.length };
}

export function listMergeCandidates(
  db: Db,
  opts: ListMergeCandidatesOpts = {},
): MergeCandidateRow[] {
  const limit = Math.min(opts.limit ?? 100, 500);
  const status = opts.status ?? "pending";
  const rows = db
    .prepare<[string, number], MergeCandidateDbRow>(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM merge_candidates
       WHERE status = ?
       ORDER BY score DESC, detected_at DESC
       LIMIT ?`,
    )
    .all(status, limit);
  return rows.map(rowToCandidate);
}

/**
 * All candidates of a status, uncapped — input for the cluster-aware portal
 * ranker, which must see the whole pending graph to form clusters before it
 * limits to the display window. Pending is bounded by the detector's
 * `maxResults`, so this stays small.
 */
export function listAllMergeCandidates(db: Db, status: MergeCandidateStatus): MergeCandidateRow[] {
  const rows = db
    .prepare<[string], MergeCandidateDbRow>(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM merge_candidates
       WHERE status = ?
       ORDER BY id ASC`,
    )
    .all(status);
  return rows.map(rowToCandidate);
}

function listDecidedMergeCandidatesPage(
  db: Db,
  status: "accepted" | "denied",
  limit: number,
  after?: { sortAt: string; id: string },
  query = "",
): MergeCandidateRow[] {
  const escapedQuery = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const pattern = escapedQuery.length > 0 ? `%${escapedQuery}%` : "";
  const rows = db
    .prepare<
      [
        MergeCandidateStatus,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
      ],
      MergeCandidateDbRow
    >(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM merge_candidates mc
        WHERE mc.status = ?
          AND (
            ? = ''
            OR COALESCE(mc.decided_at, mc.detected_at) < ?
            OR (COALESCE(mc.decided_at, mc.detected_at) = ? AND mc.id < ?)
          )
          AND (
            ? = ''
            OR LOWER(mc.side_a_alias) LIKE ? ESCAPE '\\'
            OR LOWER(mc.side_b_alias) LIKE ? ESCAPE '\\'
            OR EXISTS (
              SELECT 1
                FROM person_aliases side_alias
                JOIN people owner ON owner.id = side_alias.person_id
                JOIN people canonical
                  ON canonical.id = COALESCE(owner.merged_into, owner.id)
                 AND canonical.merged_into IS NULL
               WHERE (
                 (
                   side_alias.alias_type = mc.side_a_alias_type
                   AND (
                     (mc.side_a_alias_type = 'name'
                       AND LOWER(side_alias.alias) = LOWER(mc.side_a_alias))
                     OR (mc.side_a_alias_type <> 'name'
                       AND side_alias.alias = mc.side_a_alias)
                   )
                 )
                 OR (
                   side_alias.alias_type = mc.side_b_alias_type
                   AND (
                     (mc.side_b_alias_type = 'name'
                       AND LOWER(side_alias.alias) = LOWER(mc.side_b_alias))
                     OR (mc.side_b_alias_type <> 'name'
                       AND side_alias.alias = mc.side_b_alias)
                   )
                 )
               )
               AND (
                 LOWER(canonical.canonical_name) LIKE ? ESCAPE '\\'
                 OR EXISTS (
                   SELECT 1
                     FROM person_aliases visible_alias
                    WHERE visible_alias.person_id = canonical.id
                      AND LOWER(visible_alias.alias) LIKE ? ESCAPE '\\'
                 )
               )
            )
          )
        ORDER BY COALESCE(mc.decided_at, mc.detected_at) DESC, mc.id DESC
        LIMIT ?`,
    )
    // The repeated empty sentinel keeps the statement static while preserving
    // an indexed first-page order. Decided rows normally have decided_at; the
    // COALESCE keeps legacy rows reachable.
    .all(
      status,
      after?.sortAt ?? "",
      after?.sortAt ?? "",
      after?.sortAt ?? "",
      after?.id ?? "",
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      limit,
    );
  return rows.map(rowToCandidate);
}

/**
 * Why the view layer hides a merge candidate, or `null` when nothing hides it.
 *
 * The detector proposes generously and most raw proposals are junk, so the
 * view re-applies the gates the generator applies rather than waiting for the
 * gated detector to re-run and prune the persisted row. Each veto is NAMED
 * rather than folded into one boolean because "why is this pair not in my
 * queue?" is otherwise unanswerable without re-deriving the whole chain by
 * hand — `explainMergeCandidateVisibility` reports these.
 */
export type MergeCandidateVeto =
  | "single-name-concept"
  | "collapsed"
  | "invalid-email-tld"
  | "hub"
  | "identity-bridge"
  | "suppressed"
  | "first-name-conflict"
  | "surname-conflict"
  | "generic-org";

/**
 * A pending row the Brain already adjudicated is listed whatever the vetoes
 * say. The vetoes damp DETECTOR noise; adjudication is a strictly stronger
 * signal than those heuristics, so a row that has been through it is no longer
 * theirs to judge.
 *
 * Deliberately broader than `needsOperatorAdjudication`: it also admits rows
 * whose evidence changed since the verdict, which the Brain will revisit and
 * which are therefore listed but not badged. Adjudicating a pair at all is the
 * evidence that it is worth a human's eye; whether the Brain is finished with
 * it decides whether the operator is being ASKED to act, which is what the
 * badge says. Being the wider set is also what makes the badge safe — every
 * row `needsOperatorAdjudication` counts satisfies this predicate, so counted
 * always implies listed.
 */
function surfacesDespiteVeto(cand: MergeCandidateRow): boolean {
  return cand.status === "pending" && cand.adjudicatedAt !== null;
}

/**
 * Resolve both alias sides of every candidate to people, once, sharing a cache
 * across the set — the same alias recurs across many candidates. Also yields
 * the two per-person facts the ranker and the vetoes need, so nothing has to
 * re-walk the alias lists later.
 */
function resolveCandidateSides(
  db: Db,
  candidates: readonly MergeCandidateRow[],
): {
  resolvedById: Map<
    string,
    { a: ResolvedSidePerson[]; b: ResolvedSidePerson[]; personIds: string[] }
  >;
  personInteraction: Map<string, number>;
  personIsPerson: Map<string, boolean>;
} {
  const resolveCache = new Map<string, ResolvedSidePerson[]>();
  const personInteraction = new Map<string, number>();
  const personIsPerson = new Map<string, boolean>();
  const resolvedById = new Map<
    string,
    { a: ResolvedSidePerson[]; b: ResolvedSidePerson[]; personIds: string[] }
  >();
  for (const cand of candidates) {
    const a = resolveAliasSide(db, cand.sideA, { withDetails: true, cache: resolveCache });
    const b = resolveAliasSide(db, cand.sideB, { withDetails: true, cache: resolveCache });
    for (const p of [...a, ...b]) {
      personInteraction.set(p.id, p.interactionScoreRecent ?? 0);
      personIsPerson.set(p.id, isPersonEntity(p.aliases ?? []));
    }
    resolvedById.set(cand.id, {
      a,
      b,
      personIds: [...a.map((p) => p.id), ...b.map((p) => p.id)],
    });
  }
  return { resolvedById, personInteraction, personIsPerson };
}

/**
 * Build the per-request veto evaluator. The hub lookup, corpus suppression
 * context and identity-bridge graph are derived once over the whole candidate
 * set (bridges are a property of the graph, not of one pair), then shared by
 * every call.
 */
function buildVetoEvaluator(
  db: Db,
  ctx: {
    resolvedById: Map<string, { a: ResolvedSidePerson[]; b: ResolvedSidePerson[] }>;
    personIsPerson: Map<string, boolean>;
    candidates: readonly MergeCandidateRow[];
  },
): (cand: MergeCandidateRow) => MergeCandidateVeto | null {
  const hubById = new Map<string, boolean>();
  const isHub = (p: ResolvedSidePerson): boolean => {
    let v = hubById.get(p.id);
    if (v === undefined) {
      v = isHubPerson(
        (p.aliases ?? []).filter((al) => al.aliasType === "name").map((al) => al.alias),
      );
      hubById.set(p.id, v);
    }
    return v;
  };
  const suppression = loadSuppressionContext(db);
  // Identity-bridge guard (mirror of the generation pass): a record matching
  // different people on token-disjoint sets fuses unrelated clusters into one.
  const bridgeEdges: { a: string; b: string; matchedTokens: readonly string[] }[] = [];
  for (const cand of ctx.candidates) {
    const r = ctx.resolvedById.get(cand.id);
    const aId = r?.a[0]?.id;
    const bId = r?.b[0]?.id;
    if (aId && bId) bridgeEdges.push({ a: aId, b: bId, matchedTokens: cand.matchedTokens });
  }
  const bridges = findIdentityBridges(bridgeEdges);

  return (cand) => {
    if (distinctNameConcepts(cand.matchedTokens).length < 2) return "single-name-concept";
    const { a, b } = ctx.resolvedById.get(cand.id)!;
    // Collapsed / unresolvable: both sides already resolve to one person (a
    // no-op "Merge 1") or to none (an "Unknown · 0 entities" row whose alias
    // was deleted/merged away). The sweep + prune tasks remove these from the
    // table; this keeps them out of the view regardless of cleanup timing.
    if (new Set([...a, ...b].map((p) => p.id)).size < 2) return "collapsed";
    // An invalid-TLD email is an extraction artifact. The detector stops
    // generating these; this hides an already-persisted row immediately,
    // before the next detection pass prunes it.
    for (const s of [cand.sideA, cand.sideB]) {
      if (s.aliasType === "email" && !hasValidEmailTld(s.alias)) return "invalid-email-tld";
    }
    if ([...a, ...b].some(isHub)) return "hub";
    if ([...a, ...b].some((p) => bridges.has(p.id))) return "identity-bridge";
    if (shouldSuppressCandidate(cand.sideA, cand.sideB, cand.matchedTokens, suppression)) {
      return "suppressed";
    }
    const aliasesA = a.flatMap((p) => p.aliases ?? []);
    const aliasesB = b.flatMap((p) => p.aliases ?? []);
    if (hasFirstNameConflict(aliasesA, aliasesB, cand.matchedTokens)) return "first-name-conflict";
    if (hasSurnameConflict(aliasesA, aliasesB, cand.matchedTokens)) return "surname-conflict";
    // Generic-org veto. No corpus token-frequency at the view layer, so this
    // catches the role/structural-word org pairs immediately; the high-frequency
    // (place / platform) cases are pruned by the detector's next pass.
    if (
      isGenericOrgPair(
        cand.sideA,
        cand.sideB,
        cand.matchedTokens,
        a.some((p) => ctx.personIsPerson.get(p.id) ?? false),
        b.some((p) => ctx.personIsPerson.get(p.id) ?? false),
        () => false,
      )
    ) {
      return "generic-org";
    }
    return null;
  };
}

/**
 * Render the enriched merge-candidates list (GET /people/merge-candidates):
 * per-side resolved-person info, the view-layer suppression vetoes, and the
 * cluster-aware rank. Pure `db` read — runs on the read-worker pool
 * (`io.enrichedMergeCandidates`) or, absent a gate, the main thread. The
 * whole-pending scan (up to 5000) + union-find is heavy enough to belong off
 * the main event loop.
 */
export function computeEnrichedMergeCandidates(
  db: Db,
  opts: {
    status: MergeCandidateStatus;
    limit: number;
    clusterLimit?: number;
    clusterAfter?: MergeCandidateClusterCursor;
    q?: string;
  },
) {
  const q = opts.q?.trim().toLowerCase() ?? "";
  const historyPaging = opts.status !== "pending" && opts.clusterLimit !== undefined;
  const historyAfter =
    historyPaging && opts.clusterAfter?.kind === "history" ? opts.clusterAfter : undefined;
  const historyProbe = historyPaging
    ? listDecidedMergeCandidatesPage(
        db,
        opts.status as "accepted" | "denied",
        Math.max(1, opts.clusterLimit!) + 1,
        historyAfter,
        q,
      )
    : null;
  // Fetch the WHOLE status set, not a pre-limited window: clusters
  // (connected components of candidate pairs) must be formed over the full
  // graph before we limit, so a high-interaction member can lift its whole
  // pending graph into the display window and keep it contiguous. Settled
  // history is no longer actionable as a cluster, so its default list path
  // reads one decision-time page directly instead of rescanning all history.
  const candidates = historyProbe
    ? historyProbe.slice(0, opts.clusterLimit)
    : listAllMergeCandidates(db, opts.status);
  const { resolvedById, personInteraction, personIsPerson } = resolveCandidateSides(db, candidates);

  const veto = buildVetoEvaluator(db, { resolvedById, personIsPerson, candidates });
  // An adjudicated pending row outranks the vetoes — see `surfacesDespiteVeto`.
  // Settled history preserves the operator's decisions even if today's graph
  // would veto the original proposal.
  const visible = historyPaging
    ? candidates
    : candidates.filter((cand) => surfacesDespiteVeto(cand) || veto(cand) === null);

  // Cluster-aware rank: a candidate's interaction is the MAX across its
  // cluster, every member takes the cluster's best rank, and clusters stay
  // contiguous (see rankCandidateClusters).
  const rankable = visible.map((cand) => ({
    id: cand.id,
    personIds: resolvedById.get(cand.id)!.personIds,
    score: cand.score,
    matchStrength: cand.matchStrength,
  }));
  const ranked = historyPaging
    ? rankable.flatMap((candidate) =>
        rankCandidateClusters(
          [candidate],
          (id) => personInteraction.get(id) ?? 0,
          (id) => personIsPerson.get(id) ?? false,
        ).map((rankedCandidate) => ({
          ...rankedCandidate,
          // A settled pair is an independent audit entry. Keeping it singleton
          // avoids rebuilding the unbounded historical component graph.
          clusterId: candidate.id,
        })),
      )
    : rankCandidateClusters(
        rankable,
        (id) => personInteraction.get(id) ?? 0,
        (id) => personIsPerson.get(id) ?? false,
      );

  const byId = new Map(visible.map((c) => [c.id, c]));
  const rankedClusters: (typeof ranked)[] = [];
  for (const row of ranked) {
    const last = rankedClusters.at(-1);
    if (last?.[0]?.clusterId === row.clusterId) last.push(row);
    else rankedClusters.push([row]);
  }
  const searchedClusters =
    q && !historyPaging
      ? rankedClusters.filter((cluster) =>
          cluster.some((rankedRow) => {
            const cand = byId.get(rankedRow.id)!;
            const resolved = resolvedById.get(rankedRow.id)!;
            const haystack = [
              cand.sideA.alias,
              cand.sideB.alias,
              ...resolved.a.flatMap((person) => [
                person.canonicalName,
                ...(person.aliases?.map((alias) => alias.alias) ?? []),
              ]),
              ...resolved.b.flatMap((person) => [
                person.canonicalName,
                ...(person.aliases?.map((alias) => alias.alias) ?? []),
              ]),
            ]
              .join("\n")
              .toLowerCase();
            return haystack.includes(q);
          }),
        )
      : rankedClusters;
  const clusterPaging = opts.clusterLimit !== undefined;
  const clusterLimit = Math.max(1, opts.clusterLimit ?? searchedClusters.length);
  const rankAfter = opts.clusterAfter?.kind === "rank" ? opts.clusterAfter : undefined;
  const pageableClusters =
    !historyPaging && rankAfter
      ? searchedClusters.filter((cluster) => {
          const head = cluster[0]!;
          return (
            head.rankScore < rankAfter.rankScore ||
            (head.rankScore === rankAfter.rankScore && head.clusterId > rankAfter.clusterId)
          );
        })
      : searchedClusters;
  const selectedRanked = clusterPaging
    ? pageableClusters.slice(0, clusterLimit).flat()
    : ranked.slice(0, opts.limit);
  const hasMoreClusters = historyProbe
    ? historyProbe.length > clusterLimit
    : clusterPaging && clusterLimit < pageableClusters.length;
  const lastSelectedCluster = clusterPaging
    ? pageableClusters[Math.min(clusterLimit, pageableClusters.length) - 1]
    : undefined;
  const enriched = selectedRanked.map((r) => {
    const cand = byId.get(r.id)!;
    const { a, b } = resolvedById.get(r.id)!;
    return {
      ...cand,
      resolvedSideA: a,
      resolvedSideB: b,
      rankScore: r.rankScore,
      clusterId: r.clusterId,
      // The Brain has said all it can about this pair; the decision is yours.
      needsOperator: needsOperatorAdjudication(cand),
      rankBreakdown: {
        baseScore: cand.score,
        maxInteraction: r.clusterInteraction,
        importanceBoost: r.importanceBoost,
        tokenBonus: cand.matchStrength ?? 1,
      },
    };
  });
  return {
    candidates: enriched,
    hasMoreClusters,
    nextClusterCursor: (() => {
      if (!hasMoreClusters || !lastSelectedCluster) return null;
      const head = lastSelectedCluster[0]!;
      if (historyPaging) {
        const candidate = byId.get(head.id)!;
        return {
          kind: "history" as const,
          sortAt: candidate.decidedAt ?? candidate.detectedAt,
          id: candidate.id,
        };
      }
      return {
        kind: "rank" as const,
        rankScore: head.rankScore,
        clusterId: head.clusterId,
      };
    })(),
    counts: {
      pending: countMergeCandidates(db, "pending"),
      accepted: countMergeCandidates(db, "accepted"),
      denied: countMergeCandidates(db, "denied"),
      needsOperator: countNeedsOperator(db, opts.status, candidates),
    },
  };
}

/** Complete cluster sort tuple carried by the merge-candidate page cursor. */
export type MergeCandidateClusterCursor =
  | { kind: "rank"; rankScore: number; clusterId: string }
  | { kind: "history"; sortAt: string; id: string };

/**
 * Candidates the operator has been asked to settle: the pending rows the Brain
 * adjudicated and could not resolve.
 *
 * Always the FULL pending set, never the veto-filtered one, so the number means
 * the same thing on every tab — it must not drop to zero because you happened
 * to be looking at the accepted one. It needs no veto filtering to stay
 * honest: `needsOperatorAdjudication` implies pending-and-adjudicated, which is
 * exactly what `surfacesDespiteVeto` lists regardless of the vetoes.
 *
 * `pendingCandidates` is the caller's already-loaded pending set, passed in
 * when it is rendering pending. Counting from the same read is what keeps the
 * count and the list consistent WITHIN one response: adjudications commit
 * concurrently, and a second `SELECT` would see a different snapshot and could
 * report a row the accompanying list does not contain. The other two statuses
 * hold no pending rows, so there the set has to be read.
 *
 * Rows past `limit` are counted but not rendered. Cursor-aware clients walk
 * complete clusters page by page; the legacy row-limit path can therefore
 * report a count larger than the compatibility window it renders.
 */
function countNeedsOperator(
  db: Db,
  renderedStatus: MergeCandidateStatus,
  pendingCandidates: readonly MergeCandidateRow[],
): number {
  const pending =
    renderedStatus === "pending" ? pendingCandidates : listAllMergeCandidates(db, "pending");
  return pending.filter(needsOperatorAdjudication).length;
}

/**
 * One candidate's visibility verdict — why the merge queue does or does not
 * show it.
 *
 * Deliberately carries NO alias strings or person names: the question this
 * answers is about the filter, not about who the pair is, and a diagnostic
 * that is safe to paste into a bug report is worth more than one that has to
 * be redacted first. Alias TYPES and opaque person ids are enough to correlate
 * a row back to the queue.
 */
export interface MergeCandidateVisibility {
  id: string;
  status: MergeCandidateStatus;
  sideAAliasType: string;
  sideBAliasType: string;
  personIds: string[];
  /** The first veto that hides this row, or `null` if nothing vetoes it. */
  veto: MergeCandidateVeto | null;
  /** Listed despite `veto` because the Brain adjudicated it and left it pending. */
  surfacedByAdjudication: boolean;
  visible: boolean;
  needsOperator: boolean;
  adjudicatedAt: string | null;
  adjudicationCount: number;
}

/**
 * Explain the merge queue: for every candidate of a status, the veto that
 * hides it (if any) and whether it is listed anyway.
 *
 * This exists because the view filter is otherwise a black box — a candidate
 * simply fails to appear, and recovering which of nine vetoes did it means
 * re-deriving hub membership, the identity-bridge graph and the corpus
 * suppression context by hand against an encrypted store. Shares the veto
 * evaluator with the render path, so it reports what the queue actually did
 * rather than a copy that can drift.
 */
export function explainMergeCandidateVisibility(
  db: Db,
  opts: { status: MergeCandidateStatus },
): MergeCandidateVisibility[] {
  const candidates = listAllMergeCandidates(db, opts.status);
  const { resolvedById, personIsPerson } = resolveCandidateSides(db, candidates);
  const veto = buildVetoEvaluator(db, { resolvedById, personIsPerson, candidates });
  return candidates.map((cand) => {
    const reason = veto(cand);
    const surfaced = surfacesDespiteVeto(cand);
    return {
      id: cand.id,
      status: cand.status,
      sideAAliasType: cand.sideA.aliasType,
      sideBAliasType: cand.sideB.aliasType,
      personIds: resolvedById.get(cand.id)?.personIds ?? [],
      veto: reason,
      surfacedByAdjudication: surfaced && reason !== null,
      visible: surfaced || reason === null,
      needsOperator: needsOperatorAdjudication(cand),
      adjudicatedAt: cand.adjudicatedAt,
      adjudicationCount: cand.adjudicationCount,
    };
  });
}

/** The shape GET /people/merge-candidates returns — inferred from the pure fn. */
export type EnrichedMergeCandidatesResult = ReturnType<typeof computeEnrichedMergeCandidates>;

export function getMergeCandidateById(db: Db, id: string): MergeCandidateRow | null {
  const row = db
    .prepare<[string], MergeCandidateDbRow>(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM merge_candidates
       WHERE id = ?`,
    )
    .get(id);
  return row ? rowToCandidate(row) : null;
}

export function countMergeCandidates(db: Db, status?: MergeCandidateStatus): number {
  if (status) {
    const r = db
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) AS c FROM merge_candidates WHERE status = ?")
      .get(status);
    return r?.c ?? 0;
  }
  const r = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM merge_candidates").get();
  return r?.c ?? 0;
}

/**
 * Accept a pending candidate: create a `kind='user'` merge_rule for
 * its sides + winnerSide, and flip the candidate row to `accepted`
 * with a back-reference to the rule. Idempotent: re-accepting an
 * already-accepted candidate returns its existing rule.
 */
export interface AcceptMergeCandidateInput {
  candidateId: string;
  winnerSide: MergeWinnerSide;
  reason?: string | null;
  createdBy?: string | null;
  /** Rule provenance. Defaults to `"user"`; auto-approval passes `"system"`. */
  kind?: MergeRuleKind;
}

export interface AcceptMergeCandidateResult {
  candidate: MergeCandidateRow;
  /** Null when both aliases already resolve to the same person — see
   *  `alreadyMerged`. Otherwise the rule that bridges the two sides. */
  rule: MergeRule | null;
  ruleCreated: boolean;
  /** True when accept was a no-op because both aliases already lived
   *  on a single person (e.g. drift since the candidate was detected).
   *  Frontend should surface "already merged" rather than treating
   *  this as a normal merge. */
  alreadyMerged: boolean;
}

/**
 * Resolve an alias side to the set of person ids currently carrying
 * that alias. Mirrors the lookup used by `computeMergeEquivalences`
 * so accept-time and eval-time agree on what "this alias resolves to"
 * means. Name aliases are case-insensitive.
 */
function resolveAliasSidePersonIds(
  db: Db,
  side: { aliasType: MergeRuleAliasType; alias: string },
): string[] {
  if (side.aliasType === "name") {
    return db
      .prepare<[string], { person_id: string }>(
        "SELECT person_id FROM person_aliases WHERE alias_type = 'name' AND LOWER(alias) = ?",
      )
      .all(side.alias.toLowerCase())
      .map((r) => r.person_id);
  }
  return db
    .prepare<[string, string], { person_id: string }>(
      "SELECT person_id FROM person_aliases WHERE alias_type = ? AND alias = ?",
    )
    .all(side.aliasType, side.alias)
    .map((r) => r.person_id);
}

/**
 * True when every person row each alias side resolves to belongs to
 * one and the same identity — a single canonical per side, equal
 * across sides. Dereferences `people.merged_into`, so both collapse
 * paths count: physical dedup (rows merged, aliases moved) and logical
 * merges (rule-driven pointers, where aliases stay on the loser rows
 * forever and raw row comparison would miss the collapse).
 *
 * `merged_into` is flat after every complete eval pass; transient
 * chains (a direct admin merge, a yielded apply mid-pass) only make
 * the single COALESCE hop conservative — the canonical sets diverge
 * and the check re-runs later. It can never produce a false positive.
 */
function sidesCollapsedToOneIdentity(
  db: Db,
  sideA: { aliasType: MergeRuleAliasType; alias: string },
  sideB: { aliasType: MergeRuleAliasType; alias: string },
): boolean {
  const a = resolveAliasSidePersonIds(db, sideA);
  const b = resolveAliasSidePersonIds(db, sideB);
  if (a.length === 0 || b.length === 0) return false;
  const canonicalStmt = db.prepare<[string], { cid: string }>(
    "SELECT COALESCE(merged_into, id) AS cid FROM people WHERE id = ?",
  );
  const canonicalsOf = (ids: string[]): Set<string> => {
    const out = new Set<string>();
    for (const id of ids) out.add(canonicalStmt.get(id)?.cid ?? id);
    return out;
  };
  const ca = canonicalsOf(a);
  const cb = canonicalsOf(b);
  return ca.size === 1 && cb.size === 1 && ca.values().next().value === cb.values().next().value;
}

/**
 * Sweep `pending` candidates whose two sides now belong to one and the
 * same identity (see `sidesCollapsedToOneIdentity`). Marks them
 * `accepted` with `rule_id=NULL` — same semantics as the no-op accept
 * path in `acceptMergeCandidate`.
 *
 * Called from the merge-rules eval task: as a pre-step on every tick,
 * and again right after an apply that moved equivalences (the pre-step
 * runs before the apply, so a merge landing in that tick would
 * otherwise leave its satisfied candidates pending until the next
 * tick — the portal polls for them to clear).
 *
 * Returns the count actually flipped to `accepted`.
 */
export function sweepCollapsedMergeCandidates(db: Db): { swept: number } {
  const pending = db
    .prepare<
      [],
      {
        id: string;
        side_a_alias_type: string;
        side_a_alias: string;
        side_b_alias_type: string;
        side_b_alias: string;
      }
    >(
      `SELECT id, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias
       FROM merge_candidates WHERE status = 'pending'`,
    )
    .all();
  if (pending.length === 0) return { swept: 0 };

  const collapsedIds: string[] = [];
  for (const c of pending) {
    const collapsed = sidesCollapsedToOneIdentity(
      db,
      { aliasType: c.side_a_alias_type as MergeRuleAliasType, alias: c.side_a_alias },
      { aliasType: c.side_b_alias_type as MergeRuleAliasType, alias: c.side_b_alias },
    );
    if (collapsed) collapsedIds.push(c.id);
  }
  if (collapsedIds.length === 0) return { swept: 0 };

  const now = new Date().toISOString();
  const placeholders = collapsedIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE merge_candidates
         SET status='accepted', decided_at=?, rule_id=NULL
       WHERE id IN (${placeholders}) AND status='pending'`,
    )
    .run(now, ...collapsedIds);
  if (result.changes > 0) {
    log.info(`Swept ${result.changes} collapsed candidate(s) (both sides resolved to same person)`);
  }
  return { swept: result.changes };
}

/**
 * Delete `pending` candidates that are no longer valid suggestions:
 *   - the role-mailbox suppression rule now rejects them, or
 *   - a side no longer resolves to any person (the bucket was deleted — e.g.
 *     a shared-address demotion removed a firehose mailbox — leaving a
 *     "dormant" candidate that can never be actioned).
 *
 * The detector stops *emitting* suppressed pairs, but existing pending rows
 * (proposed before the labels existed, before this feature, or before the
 * referenced person was deleted) linger — `upsertMergeCandidates` only
 * inserts / refreshes, it never deletes. This sweep converges the table; it
 * is idempotent and only touches `pending` rows (a `denied` veto is durable).
 *
 * Suppression runs off the candidate's stored `matched_tokens`, so it stays
 * in lockstep with whatever the scorer credited at detection time.
 */
export function pruneSuppressedMergeCandidates(db: Db): { pruned: number } {
  const suppression = loadSuppressionContext(db);
  const pending = db
    .prepare<[], MergeCandidateDbRow>(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM merge_candidates WHERE status = 'pending'`,
    )
    .all();
  if (pending.length === 0) return { pruned: 0 };

  const toDelete: string[] = [];
  for (const r of pending) {
    const cand = rowToCandidate(r);
    const vanishedSide =
      resolveAliasSidePersonIds(db, cand.sideA).length === 0 ||
      resolveAliasSidePersonIds(db, cand.sideB).length === 0;
    if (
      vanishedSide ||
      shouldSuppressCandidate(cand.sideA, cand.sideB, cand.matchedTokens, suppression)
    ) {
      toDelete.push(cand.id);
    }
  }
  if (toDelete.length === 0) return { pruned: 0 };

  const tx = db.transaction((ids: string[]) => {
    const stmt = db.prepare("DELETE FROM merge_candidates WHERE id = ? AND status = 'pending'");
    for (const id of ids) stmt.run(id);
  });
  tx(toDelete);
  log.info(`Pruned ${toDelete.length} suppressed role-mailbox candidate(s)`);
  return { pruned: toDelete.length };
}

export function acceptMergeCandidate(
  db: Db,
  input: AcceptMergeCandidateInput,
): AcceptMergeCandidateResult {
  const cand = getMergeCandidateById(db, input.candidateId);
  if (!cand) throw new Error(`Merge candidate not found: ${input.candidateId}`);
  if (cand.status === "denied") {
    throw new Error("Cannot accept a denied candidate. Re-detect to revive it.");
  }

  // If already accepted and the rule still exists, surface it as a no-op.
  if (cand.status === "accepted" && cand.ruleId) {
    const rule = getMergeRuleById(db, cand.ruleId);
    if (rule) {
      return { candidate: cand, rule, ruleCreated: false, alreadyMerged: false };
    }
    // Stale rule_id (rule deactivated externally) — fall through and
    // create a fresh one. The candidate row's rule_id will be updated.
  }

  // If both sides already belong to one and the same identity —
  // physical dedup drift between detection and acceptance, or an
  // earlier logical (rule-driven) merge — skip rule creation. The
  // merge has already happened, and a redundant rule would never be
  // auto-deleted (collapsed-rule detection compares raw person rows,
  // which a logical merge leaves distinct) and would silently keep
  // the pair merged after the original rules are undone.
  if (sidesCollapsedToOneIdentity(db, cand.sideA, cand.sideB)) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE merge_candidates SET status='accepted', decided_at=?, rule_id=NULL WHERE id=?`,
    ).run(now, cand.id);
    const updated = getMergeCandidateById(db, cand.id);
    if (!updated) throw new Error("Candidate vanished after accept");
    log.info(
      `Candidate ${cand.id}: accepted as no-op — both sides already resolve to the same identity`,
    );
    return { candidate: updated, rule: null, ruleCreated: false, alreadyMerged: true };
  }

  let ruleResult: CreateMergeRuleResult;
  try {
    ruleResult = createMergeRule(db, {
      sideA: cand.sideA,
      sideB: cand.sideB,
      winnerSide: input.winnerSide,
      kind: input.kind ?? "user",
      reason: input.reason ?? `Accepted from candidate ${cand.id}`,
      createdBy: input.createdBy ?? null,
    });
  } catch (err) {
    throw new Error(
      `Failed to create merge rule from candidate: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE merge_candidates SET status='accepted', decided_at=?, rule_id=? WHERE id=?`,
  ).run(now, ruleResult.rule.id, cand.id);

  const updated = getMergeCandidateById(db, cand.id);
  if (!updated) throw new Error("Candidate vanished after accept");
  log.info(
    `Candidate accepted: ${cand.id} → rule ${ruleResult.rule.id} (winner=${input.winnerSide})`,
  );
  return {
    candidate: updated,
    rule: ruleResult.rule,
    ruleCreated: ruleResult.created,
    alreadyMerged: false,
  };
}

/**
 * Auto-approve the structurally high-confidence pending candidates as reversible
 * `kind:"system"` merge rules, so the operator only reviews the genuinely-uncertain
 * ones. A candidate is auto-approved when {@link isHighConfidenceMerge} holds — a
 * distinctive shared email handle across domains, or a distinctive full-name match
 * — AND neither side touches `is_self` (a wrong self-merge silently corrupts
 * first-person answers, so self stays manual). The system rule is visible and
 * one-click-revertable in the merge-rules UI, exactly like a user-accepted one.
 *
 * Idempotent: re-running skips candidates already accepted, and `createMergeRule`
 * de-dupes the active-pair index, so a re-proposed pair never double-rules.
 */
export function autoApproveHighConfidenceCandidates(db: Db): { approved: number } {
  const selfId = getSelfPersonId(db);
  const pending = listAllMergeCandidates(db, "pending");
  const cache = new Map<string, ResolvedSidePerson[]>();
  let approved = 0;
  for (const cand of pending) {
    const a = resolveAliasSide(db, cand.sideA, { withDetails: true, cache });
    const b = resolveAliasSide(db, cand.sideB, { withDetails: true, cache });
    if (a.length === 0 || b.length === 0) continue; // unresolvable side
    const ids = new Set([...a, ...b].map((p) => p.id));
    if (ids.size < 2) continue; // already collapsed to one identity
    if (selfId && ids.has(selfId)) continue; // self guardrail — stays manual

    const aliasesA = a.flatMap((p) => p.aliases ?? []);
    const aliasesB = b.flatMap((p) => p.aliases ?? []);
    // Blob guard: never auto-grow an already-corrupt person (a shared account
    // that accreted several people's names). It would absorb a clean record on
    // whichever of its names agrees. Route to manual review instead.
    if (hasInternalNameConflict(aliasesA) || hasInternalNameConflict(aliasesB)) continue;

    const highConfidence = isHighConfidenceMerge({
      aliasesA,
      aliasesB,
      score: cand.score,
      matchStrength: cand.matchStrength ?? 0,
      isPersonA: a.some((p) => isPersonEntity(p.aliases ?? [])),
      isPersonB: b.some((p) => isPersonEntity(p.aliases ?? [])),
    });
    if (!highConfidence) continue;

    // Deterministic winner vote (lex-smaller canonical id). The merge-rules eval
    // re-derives the real canonical from all rules anyway; this is just the seed.
    const winnerSide: MergeWinnerSide = (a[0]?.id ?? "") <= (b[0]?.id ?? "") ? "a" : "b";
    try {
      const res = acceptMergeCandidate(db, {
        candidateId: cand.id,
        winnerSide,
        kind: "system",
        reason: "Auto-approved: high-confidence merge",
        createdBy: null,
      });
      if (res.ruleCreated || res.alreadyMerged) approved += 1;
    } catch (err) {
      log.warn(
        `autoApprove: candidate ${cand.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (approved > 0) {
    log.info(`autoApprove: ${approved} high-confidence candidate(s) approved as system merges`);
  }
  return { approved };
}

/**
 * Deny a pending candidate. Status flips to `denied`; the row stays
 * in the table as a permanent veto (the detector pre-loads denied
 * pairs and skips them).
 *
 * Already-denied: idempotent no-op. Already-accepted: error — the
 * caller should deactivate the rule via the merge_rules API instead.
 */
export function denyMergeCandidate(db: Db, candidateId: string): MergeCandidateRow {
  const cand = getMergeCandidateById(db, candidateId);
  if (!cand) throw new Error(`Merge candidate not found: ${candidateId}`);
  if (cand.status === "accepted") {
    throw new Error("Cannot deny an accepted candidate — deactivate its merge rule instead.");
  }
  if (cand.status === "denied") {
    return cand;
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE merge_candidates SET status='denied', decided_at=? WHERE id=?`).run(
    now,
    cand.id,
  );
  const updated = getMergeCandidateById(db, cand.id);
  if (!updated) throw new Error("Candidate vanished after deny");
  log.info(`Candidate denied: ${cand.id}`);
  return updated;
}

// ─── Merge adjudication (background agent verdicts) ──────────────────

export interface ApplyMergeAdjudicationInput {
  candidateId: string;
  verdict: MergeAdjudicationVerdict;
  /** The model's user-visible rationale — becomes the rule reason on accept. */
  reason: string;
  /** The steward run the verdict came from (stamped as rule createdBy). */
  runId: string;
  /**
   * The person ids both sides resolved to when the run's evidence was built.
   * A `merge` verdict is applied only if apply-time resolution still matches —
   * a person who gained one of the aliases mid-run would otherwise be welded
   * sight-unseen. Optional: absent skips the drift check.
   */
  expectedPersonIds?: readonly string[];
  /**
   * Fingerprint of the evidence the run was shown. Stamped in preference to
   * the row's live evidence so that a detector pass landing mid-run leaves the
   * new evidence unjudged-and-due, rather than marked as covered by a verdict
   * that never saw it. Optional: absent falls back to the row at write time.
   */
  judgedEvidenceFingerprint?: string;
}

export interface ApplyMergeAdjudicationResult {
  outcome:
    | "merged"
    | "already_merged"
    | "denied"
    | "recorded"
    | "guard_blocked"
    | "not_pending"
    | "not_found";
  ruleId: string | null;
}

/**
 * Apply a background-agent adjudication verdict to a pending candidate.
 * Runs on the writer. The verdict + reason are stamped onto the candidate row
 * whatever the outcome, so the operator surfaces can show what the model
 * concluded (including for `unsure` candidates left in the review queue).
 *
 *   - `merge`    → accept as a reversible `kind:"system"` rule whose reason is
 *                  the model's rationale — but ONLY after re-checking the
 *                  deterministic guards (resolvable sides, ≥2 identities, not
 *                  self, no blob side): the model proposes, the writer decides.
 *   - `distinct` → deny (a durable veto the detector never re-proposes over).
 *   - `unsure`   → stamp only; the candidate stays pending for manual review.
 *
 * Not idempotent by design across states: a candidate that was decided (or
 * deleted) between enqueue and apply reports `not_pending`/`not_found` and is
 * left untouched.
 */
export function applyMergeAdjudication(
  db: Db,
  input: ApplyMergeAdjudicationInput,
): ApplyMergeAdjudicationResult {
  const cand = getMergeCandidateById(db, input.candidateId);
  if (!cand) return { outcome: "not_found", ruleId: null };
  if (cand.status !== "pending") return { outcome: "not_pending", ruleId: null };

  const now = new Date().toISOString();
  // Stamp WHAT was judged, not just when. The enqueuer compares this against
  // the row's live evidence, so a verdict covers the evidence it actually saw
  // and nothing re-opens until that evidence moves.
  db.prepare(
    `UPDATE merge_candidates
        SET adjudicated_at = ?, adjudication_verdict = ?, adjudication_reason = ?,
            adjudication_evidence_fingerprint = ?,
            adjudication_count = COALESCE(adjudication_count, 0) + 1
      WHERE id = ?`,
  ).run(
    now,
    input.verdict,
    input.reason,
    input.judgedEvidenceFingerprint ?? currentEvidenceFingerprint(cand),
    cand.id,
  );

  if (input.verdict === "unsure") {
    log.info(`Adjudication: candidate ${cand.id} left for review (unsure)`);
    return { outcome: "recorded", ruleId: null };
  }

  if (input.verdict === "distinct") {
    denyMergeCandidate(db, cand.id);
    log.info(`Adjudication: candidate ${cand.id} denied (distinct)`);
    return { outcome: "denied", ruleId: null };
  }

  // verdict === "merge" — re-check the deterministic guards on live state.
  const cache = new Map<string, ResolvedSidePerson[]>();
  const a = resolveAliasSide(db, cand.sideA, { withDetails: true, cache });
  const b = resolveAliasSide(db, cand.sideB, { withDetails: true, cache });
  if (a.length === 0 || b.length === 0) return { outcome: "guard_blocked", ruleId: null };
  const ids = new Set([...a, ...b].map((p) => p.id));
  if (ids.size < 2) return { outcome: "already_merged", ruleId: null };
  if (input.expectedPersonIds !== undefined) {
    const expected = new Set(input.expectedPersonIds);
    const drifted = expected.size !== ids.size || [...ids].some((id) => !expected.has(id));
    if (drifted) {
      log.warn(`Adjudication: candidate ${cand.id} merge verdict blocked (resolution drifted)`);
      return { outcome: "guard_blocked", ruleId: null };
    }
  }
  const selfId = getSelfPersonId(db);
  if (selfId && ids.has(selfId)) {
    log.warn(`Adjudication: candidate ${cand.id} merge verdict blocked (touches self)`);
    return { outcome: "guard_blocked", ruleId: null };
  }
  const aliasesA = a.flatMap((p) => p.aliases ?? []);
  const aliasesB = b.flatMap((p) => p.aliases ?? []);
  if (hasInternalNameConflict(aliasesA) || hasInternalNameConflict(aliasesB)) {
    log.warn(`Adjudication: candidate ${cand.id} merge verdict blocked (blob guard)`);
    return { outcome: "guard_blocked", ruleId: null };
  }

  const winnerSide: MergeWinnerSide = (a[0]?.id ?? "") <= (b[0]?.id ?? "") ? "a" : "b";
  const res = acceptMergeCandidate(db, {
    candidateId: cand.id,
    winnerSide,
    kind: "system",
    reason: input.reason,
    createdBy: input.runId,
  });
  log.info(`Adjudication: candidate ${cand.id} merged (rule ${res.rule?.id ?? "none"})`);
  return {
    outcome: res.alreadyMerged ? "already_merged" : "merged",
    ruleId: res.rule?.id ?? null,
  };
}

export interface MergeClusterResult {
  /** Number of `kind='user'` rules created to unify the people. */
  rulesCreated: number;
  /** The anchor the others were bridged to. Chosen with the eval's canonical
   *  ordering, so it is also the person who survives the merge. */
  anchorId: string | null;
  /** Correlation id stamped on every rule this call created. Null when no rule
   *  was created (e.g. fewer than two mergeable people). Pass it to
   *  `deleteMergeRuleGroup` to undo the whole merge in one action. */
  groupId: string | null;
}

/** Pick a person's strongest alias (email > phone > lid > name) for use as a
 *  merge-rule side. Null when the person carries no alias. */
function representativeAlias(
  db: Db,
  personId: string,
): { aliasType: MergeRuleAliasType; alias: string } | null {
  const rows = db
    .prepare<
      [string],
      { alias_type: string; alias: string }
    >("SELECT alias_type, alias FROM person_aliases WHERE person_id = ?")
    .all(personId);
  if (rows.length === 0) return null;
  const sorted = rows
    .map((r) => ({ aliasType: r.alias_type as MergeRuleAliasType, alias: r.alias }))
    .sort((a, b) => {
      const ra = STRENGTH_RANK[a.aliasType];
      const rb = STRENGTH_RANK[b.aliasType];
      if (ra !== rb) return ra - rb;
      return a.alias.localeCompare(b.alias);
    });
  return sorted[0];
}

/**
 * Person attributes that decide which cluster member becomes the star anchor.
 * Mirrors the fields the rule evaluator reads when it picks a component's
 * surviving canonical (`domain/merge/rule-evaluator.ts`).
 */
interface AnchorMeta {
  id: string;
  isSelf: boolean;
  interaction: number;
  firstSeen: string;
}

/**
 * Order cluster members the way the eval picks the surviving canonical, so the
 * star's center is the person who will actually survive the merge:
 *
 *   1. `is_self` wins (only one self exists; it always survives).
 *   2. then highest recent interaction (the contact the operator engages with).
 *   3. then earliest `first_seen` (the longest-standing record).
 *   4. then lexicographic id (a stable final tiebreak).
 *
 * This matches the eval's ordering on its stable keys (`is_self` → … →
 * `first_seen` → id). The eval's other key — winner-side votes — is one this
 * call controls: every rule points its `winner_side` at the anchor, so the
 * anchor collects all the votes and the eval's vote tiebreak reinforces the
 * same choice rather than fighting it. The criteria here are all stable
 * (interaction/first_seen/self don't flip as a later sync adds aliases), so the
 * same cluster merged twice picks the same anchor and emits the identical star
 * — no redundant edges accrue.
 */
function compareAnchorPriority(a: AnchorMeta, b: AnchorMeta): number {
  if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
  if (a.interaction !== b.interaction) return b.interaction - a.interaction;
  const c = a.firstSeen.localeCompare(b.firstSeen);
  if (c !== 0) return c;
  return a.id < b.id ? -1 : 1;
}

/**
 * Unify a set of people into one identity by creating `kind='user'` merge
 * rules — one bridging each member to a shared anchor (a star, so N people →
 * N-1 rules). Used by the portal's grouped cluster card to merge a whole
 * cluster of duplicates in one action.
 *
 * The anchor is the member the eval would pick as the surviving canonical
 * (see {@link compareAnchorPriority}), so the rule's join point and the survivor
 * coincide. Every rule created in one call shares a fresh `group_id`, so the
 * whole merge is one auditable, undoable unit (see `deleteMergeRuleGroup`).
 *
 * Members with no alias, or whose strongest alias collides with the anchor's,
 * are skipped. Reversible like any user rule; idempotent via
 * `createMergeRule`'s canonical-dedup.
 */
export function mergeCluster(
  db: Db,
  personIds: readonly string[],
  opts: { reason?: string | null; createdBy?: string | null } = {},
): MergeClusterResult {
  const unique = [...new Set(personIds)];
  if (unique.length < 2) return { rulesCreated: 0, anchorId: unique[0] ?? null, groupId: null };

  const metaStmt = db.prepare<
    [string],
    { is_self: number; interaction_score_recent: number | null; first_seen: string | null }
  >("SELECT is_self, interaction_score_recent, first_seen FROM people WHERE id = ?");
  const metas: AnchorMeta[] = unique.map((id) => {
    const row = metaStmt.get(id);
    return {
      id,
      isSelf: (row?.is_self ?? 0) === 1,
      interaction: row?.interaction_score_recent ?? 0,
      firstSeen: row?.first_seen ?? "",
    };
  });
  const anchor = [...metas].sort(compareAnchorPriority)[0].id;
  const anchorRep = representativeAlias(db, anchor);
  if (!anchorRep) return { rulesCreated: 0, anchorId: anchor, groupId: null };

  const groupId = randomUUID();
  let created = 0;
  const tx = db.transaction(() => {
    for (const pid of unique) {
      if (pid === anchor) continue;
      const rep = representativeAlias(db, pid);
      if (!rep) continue;
      if (rep.aliasType === anchorRep.aliasType && rep.alias === anchorRep.alias) continue;
      try {
        createMergeRule(db, {
          sideA: anchorRep,
          sideB: rep,
          winnerSide: "a",
          kind: "user",
          reason: opts.reason ?? "Merged from cluster review",
          createdBy: opts.createdBy ?? null,
          groupId,
        });
        created += 1;
      } catch {
        // Pair can't form a valid user rule (e.g. identical alias) — skip it.
      }
    }
  });
  tx();
  log.info(
    `Cluster merge ${groupId}: ${created} rule(s) bridging ${unique.length} people to ${anchor}`,
  );
  return { rulesCreated: created, anchorId: anchor, groupId: created > 0 ? groupId : null };
}
