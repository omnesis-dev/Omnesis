// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable doc-annotation store — the thin, evidence-firewalled base of
 * the abstract graph over the physical document corpus. The background loop
 * agent already forms a rich understanding of each document it reads and then
 * discards it at end of run; a `doc_annotation` persists one such observation
 * as a PRIOR that future runs (chiefly the `synthesis` pass) read back and
 * then RE-GROUND against the source before acting on.
 *
 * The evidence firewall — "hints, then reground, never masquerade as truth" —
 * is enforced structurally, split across this store and the `annotate_durable`
 * tool that writes through it:
 *
 *  - every annotation MUST cite at least one immutable source atom (an
 *    `evidence_doc_id` + a verbatim `evidence_quote`); the tool rejects a
 *    claim whose quote is not found in the cited document (the reground
 *    teeth) and one grounded on anything but a real `documents` row (no
 *    annotation-on-annotation compounding);
 *  - `confidence` is capped below certainty at the tool boundary — re-reading
 *    one's own past conclusion can never raise certainty;
 *  - `llm_derived` stays stamped so a guess never launders into apparent hard
 *    fact downstream;
 *  - a cited document's content change SOFT-invalidates what it broke
 *    (`invalidated_at`, dropped from priors, kept for audit); a document
 *    deletion HARD-purges every annotation resting on it (privacy: derived
 *    text may embed the source).
 *
 * ## Multi-evidence + the scalar mirror invariant
 *
 * An annotation's grounding is an ORDERED SET of evidence atoms in
 * `doc_annotation_evidence` (a synthesized claim genuinely rests on several
 * documents); each row carries its own `broken_at` liveness (a content change
 * breaks only the rows whose quote vanished). The parent row's scalar
 * `evidence_doc_id`/`evidence_quote` columns are a MIRROR of evidence[0] —
 * the first LIVE evidence row in position order — maintained exclusively by
 * this facade (create, evidence replace, and the invalidator's
 * promote-on-break), never by callers. Every scalar-only reader keeps
 * working; multi-evidence readers use {@link listDocAnnotationEvidence}.
 *
 * ## The servable rule: FIRST-ALIVE (mirror-alive)
 *
 * An annotation is servable as a prior when the document its scalar mirror
 * (= evidence[0]) cites still EXISTS — not when *any* evidence row's doc
 * survives. Chosen deliberately over any-alive:
 *  - every existing read surface keeps its exact one-column EXISTS predicate,
 *    so the many serving reads cannot drift from each other;
 *  - serving stays aligned with what scalar-only consumers re-ground FROM —
 *    a served annotation's `[reground: doc …]` pointer never dangles;
 *  - the invalidator is the sanctioned repair path: when evidence[0] breaks
 *    but later rows survive, it promotes the next live row into the mirror,
 *    restoring servability. A deletion path the cascade never saw degrades
 *    conservatively (not served) instead of serving a dead primary pointer.
 *
 * House style matches the sibling stores: plain functions over a
 * better-sqlite3 handle, explicit `now`, single-writer in production.
 */

import { containsNormalized } from "../quote-match.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * DDL — idempotent, so it is called both from `runSchemaSetup` (fresh
 * installs) and from the numbered migration that introduced it (upgrades),
 * exactly like `createBriefsStorageTables`.
 */
export function createAnnotationStorageTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_annotations (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      evidence_doc_id TEXT NOT NULL,
      evidence_quote TEXT NOT NULL,
      confidence REAL NOT NULL,
      claim_basis TEXT NOT NULL DEFAULT 'quoted',
      llm_derived INTEGER NOT NULL DEFAULT 1,
      created_by_run TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      invalidated_at INTEGER,
      verification_state TEXT,
      last_verified_at INTEGER,
      superseded_by TEXT
    )
  `);
  // "Annotations about this document" — the prior-injection read + the
  // content-change invalidation both key on the subject doc.
  db.exec("CREATE INDEX IF NOT EXISTS idx_doc_annotations_doc ON doc_annotations(doc_id)");
  // "Which annotations cite this document" — the invalidation / privacy
  // cascade keys on the grounding atom.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_doc_annotations_evidence ON doc_annotations(evidence_doc_id)",
  );
  // The synthesis prime scans recent LIVE annotations newest-first.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_doc_annotations_live ON doc_annotations(created_at) WHERE invalidated_at IS NULL",
  );
  // The re-verification sweep's partial index on (last_verified_at) lives in
  // migration 55, not here: this DDL runs before migrations on every boot, and
  // an upgrading install doesn't have the column until that migration's ALTER.

  // The multi-evidence child table: one row per grounding atom, 0-based
  // `position`, per-row `broken_at` liveness. The parent's scalar
  // evidence columns mirror the first LIVE row (see the module doc). The FK
  // cascade covers hard deletes where the pragma is on; every delete path in
  // this facade also removes child rows explicitly so tests on raw handles
  // (foreign_keys off by default) behave identically.
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_annotation_evidence (
      annotation_id TEXT NOT NULL REFERENCES doc_annotations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      evidence_doc_id TEXT NOT NULL,
      evidence_quote TEXT NOT NULL,
      broken_at INTEGER,
      PRIMARY KEY (annotation_id, position)
    )
  `);
  // "Which annotations rest on this document" — the invalidation guard and
  // the privacy cascade key on the evidence atom.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_doc_annotation_evidence_doc ON doc_annotation_evidence(evidence_doc_id)",
  );
}

