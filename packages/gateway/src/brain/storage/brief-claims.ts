// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brief-claims sidecar — the per-brief store of atomic asserted claims.
 *
 * A brief is the user-facing surface, so every factual, document-derived
 * assertion it makes is persisted here as its own row: the claim text, the
 * evidence document + verbatim quote that grounds it, the declared claim
 * basis with its clamped confidence, and the write-time entailment stamp.
 * The teeth live at the tool boundary (`loop-agent/tools.ts` — quote must
 * appear in the cited document, then the entailment gate judges quote ⊨
 * claim); this store only persists what already passed, composed into the
 * same writer transaction as the brief create/update itself.
 *
 * Lifecycle: a claim set is written atomically with its brief; a
 * `brief_update` carrying a new set soft-invalidates the old rows
 * (`invalidated_at`, kept for audit) and inserts the new ones in one
 * transaction. Deleting a brief hard-deletes its claims via the
 * `ON DELETE CASCADE` foreign key (mirroring `brief_citations`) — claims
 * embed source quotes, so they must not outlive their brief. The evidence
 * document's lifecycle reaches in from the other side too: a privacy-deleted
 * evidence document HARD-purges every claim citing it — live and invalidated
 * alike, since `evidence_quote` IS the removed content verbatim
 * (`cascadeBriefClaimPrivacyDelete`, wired at the DocumentService
 * privacy-delete seam beside the annotation cascade) — and an evidence
 * document whose content changed soft-invalidates the claims whose quote no
 * longer appears in it (`invalidateBriefClaimsForDoc`, wired on
 * `document.upserted` beside the annotation invalidator).
 *
 * House style matches the sibling stores: plain functions over a
 * better-sqlite3 handle, explicit `now`, single-writer in production.
 */

import { containsNormalized } from "../quote-match.js";
import type { AnnotationClaimBasis } from "./annotations.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * DDL — idempotent, so it is called both from `runSchemaSetup` (fresh
 * installs) and from the numbered migration that introduced it (upgrades),
 * exactly like `createAnnotationStorageTables`.
 */