/** One grounding atom as callers supply it (create / evidence replace). */
export interface AnnotationEvidenceInput {
  docId: string;
  quote: string;
}

/** One stored grounding atom of an annotation. */
export interface AnnotationEvidenceRow {
  annotationId: string;
  /** 0-based order of the atom within the annotation's evidence set. */
  position: number;
  evidenceDocId: string;
  evidenceQuote: string;
  /** Set when a content change broke this atom's quote; null = live. */
  brokenAt: number | null;
}

/**
 * Entailment-firewall stamp: `verified` = the verifier judged the evidence
 * quote to entail the claim at write time; `unverified` = the row awaits an
 * entailment (re-)check — persisted fail-open while a configured verifier was
 * unavailable, or re-flagged because its evidence document's content shifted
 * around a surviving quote (the re-verification sweep's backlog either way);
 * NULL = written with no verifier configured. `failed` is reserved for a
 * re-check that no longer finds entailment, but no code path writes it today
 * — verification runs resolve a failed re-check by weakening, superseding, or
 * retracting the row instead. If a writer starts stamping `failed`, restore
 * the `verification_failed` label rule in ../calibration.ts (see that module
 * doc's known-blind-spots paragraph).
 */
export type AnnotationVerificationState = "unverified" | "verified" | "failed";

/**
 * How far the claim reasons from its evidence: `quoted` = the evidence
 * essentially states the claim (a restatement); `inferred` = one licensed
 * deduction from the single cited source; `synthesized` = assembled across
 * sources — a pattern no single quote states. The tool boundary caps
 * confidence tighter the further down this ladder the claim sits.
 */
export type AnnotationClaimBasis = "quoted" | "inferred" | "synthesized";

export interface DocAnnotationRow {
  id: string;
  /** The document the observation is ABOUT. */
  docId: string;
  /** Open-vocabulary claim kind (e.g. `topic`, `entity`, `commitment-status`). */
  claimType: string;
  /** The derived observation. */
  claimText: string;
  /** The immutable source atom the claim is grounded in. */
  evidenceDocId: string;
  /** A verbatim quote from `evidenceDocId` supporting the claim. */
  evidenceQuote: string;
  confidence: number;
  /** How far the claim reasons from its evidence (see {@link AnnotationClaimBasis}). */
  claimBasis: AnnotationClaimBasis;
  llmDerived: boolean;
  createdByRun: string;
  createdAt: number;
  /** Last revise time (annotation_revise), or null if never revised. */
  updatedAt: number | null;
  /** Set when the subject/evidence doc changed; null = live prior. */
  invalidatedAt: number | null;
  /** Entailment-firewall stamp; null = written with no verifier configured. */
  verificationState: AnnotationVerificationState | null;
  /** Unix ms of the last entailment check; null = never checked. */
  lastVerifiedAt: number | null;
  /**
   * Id of the annotation that replaced this one. Set (alongside
   * `invalidated_at`) by a supersession, so audit can distinguish a
   * content-drift invalidation (null) from a belief revision (non-null).
   * Null on every live row.
   */
  supersededBy: string | null;
}

interface DocAnnotationDbRow {
  id: string;
  doc_id: string;
  claim_type: string;
  claim_text: string;
  evidence_doc_id: string;
  evidence_quote: string;
  confidence: number;
  claim_basis: string;
  llm_derived: number;
  created_by_run: string;
  created_at: number;
  updated_at: number | null;
  invalidated_at: number | null;
  verification_state: string | null;
  last_verified_at: number | null;
  superseded_by: string | null;
}

function rowToAnnotation(r: DocAnnotationDbRow): DocAnnotationRow {
  return {
    id: r.id,
    docId: r.doc_id,
    claimType: r.claim_type,
    claimText: r.claim_text,
    evidenceDocId: r.evidence_doc_id,
    evidenceQuote: r.evidence_quote,
    confidence: r.confidence,
    claimBasis: r.claim_basis as AnnotationClaimBasis,
    llmDerived: r.llm_derived !== 0,
    createdByRun: r.created_by_run,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    invalidatedAt: r.invalidated_at,
    verificationState: (r.verification_state as AnnotationVerificationState | null) ?? null,
    lastVerifiedAt: r.last_verified_at,
    supersededBy: r.superseded_by,
  };
}

export interface CreateDocAnnotationInput {
  id: string;
  docId: string;
  claimType: string;
  claimText: string;
  evidenceDocId: string;
  evidenceQuote: string;
  confidence: number;
  /** How far the claim reasons from its evidence (see {@link AnnotationClaimBasis}). */
  claimBasis: AnnotationClaimBasis;
  createdByRun: string;
  /** Defaults to true — every agent annotation is a derived (defeasible) fact. */
  llmDerived?: boolean;
  /** Entailment-firewall stamp; omitted/null = written with no verifier configured. */
  verificationState?: AnnotationVerificationState | null;
  /** Unix ms of the entailment check that stamped `verificationState`. */
  lastVerifiedAt?: number | null;
  /**
   * Grounding atoms BEYOND the primary `evidenceDocId`/`evidenceQuote` pair.
   * The full evidence set is the scalar pair (evidence[0]) followed by these,
   * in order; the facade writes the child rows and the scalar mirror
   * atomically.
   */
  additionalEvidence?: readonly AnnotationEvidenceInput[];
}

/**
 * Insert the child evidence rows for one annotation (inside the caller's
 * txn). Table-parameterized so the person store shares the exact write.
 */
export function insertAnnotationEvidenceRows(
  db: Db,
  table: string,
  annotationId: string,
  evidence: readonly AnnotationEvidenceInput[],
): void {
  const insert = db.prepare<[string, number, string, string]>(
    `INSERT INTO ${table} (annotation_id, position, evidence_doc_id, evidence_quote)
     VALUES (?, ?, ?, ?)`,
  );
  evidence.forEach((e, position) => insert.run(annotationId, position, e.docId, e.quote));
}