export function createBriefClaimsTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_claims (
      id TEXT PRIMARY KEY,
      brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      claim_text TEXT NOT NULL,
      evidence_doc_id TEXT NOT NULL,
      evidence_quote TEXT NOT NULL,
      claim_basis TEXT NOT NULL,
      confidence REAL NOT NULL,
      verification_state TEXT,
      created_at INTEGER NOT NULL,
      invalidated_at INTEGER
    )
  `);
  // "Claims of this brief" — the detail read + the replace-set invalidation.
  db.exec("CREATE INDEX IF NOT EXISTS idx_brief_claims_brief ON brief_claims(brief_id)");
  // "Which claims cite this document" — the content-change invalidation and
  // the privacy cascade both key on the grounding atom.
  db.exec("CREATE INDEX IF NOT EXISTS idx_brief_claims_evidence ON brief_claims(evidence_doc_id)");
}

/**
 * Write-time entailment stamp on a brief claim, with the same three-way
 * semantics as the annotation stores: `verified` = the verifier judged the
 * evidence quote to entail the claim at create time (claims are
 * born-verified — the gate just checked them); `unverified` = a CONFIGURED
 * verifier was unavailable at write time, so the write failed open; NULL =
 * no verifier is configured — no gate ran, so there is no stamp (and the
 * portal hides the marker, exactly like an annotation written without a
 * verifier).
 *
 * The stamp is deliberately WRITE-TIME-ONLY. Unlike doc/person annotations —
 * durable priors the re-verification sweep re-judges on a cadence — a brief
 * is a short-lived, user-facing surface: its claim set is replaced wholesale
 * on every `brief_update` and dies with the brief, so a claim stamped
 * `unverified` during a transient verifier outage simply stays `unverified`
 * for that brief's lifetime. There is no re-verification lane for brief
 * claims, and `unverified` is informational ("the gate could not run"), not
 * a defect marker; the quote-in-document check always ran regardless.
 */
export type BriefClaimVerificationState = "unverified" | "verified";

export interface BriefClaimRow {
  id: string;
  briefId: string;
  /** The factual assertion the brief makes. */
  claimText: string;
  /** The source document the claim is grounded in. */
  evidenceDocId: string;
  /** A verbatim quote from `evidenceDocId` establishing the claim. */
  evidenceQuote: string;
  /** How far the claim reasons from its evidence (annotation vocabulary). */
  claimBasis: AnnotationClaimBasis;
  /** Confidence after the per-basis clamp at the tool boundary. */
  confidence: number;
  /** Write-time entailment stamp; null = written with no verifier configured. */
  verificationState: BriefClaimVerificationState | null;
  createdAt: number;
  /** Set when a later claim set replaced this one; null = live. */
  invalidatedAt: number | null;
}

/** One claim of an atomic set, already vetted at the tool boundary. */
export interface BriefClaimInput {
  id: string;
  claimText: string;
  evidenceDocId: string;
  evidenceQuote: string;
  claimBasis: AnnotationClaimBasis;
  confidence: number;
  /** Write-time entailment stamp; null = written with no verifier configured. */
  verificationState: BriefClaimVerificationState | null;
}

interface BriefClaimDbRow {
  id: string;
  brief_id: string;
  claim_text: string;
  evidence_doc_id: string;
  evidence_quote: string;
  claim_basis: string;
  confidence: number;
  verification_state: string | null;
  created_at: number;
  invalidated_at: number | null;
}

function rowToClaim(r: BriefClaimDbRow): BriefClaimRow {
  return {
    id: r.id,
    briefId: r.brief_id,
    claimText: r.claim_text,
    evidenceDocId: r.evidence_doc_id,
    evidenceQuote: r.evidence_quote,
    claimBasis: r.claim_basis as AnnotationClaimBasis,
    confidence: r.confidence,
    verificationState: (r.verification_state as BriefClaimVerificationState | null) ?? null,
    createdAt: r.created_at,
    invalidatedAt: r.invalidated_at,
  };
}

/**
 * Insert one claim set for `briefId`, as a single transaction (a savepoint
 * when the caller — the brief create/update writer op — already holds one).
 */
export function insertBriefClaimSet(
  db: Db,
  briefId: string,
  claims: readonly BriefClaimInput[],
  now: number,
): void {
  const insert = db.prepare<unknown[]>(
    `INSERT INTO brief_claims (
       id, brief_id, claim_text, evidence_doc_id, evidence_quote,
       claim_basis, confidence, verification_state, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction(() => {
    for (const c of claims) {
      insert.run(
        c.id,
        briefId,
        c.claimText,
        c.evidenceDocId,
        c.evidenceQuote,
        c.claimBasis,
        c.confidence,
        c.verificationState,
        now,
      );
    }
  });
  txn();
}

/**
 * Atomically replace the brief's LIVE claim set: soft-invalidate the
 * standing rows (kept for audit) and insert the new set, in one
 * transaction — a crash can never leave the old and new sets both live.
 * Returns how many standing claims were invalidated.
 */
export function replaceBriefClaimSet(
  db: Db,
  briefId: string,
  claims: readonly BriefClaimInput[],
  now: number,
): { invalidated: number } {
  const txn = db.transaction(() => {
    const invalidated = invalidateBriefClaimsForBrief(db, briefId, now);
    insertBriefClaimSet(db, briefId, claims, now);
    return { invalidated };
  });
  return txn();
}

/** Soft-invalidate every live claim of `briefId`. Returns the count. */
export function invalidateBriefClaimsForBrief(db: Db, briefId: string, now: number): number {
  return db
    .prepare<
      [number, string]
    >("UPDATE brief_claims SET invalidated_at = ? WHERE brief_id = ? AND invalidated_at IS NULL")
    .run(now, briefId).changes;
}