export function createDocAnnotation(
  db: Db,
  input: CreateDocAnnotationInput,
  now: number,
  requireDocuments = false,
): DocAnnotationRow {
  const txn = db.transaction((): DocAnnotationRow => {
    const evidenceDocIds = [
      ...new Set([
        input.docId,
        input.evidenceDocId,
        ...(input.additionalEvidence ?? []).map((evidence) => evidence.docId),
      ]),
    ];
    if (requireDocuments) {
      const placeholders = evidenceDocIds.map(() => "?").join(", ");
      const existing = db
        .prepare<
          unknown[],
          { id: string }
        >(`SELECT id FROM documents WHERE id IN (${placeholders})`)
        .all(...evidenceDocIds);
      if (existing.length !== evidenceDocIds.length) {
        throw new Error("annotation evidence document no longer exists");
      }
      const removed = db
        .prepare<unknown[], { id: string }>(
          `SELECT d.id
           FROM documents d
           JOIN removed_sources r ON r.id = d.source_id
           WHERE d.id IN (${placeholders})
           LIMIT 1`,
        )
        .get(...evidenceDocIds);
      if (removed) throw new Error("annotation evidence source is being removed");
    }

    db.prepare<unknown[]>(
      `INSERT INTO doc_annotations (
         id, doc_id, claim_type, claim_text, evidence_doc_id, evidence_quote,
         confidence, claim_basis, llm_derived, created_by_run, created_at, verification_state, last_verified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.docId,
      input.claimType,
      input.claimText,
      input.evidenceDocId,
      input.evidenceQuote,
      input.confidence,
      input.claimBasis,
      input.llmDerived === false ? 0 : 1,
      input.createdByRun,
      now,
      input.verificationState ?? null,
      input.lastVerifiedAt ?? null,
    );
    // The scalar pair IS evidence[0]; further atoms follow in order — one
    // transaction, so the mirror invariant holds from birth.
    insertAnnotationEvidenceRows(db, "doc_annotation_evidence", input.id, [
      { docId: input.evidenceDocId, quote: input.evidenceQuote },
      ...(input.additionalEvidence ?? []),
    ]);
    const created = db
      .prepare<[string], DocAnnotationDbRow>("SELECT * FROM doc_annotations WHERE id = ?")
      .get(input.id);
    if (!created) throw new Error(`annotation ${input.id} vanished mid-create`);
    return rowToAnnotation(created);
  });
  return txn();
}

/**
 * The LIVE evidence atoms of one annotation, in position order — the
 * multi-evidence read. Row 0 always equals the parent's scalar mirror
 * (the facade-enforced invariant); broken rows are omitted.
 */
export function listDocAnnotationEvidence(db: Db, annotationId: string): AnnotationEvidenceRow[] {
  return listAnnotationEvidenceRows(db, "doc_annotation_evidence", annotationId);
}

/** Live child evidence rows in position order — shared by both stores. */
export function listAnnotationEvidenceRows(
  db: Db,
  table: string,
  annotationId: string,
): AnnotationEvidenceRow[] {
  return db
    .prepare<
      [string],
      {
        annotation_id: string;
        position: number;
        evidence_doc_id: string;
        evidence_quote: string;
        broken_at: number | null;
      }
    >(`SELECT * FROM ${table} WHERE annotation_id = ? AND broken_at IS NULL ORDER BY position ASC`)
    .all(annotationId)
    .map((r) => ({
      annotationId: r.annotation_id,
      position: r.position,
      evidenceDocId: r.evidence_doc_id,
      evidenceQuote: r.evidence_quote,
      brokenAt: r.broken_at,
    }));
}

/**
 * Replace an annotation's WHOLE evidence set (inside the caller's txn):
 * drop the old child rows outright (the annotation is being re-grounded —
 * the parent's `invalidated_at`/`superseded_by` carry the audit trail, not
 * stale atoms) and insert the new set, mirroring evidence[0] into the
 * parent's scalar columns. Shared by both stores' evidence-replacing revise.
 */
export function replaceAnnotationEvidenceRows(
  db: Db,
  opts: { parentTable: string; childTable: string },
  annotationId: string,
  evidence: readonly AnnotationEvidenceInput[],
): void {
  if (evidence.length === 0) {
    throw new Error(`annotation ${annotationId}: an evidence replacement must keep >= 1 atom`);
  }
  db.prepare<[string]>(`DELETE FROM ${opts.childTable} WHERE annotation_id = ?`).run(annotationId);
  insertAnnotationEvidenceRows(db, opts.childTable, annotationId, evidence);
  db.prepare<[string, string, string]>(
    `UPDATE ${opts.parentTable} SET evidence_doc_id = ?, evidence_quote = ? WHERE id = ?`,
  ).run(evidence[0]!.docId, evidence[0]!.quote, annotationId);
}

export interface UpdateDocAnnotationPatch {
  claimType?: string;
  claimText?: string;
  confidence?: number;
  /** Re-declared reasoning distance for the revised claim. */
  claimBasis?: AnnotationClaimBasis;
  /** Entailment-firewall re-stamp for the revised claim. */
  verificationState?: AnnotationVerificationState | null;
  /** Unix ms of the entailment check that stamped `verificationState`. */
  lastVerifiedAt?: number | null;
  /**
   * Replacement for the annotation's WHOLE evidence set (≥ 1 atom). The old
   * child rows are dropped, the new set inserted, and evidence[0] mirrored
   * into the scalar columns — atomically with the rest of the patch.
   */
  evidence?: readonly AnnotationEvidenceInput[];
}

/**
 * Revise a live prior in place — the agent re-grounds an observation whose
 * wording/confidence it now judges wrong. Claim fields + confidence change in
 * place; the grounding may only change as a WHOLE-set replacement via
 * `patch.evidence` (the mirror invariant holds through it) — individual atoms
 * are never edited. Stamps updated_at. The evidence firewall re-check lives
 * at the tool boundary, exactly like create. Returns the revised row, or
 * null when no annotation with that id exists.
 */
export function updateDocAnnotation(
  db: Db,
  id: string,
  patch: UpdateDocAnnotationPatch,
  now: number,
): DocAnnotationRow | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.claimType !== undefined) {
    sets.push("claim_type = ?");
    vals.push(patch.claimType);
  }
  if (patch.claimText !== undefined) {
    sets.push("claim_text = ?");
    vals.push(patch.claimText);
  }
  if (patch.confidence !== undefined) {
    sets.push("confidence = ?");
    vals.push(patch.confidence);
  }
  if (patch.claimBasis !== undefined) {
    sets.push("claim_basis = ?");
    vals.push(patch.claimBasis);
  }
  if (patch.verificationState !== undefined) {
    sets.push("verification_state = ?");
    vals.push(patch.verificationState);
  }
  if (patch.lastVerifiedAt !== undefined) {
    sets.push("last_verified_at = ?");
    vals.push(patch.lastVerifiedAt);
  }
  // updated_at always advances on a revise, even a no-field-change call.
  sets.push("updated_at = ?");
  vals.push(now);
  const txn = db.transaction((): DocAnnotationRow | null => {
    // Only a LIVE prior is revisable — a retracted/invalidated row stays dead
    // rather than being edited back into circulation.
    const res = db
      .prepare<
        unknown[]
      >(`UPDATE doc_annotations SET ${sets.join(", ")} WHERE id = ? AND invalidated_at IS NULL`)
      .run(...vals, id);
    if (res.changes === 0) return null;
    if (patch.evidence !== undefined) {
      replaceAnnotationEvidenceRows(
        db,
        { parentTable: "doc_annotations", childTable: "doc_annotation_evidence" },
        id,
        patch.evidence,
      );
    }
    const row = db
      .prepare<[string], DocAnnotationDbRow>("SELECT * FROM doc_annotations WHERE id = ?")
      .get(id);
    return row ? rowToAnnotation(row) : null;
  });
  return txn();
}

/** Hard-delete one annotation by id (retract), evidence rows included. */
export function deleteDocAnnotation(db: Db, id: string): boolean {
  const txn = db.transaction((): boolean => {
    db.prepare<[string]>("DELETE FROM doc_annotation_evidence WHERE annotation_id = ?").run(id);
    return db.prepare<[string]>("DELETE FROM doc_annotations WHERE id = ?").run(id).changes > 0;
  });
  return txn();
}

/**
 * Retire a LIVE prior in favour of its successor: stamp BOTH
 * `invalidated_at` (so every existing liveness predicate drops it) and
 * `superseded_by` (so audit can tell belief revision from content drift).
 * Idempotent — false when the row is unknown or already dead, so a replay
 * can never re-point a row at a second successor.
 */
export function supersedeDocAnnotation(db: Db, oldId: string, newId: string, now: number): boolean {
  const res = db
    .prepare<[number, string, string]>(
      `UPDATE doc_annotations SET invalidated_at = ?, superseded_by = ?
        WHERE id = ? AND invalidated_at IS NULL`,
    )
    .run(now, newId, oldId);
  return res.changes > 0;
}

/**
 * Belief revision as ONE writer op: create the successor and retire the
 * superseded prior in a single transaction, so a crash can never leave the
 * new claim standing beside the old one it contradicts. `superseded` is
 * false when the old row was unknown or already dead by write time (the
 * tool validated it live, but reads happen outside the serialized write) —
 * the create still lands; the old prior is dead either way. A self-supersede
 * (`supersedesId === input.id`) would commit a row born dead pointing at
 * itself, so it throws instead.
 */
export function createDocAnnotationSuperseding(
  db: Db,
  input: CreateDocAnnotationInput,
  supersedesId: string,
  now: number,
  requireDocuments = false,
): { annotation: DocAnnotationRow; superseded: boolean } {
  if (supersedesId === input.id) {
    throw new Error(`annotation ${input.id} cannot supersede itself`);
  }
  const txn = db.transaction(() => {
    const annotation = createDocAnnotation(db, input, now, requireDocuments);
    const superseded = supersedeDocAnnotation(db, supersedesId, input.id, now);
    return { annotation, superseded };
  });
  return txn();
}

/**
 * Pure belief retirement as ONE writer op — no create: retire the live prior
 * `id` in favour of the ALREADY-EXISTING live annotation `supersededById`
 * (the contradiction-judge's "keep the correct claim, retire the outdated
 * one" repair). Both liveness checks run inside the transaction, so a row
 * that died between the tool's validation read and this write can neither be
 * re-retired nor be pointed at as a dead successor: `superseded` comes back
 * false and nothing changes. A self-supersede throws (a live row pointing at
 * itself would be born dead).
 */
export function supersedeDocAnnotationBy(
  db: Db,
  id: string,
  supersededById: string,
  now: number,
): { superseded: boolean } {
  if (id === supersededById) {
    throw new Error(`annotation ${id} cannot supersede itself`);
  }
  const txn = db.transaction(() => {
    const successor = getDocAnnotation(db, supersededById);
    if (successor === null || successor.invalidatedAt !== null) return { superseded: false };
    return { superseded: supersedeDocAnnotation(db, id, supersededById, now) };
  });
  return txn();
}

/** Single annotation by id — the read the revise firewall re-check needs. */
export function getDocAnnotation(db: Db, id: string): DocAnnotationRow | null {
  const row = db
    .prepare<[string], DocAnnotationDbRow>("SELECT * FROM doc_annotations WHERE id = ?")
    .get(id);
  return row ? rowToAnnotation(row) : null;
}

/**
 * Recent LIVE annotations across the corpus, newest first — the synthesis
 * prime. A prior is only valid while BOTH the document it is about and the
 * evidence it rests on still exist, and it has no explicit failed verification
 * state. `unverified` and `failed` rows stay available to the inspection and
 * re-verification paths, but are quarantined from automatic synthesis priming.
 * A null state still means no verifier was assigned and is eligible. A dangling
 * annotation (either doc deleted via any path — including a bulk source wipe
 * that no cascade covers) is never surfaced as a prior.
 */
export function listRecentLiveAnnotations(
  db: Db,
  opts: { sinceMs: number; limit: number },
): DocAnnotationRow[] {
  const rows = db
    .prepare<[number, number], DocAnnotationDbRow>(
      `SELECT * FROM doc_annotations
        WHERE invalidated_at IS NULL AND created_at >= ?
          AND (verification_state IS NULL OR verification_state = 'verified')
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = doc_annotations.doc_id)
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = doc_annotations.evidence_doc_id)
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(opts.sinceMs, opts.limit);
  return rows.map(rowToAnnotation);
}

/**
 * Live annotations whose SUBJECT is `docId`, newest first — the per-document
 * priors surfaced when the agent inspects a document. Only non-invalidated
 * rows whose evidence doc still exists: a prior whose grounding atom vanished
 * (via any deletion path the invalidation cascade didn't see) is
 * un-regroundable and must not be served. The reground discipline still
 * applies to what IS returned (they are hints, not facts).
 */
export function listLiveAnnotationsForDoc(
  db: Db,
  docId: string,
  limitOrOptions: number | { limit?: number; before?: { createdAt: number; id: string } } = 20,
): DocAnnotationRow[] {
  const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const cursor = options.before ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
  const params: Array<string | number> = [docId];
  if (options.before) {
    params.push(options.before.createdAt, options.before.createdAt, options.before.id);
  }
  params.push(options.limit ?? 20);
  const rows = db
    .prepare<(string | number)[], DocAnnotationDbRow>(
      `SELECT * FROM doc_annotations
        WHERE doc_id = ? AND invalidated_at IS NULL
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = doc_annotations.evidence_doc_id)
          ${cursor}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map(rowToAnnotation);
}

/**
 * The one-belief conflict probe: every live annotation on `docId` whose
 * claim type matches `claimType` case-insensitively (stored rows may predate
 * boundary normalization). Matching happens in SQL over ALL live rows on the
 * subject — `limit` caps only the candidates returned, never which rows can
 * match — so a standing belief can't escape the probe behind newer rows.
 * `excludeId` drops one row from the match (a supersede target, or the row
 * being revised).
 */
export function listLiveSameClaimTypeAnnotationsForDoc(
  db: Db,
  docId: string,
  claimType: string,
  opts: { excludeId?: string; limit: number },
): DocAnnotationRow[] {
  const rows = db
    .prepare<unknown[], DocAnnotationDbRow>(
      `SELECT * FROM doc_annotations
        WHERE doc_id = ? AND claim_type = ? COLLATE NOCASE AND invalidated_at IS NULL
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = doc_annotations.evidence_doc_id)
          ${opts.excludeId !== undefined ? "AND id != ?" : ""}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(docId, claimType, ...(opts.excludeId !== undefined ? [opts.excludeId] : []), opts.limit);
  return rows.map(rowToAnnotation);
}

/**
 * True when a live annotation names `docId` as its subject or as ANY of its
 * live evidence atoms — the invalidator's cheap pre-write guard, so a change
 * to a document cited only by a secondary atom still triggers invalidation.
 */
export function hasLiveAnnotationsForDoc(db: Db, docId: string): boolean {
  const subject = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM doc_annotations
        WHERE doc_id = ? AND invalidated_at IS NULL LIMIT 1`,
    )
    .get(docId);
  if (subject !== undefined) return true;
  const evidence = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM doc_annotation_evidence e
        JOIN doc_annotations a ON a.id = e.annotation_id
       WHERE e.evidence_doc_id = ? AND e.broken_at IS NULL AND a.invalidated_at IS NULL LIMIT 1`,
    )
    .get(docId);
  return evidence !== undefined;
}

/** Cheap existence check — does the annotation store hold any rows at all? */
export function hasAnyDocAnnotations(db: Db): boolean {
  return (
    db.prepare<[], { one: number }>("SELECT 1 AS one FROM doc_annotations LIMIT 1").get() !==
    undefined
  );
}

/** One re-verification due candidate — the sweep's selection row. */
export interface DueVerificationAnnotation {
  id: string;
  lastVerifiedAt: number | null;
  createdAt: number;
}

/**
 * LIVE doc annotations due a re-verification check — never checked, or last
 * checked before `cutoff` — oldest-verified first with never-checked rows
 * leading. Served by the migration-55 partial index on
 * `(last_verified_at) WHERE invalidated_at IS NULL`. Rows whose evidence doc
 * vanished stay selectable: they are un-regroundable, and the verification
 * run's verdict for them is a retract.
 */
export function listDueVerificationDocAnnotations(
  db: Db,
  opts: { cutoff: number; limit: number },
): DueVerificationAnnotation[] {
  return db
    .prepare<[number, number], { id: string; last_verified_at: number | null; created_at: number }>(
      `SELECT id, last_verified_at, created_at FROM doc_annotations
        WHERE invalidated_at IS NULL AND (last_verified_at IS NULL OR last_verified_at < ?)
        ORDER BY COALESCE(last_verified_at, 0) ASC, created_at ASC LIMIT ?`,
    )
    .all(opts.cutoff, opts.limit)
    .map((r) => ({ id: r.id, lastVerifiedAt: r.last_verified_at, createdAt: r.created_at }));
}