/** Live claims of one brief, in insert order — the detail-payload read. */
export function listLiveBriefClaims(db: Db, briefId: string): BriefClaimRow[] {
  return db
    .prepare<[string], BriefClaimDbRow>(
      `SELECT * FROM brief_claims
        WHERE brief_id = ? AND invalidated_at IS NULL
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(briefId)
    .map(rowToClaim);
}

/** True when a live claim cites `docId` as its evidence — the invalidator's cheap guard. */
export function hasLiveBriefClaimsForDoc(db: Db, docId: string): boolean {
  return (
    db
      .prepare<
        [string],
        { one: number }
      >("SELECT 1 AS one FROM brief_claims WHERE evidence_doc_id = ? AND invalidated_at IS NULL LIMIT 1")
      .get(docId) !== undefined
  );
}

/** Cheap existence check — does the claims store hold any rows at all? */
export function hasAnyBriefClaims(db: Db): boolean {
  return (
    db.prepare<[], { one: number }>("SELECT 1 AS one FROM brief_claims LIMIT 1").get() !== undefined
  );
}

/** Bound-variable-safe id batches for the IN(...) statements below. */
const ID_CHUNK = 400;

/**
 * Content-change invalidation for claims grounded in `docId` — surgical,
 * mirroring the annotation invalidator: the grounding atom is the evidence
 * QUOTE, so a live claim whose quote no longer appears in the document's new
 * content is soft-invalidated (dropped from the brief's served claim set,
 * kept for audit — a user-facing "verified" assertion must not keep resting
 * on text that no longer exists). A claim whose quote survived stays live
 * and untouched — brief claims are stamped at write time only (there is no
 * re-verification lane to hand a re-flag to; see the state doc above). If
 * the document row itself is gone by write time, every touched claim is
 * un-regroundable and the whole set soft-invalidates.
 *
 * `now` is the content-change event time; only claims that existed AT that
 * moment (`created_at <= now`) are touched, so a claim a later run writes
 * against the NEW content is never wrongly dropped. Idempotent. Returns the
 * number invalidated.
 */
export function invalidateBriefClaimsForDoc(db: Db, docId: string, now: number): number {
  const txn = db.transaction((): number => {
    const candidates = db
      .prepare<[string, number], { id: string; evidence_quote: string }>(
        `SELECT id, evidence_quote FROM brief_claims
          WHERE evidence_doc_id = ? AND invalidated_at IS NULL AND created_at <= ?`,
      )
      .all(docId, now);
    if (candidates.length === 0) return 0;
    const doc = db
      .prepare<[string], { content: string | null }>("SELECT content FROM documents WHERE id = ?")
      .get(docId);
    const broken =
      doc === undefined
        ? candidates
        : candidates.filter((c) => !containsNormalized(doc.content ?? "", c.evidence_quote));
    for (let i = 0; i < broken.length; i += ID_CHUNK) {
      const batch = broken.slice(i, i + ID_CHUNK).map((c) => c.id);
      const placeholders = batch.map(() => "?").join(", ");
      db.prepare<unknown[]>(
        `UPDATE brief_claims SET invalidated_at = ? WHERE id IN (${placeholders})`,
      ).run(now, ...batch);
    }
    return broken.length;
  });
  return txn();
}

/**
 * Privacy / deletion cascade: HARD-delete every claim — live AND
 * invalidated — whose evidence is one of `deletedDocIds`. A soft
 * invalidation would leave `evidence_quote` — the deleted document's content
 * verbatim — on disk and served forever via `brief_fetch` and the brief
 * detail route, so a delete purges outright, mirroring
 * `cascadeAnnotationPrivacyDelete`. Returns the deleted claim ids. Chunks
 * the id lists so a large batch stays under SQLite's bound-variable ceiling.
 */
export function cascadeBriefClaimPrivacyDelete(db: Db, deletedDocIds: readonly string[]): string[] {
  if (deletedDocIds.length === 0) return [];
  const ids: string[] = [];
  for (let i = 0; i < deletedDocIds.length; i += ID_CHUNK) {
    const batch = deletedDocIds.slice(i, i + ID_CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    for (const r of db
      .prepare<
        string[],
        { id: string }
      >(`SELECT id FROM brief_claims WHERE evidence_doc_id IN (${placeholders})`)
      .all(...batch)) {
      ids.push(r.id);
    }
  }
  if (ids.length === 0) return [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const batch = ids.slice(i, i + ID_CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    db.prepare<string[]>(`DELETE FROM brief_claims WHERE id IN (${placeholders})`).run(...batch);
  }
  return ids;
}