/**
 * What a content-change invalidation did: `invalidated` annotations lost
 * their LAST live grounding atom and were soft-dropped; `flaggedUnverified`
 * annotations stay live (at least one atom survived), re-stamped
 * `unverified` for the re-verification sweep to re-judge; `promoted` counts
 * the survivors whose evidence[0] broke and whose scalar mirror was
 * re-pointed at the next surviving atom.
 */
export interface AnnotationInvalidationResult {
  invalidated: number;
  flaggedUnverified: number;
  promoted: number;
}

/** Bound-variable-safe id batches for the IN(...) updates below. */
const ID_CHUNK = 400;

function stampInvalidated(db: Db, table: string, ids: readonly string[], now: number): void {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const batch = ids.slice(i, i + ID_CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    db.prepare<unknown[]>(
      `UPDATE ${table} SET invalidated_at = ? WHERE id IN (${placeholders})`,
    ).run(now, ...batch);
  }
}

function stampUnverified(db: Db, table: string, ids: readonly string[]): void {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const batch = ids.slice(i, i + ID_CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    // last_verified_at is cleared, not just aged: the content around the
    // quote shifted, so any previous entailment verdict no longer speaks to
    // the current document — the row goes to the FRONT of the re-verification
    // backlog (never-verified rows lead the due ordering).
    db.prepare<unknown[]>(
      `UPDATE ${table} SET verification_state = 'unverified', last_verified_at = NULL
        WHERE id IN (${placeholders})`,
    ).run(...batch);
  }
}

/**
 * Judge every live evidence atom of `annotationId` against the change to
 * `docId`, stamping `broken_at` on the atoms that no longer ground anything:
 * an atom citing `docId` whose quote no longer appears in `content` (empty
 * when the document row vanished), and any atom whose evidence document row
 * no longer EXISTS — a deletion path the privacy cascade never saw leaves
 * such atoms behind, and promoting one into the scalar mirror would leave the
 * annotation live-yet-unservable (every serving read requires the mirror doc
 * to exist). Returns the annotation's still-live atoms afterwards, in
 * position order — shared per-row core of both stores' content-change
 * invalidation, and what makes the promote-on-break head always servable.
 */
export function breakAnnotationEvidenceForDoc(
  db: Db,
  childTable: string,
  annotationId: string,
  docId: string,
  content: string,
  now: number,
): AnnotationEvidenceRow[] {
  const live = listAnnotationEvidenceRows(db, childTable, annotationId);
  const existsStmt = db.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM documents WHERE id = ?",
  );
  const docAlive = new Map<string, boolean>();
  const evidenceDocExists = (id: string): boolean => {
    let alive = docAlive.get(id);
    if (alive === undefined) {
      alive = existsStmt.get(id) !== undefined;
      docAlive.set(id, alive);
    }
    return alive;
  };
  const broken = live.filter(
    (e) =>
      (e.evidenceDocId === docId && !containsNormalized(content, e.evidenceQuote)) ||
      !evidenceDocExists(e.evidenceDocId),
  );
  const stamp = db.prepare<[number, string, number]>(
    `UPDATE ${childTable} SET broken_at = ? WHERE annotation_id = ? AND position = ?`,
  );
  for (const e of broken) stamp.run(now, annotationId, e.position);
  const brokenPositions = new Set(broken.map((e) => e.position));
  return live.filter((e) => !brokenPositions.has(e.position));
}

/**
 * Content-change invalidation for annotations touching `docId` — surgical,
 * per evidence ATOM. The changed document's new content decides each live
 * atom's fate: an atom citing `docId` whose quote no longer appears is
 * stamped broken. Then per annotation:
 *
 *  - NO live atoms remain (or the annotation's SUBJECT is the now-vanished
 *    document) → the annotation soft-invalidates (kept for audit);
 *  - live atoms remain but evidence[0] broke → the next surviving atom is
 *    PROMOTED into the scalar mirror (same transaction), and the annotation
 *    — like every other touched survivor — is re-stamped
 *    `verification_state = 'unverified'` with `last_verified_at` cleared, so
 *    the re-verification sweep re-judges the claim against what remains.
 *
 * The deletion-driven privacy purge (`cascadeAnnotationPrivacyDelete`) stays
 * blanket — derived text may embed the removed content. A vanished document
 * row degrades exactly like a content change that dropped every quote: the
 * atoms citing it break (un-regroundable) — as does any atom whose OWN
 * evidence document vanished via a path no cascade saw, so a promotion can
 * never re-point the mirror at a dead document — and only an annotation left
 * with no grounding at all dies.
 *
 * `now` is the content-change event time; only annotations that existed AT
 * that moment (`created_at <= now`) are touched, so an annotation a later run
 * creates against the NEW content — which may land on the writer before this
 * queued invalidate does — is not wrongly dropped. Idempotent.
 */
export function invalidateAnnotationsForDoc(
  db: Db,
  docId: string,
  now: number,
): AnnotationInvalidationResult {
  const txn = db.transaction((): AnnotationInvalidationResult => {
    const candidates = db
      .prepare<
        [string, string, number],
        { id: string; doc_id: string; evidence_doc_id: string; evidence_quote: string }
      >(
        `SELECT id, doc_id, evidence_doc_id, evidence_quote FROM doc_annotations a
          WHERE (doc_id = ? OR EXISTS (
                  SELECT 1 FROM doc_annotation_evidence e
                   WHERE e.annotation_id = a.id AND e.evidence_doc_id = ? AND e.broken_at IS NULL))
            AND invalidated_at IS NULL AND created_at <= ?`,
      )
      .all(docId, docId, now);
    if (candidates.length === 0) return { invalidated: 0, flaggedUnverified: 0, promoted: 0 };
    const doc = db
      .prepare<[string], { content: string | null }>("SELECT content FROM documents WHERE id = ?")
      .get(docId);
    const docGone = doc === undefined;
    const content = doc?.content ?? "";
    const dead: string[] = [];
    const survivors: string[] = [];
    let promoted = 0;
    for (const c of candidates) {
      const remaining = breakAnnotationEvidenceForDoc(
        db,
        "doc_annotation_evidence",
        c.id,
        docId,
        content,
        now,
      );
      // A subject whose document row vanished is un-servable regardless of
      // its grounding (every serving read requires the subject doc), so the
      // annotation dies with it; otherwise only a fully-ungrounded one dies.
      if (remaining.length === 0 || (docGone && c.doc_id === docId)) {
        dead.push(c.id);
        continue;
      }
      const head = remaining[0]!;
      if (head.evidenceDocId !== c.evidence_doc_id || head.evidenceQuote !== c.evidence_quote) {
        // evidence[0] broke: promote the next surviving atom into the mirror.
        db.prepare<[string, string, string]>(
          `UPDATE doc_annotations SET evidence_doc_id = ?, evidence_quote = ? WHERE id = ?`,
        ).run(head.evidenceDocId, head.evidenceQuote, c.id);
        promoted += 1;
      }
      survivors.push(c.id);
    }
    stampInvalidated(db, "doc_annotations", dead, now);
    stampUnverified(db, "doc_annotations", survivors);
    return { invalidated: dead.length, flaggedUnverified: survivors.length, promoted };
  });
  return txn();
}

/**
 * Privacy / deletion cascade: HARD-delete every annotation whose subject or
 * ANY evidence atom (live or broken — the blanket applies to everything the
 * annotation ever embedded) is one of `deletedDocIds`. A soft invalidation
 * would leave the derived `claim_text` / `evidence_quote` — which may embed
 * the deleted document's content — on disk, so a delete purges outright,
 * mirroring `cascadeOpenLoopPrivacyDelete`. Child evidence rows are purged
 * with their parents. Returns the deleted annotation ids. Chunks the id
 * lists so a large batch stays under SQLite's bound-variable ceiling.
 */
export function cascadeAnnotationPrivacyDelete(db: Db, deletedDocIds: readonly string[]): string[] {
  if (deletedDocIds.length === 0) return [];
  // 2 binds per input id (subject OR evidence-atom probe); keep each statement
  // well under SQLite's ~999 default variable limit.
  const CHUNK = 400;
  const ids = new Set<string>();
  for (let i = 0; i < deletedDocIds.length; i += CHUNK) {
    const batch = deletedDocIds.slice(i, i + CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    for (const r of db
      .prepare<string[], { id: string }>(
        `SELECT id FROM doc_annotations a
          WHERE doc_id IN (${placeholders}) OR EXISTS (
                  SELECT 1 FROM doc_annotation_evidence e
                   WHERE e.annotation_id = a.id AND e.evidence_doc_id IN (${placeholders}))`,
      )
      .all(...batch, ...batch)) {
      ids.add(r.id);
    }
  }
  if (ids.size === 0) return [];
  const all = [...ids];
  for (let i = 0; i < all.length; i += CHUNK) {
    const batch = all.slice(i, i + CHUNK);
    const idPlaceholders = batch.map(() => "?").join(", ");
    db.prepare<string[]>(
      `DELETE FROM doc_annotation_evidence WHERE annotation_id IN (${idPlaceholders})`,
    ).run(...batch);
    db.prepare<string[]>(`DELETE FROM doc_annotations WHERE id IN (${idPlaceholders})`).run(
      ...batch,
    );
  }
  return all;
}
