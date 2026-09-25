// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable person-annotation store — the person-keyed sibling of
 * `doc_annotations`. Where a `doc_annotation` records an evidence-grounded
 * observation ABOUT a document, a `person_annotation` records one ABOUT a
 * PERSON (a role, a relationship, a stable preference), grounded the same way:
 * every claim cites an immutable source atom (`evidence_doc_id` + a verbatim
 * `evidence_quote`) and is capped below certainty at the tool boundary.
 *
 * The subject is a person id, NOT a document — people merge and re-derive, so
 * there is no foreign key on `person_id` (the `open_loop_people` pattern). The
 * only document coupling is the evidence set, which drives BOTH the
 * content-change soft-invalidation and the privacy-delete hard purge.
 *
 * Multi-evidence works exactly as in `annotations.ts` (read its module doc):
 * the atoms live in `person_annotation_evidence` with per-row `broken_at`
 * liveness, the parent's scalar columns mirror evidence[0] (the first LIVE
 * atom), and the servable rule is FIRST-ALIVE — an annotation is served
 * while its mirror atom's document exists, with the invalidator promoting
 * the next surviving atom into the mirror when evidence[0] breaks.
 *
 * House style matches `annotations.ts`: plain functions over a better-sqlite3
 * handle, explicit `now`, single-writer in production.
 */

import {
  breakAnnotationEvidenceForDoc,
  insertAnnotationEvidenceRows,
  listAnnotationEvidenceRows,
  replaceAnnotationEvidenceRows,
} from "./annotations.js";
import type Database from "better-sqlite3";
import type {
  AnnotationClaimBasis,
  AnnotationEvidenceInput,
  AnnotationEvidenceRow,
  AnnotationInvalidationResult,
  AnnotationVerificationState,
} from "./annotations.js";

type Db = Database.Database;

export function createPersonAnnotationStorageTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_annotations (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
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
  // "Annotations about this person" — the per-person read + attach.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_person_annotations_person ON person_annotations(person_id)",
  );
  // "Which annotations cite this document" — the invalidation / privacy cascade.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_person_annotations_evidence ON person_annotations(evidence_doc_id)",
  );
  // The synthesis prime scans recent LIVE annotations newest-first.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_person_annotations_live ON person_annotations(created_at) WHERE invalidated_at IS NULL",
  );
  // The re-verification sweep's partial index on (last_verified_at) lives in
  // migration 55, not here: this DDL runs before migrations on every boot, and
  // an upgrading install doesn't have the column until that migration's ALTER.

  // The multi-evidence child table — see `doc_annotation_evidence` in
  // annotations.ts for the shape rationale (per-atom liveness + the
  // evidence[0] scalar mirror).
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_annotation_evidence (
      annotation_id TEXT NOT NULL REFERENCES person_annotations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      evidence_doc_id TEXT NOT NULL,
      evidence_quote TEXT NOT NULL,
      broken_at INTEGER,
      PRIMARY KEY (annotation_id, position)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_person_annotation_evidence_doc ON person_annotation_evidence(evidence_doc_id)",
  );
}

export interface PersonAnnotationRow {
  id: string;
  /** The person the observation is ABOUT. */
  personId: string;
  /** Open-vocabulary claim kind (e.g. `role`, `relationship`, `preference`). */
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
  /** Last revise time (person_annotation_revise), or null if never revised. */
  updatedAt: number | null;
  /** Set when the evidence doc changed; null = live prior. */
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

interface PersonAnnotationDbRow {
  id: string;
  person_id: string;
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

function rowToPersonAnnotation(r: PersonAnnotationDbRow): PersonAnnotationRow {
  return {
    id: r.id,
    personId: r.person_id,
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

export interface CreatePersonAnnotationInput {
  id: string;
  personId: string;
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
   * Grounding atoms BEYOND the primary `evidenceDocId`/`evidenceQuote` pair
   * (the full set = scalar pair as evidence[0], then these in order).
   */
  additionalEvidence?: readonly AnnotationEvidenceInput[];
}

export function createPersonAnnotation(
  db: Db,
  input: CreatePersonAnnotationInput,
  now: number,
): PersonAnnotationRow {
  const txn = db.transaction((): PersonAnnotationRow => {
    db.prepare<unknown[]>(
      `INSERT INTO person_annotations (
         id, person_id, claim_type, claim_text, evidence_doc_id, evidence_quote,
         confidence, claim_basis, llm_derived, created_by_run, created_at, verification_state, last_verified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.personId,
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
    insertAnnotationEvidenceRows(db, "person_annotation_evidence", input.id, [
      { docId: input.evidenceDocId, quote: input.evidenceQuote },
      ...(input.additionalEvidence ?? []),
    ]);
    const created = db
      .prepare<[string], PersonAnnotationDbRow>("SELECT * FROM person_annotations WHERE id = ?")
      .get(input.id);
    if (!created) throw new Error(`person annotation ${input.id} vanished mid-create`);
    return rowToPersonAnnotation(created);
  });
  return txn();
}

/**
 * The LIVE evidence atoms of one person annotation, in position order — row 0
 * always equals the parent's scalar mirror (the facade-enforced invariant).
 */
export function listPersonAnnotationEvidence(
  db: Db,
  annotationId: string,
): AnnotationEvidenceRow[] {
  return listAnnotationEvidenceRows(db, "person_annotation_evidence", annotationId);
}

/** Single annotation by id — the read the revise firewall re-check needs. */
export function getPersonAnnotation(db: Db, id: string): PersonAnnotationRow | null {
  const row = db
    .prepare<[string], PersonAnnotationDbRow>("SELECT * FROM person_annotations WHERE id = ?")
    .get(id);
  return row ? rowToPersonAnnotation(row) : null;
}

/**
 * Recent LIVE person annotations across the corpus, newest first — the
 * synthesis prime. Explicitly `unverified` and `failed` rows stay inspectable
 * and eligible for re-verification, but cannot automatically prime synthesis;
 * null (no configured verifier) remains eligible. Only rows whose evidence doc
 * still exists are returned; the subject person_id is not re-checked (a
 * physical merge re-keys it to the winner, and a merged-away subject would
 * just be a slightly stale prime hint).
 */
export function listRecentLivePersonAnnotations(
  db: Db,
  opts: { sinceMs: number; limit: number },
): PersonAnnotationRow[] {
  const rows = db
    .prepare<[number, number], PersonAnnotationDbRow>(
      `SELECT * FROM person_annotations
        WHERE invalidated_at IS NULL AND created_at >= ?
          AND (verification_state IS NULL OR verification_state = 'verified')
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = person_annotations.evidence_doc_id)
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(opts.sinceMs, opts.limit);
  return rows.map(rowToPersonAnnotation);
}

/**
 * Depth bound on merge-chain walks, matching `resolvePersonId`'s 10-hop
 * ceiling — the two must agree on what counts as one equivalence class.
 */
const MERGE_CHAIN_MAX_DEPTH = 10;

/**
 * Recursive CTE expanding a canonical person id (bound once) to its full
 * merge equivalence class: every person whose `merged_into` chain lands on
 * it, to {@link MERGE_CHAIN_MAX_DEPTH} hops (chains A→B→C are routine — a
 * one-hop expansion would lose A when probing C). The depth bound also
 * terminates a pathological `merged_into` cycle.
 */
const MERGE_CLASS_CTE = `RECURSIVE merge_class(id, depth) AS (
    SELECT ?, 0
    UNION ALL
    SELECT p.id, m.depth + 1 FROM people p JOIN merge_class m ON p.merged_into = m.id
     WHERE m.depth < ${MERGE_CHAIN_MAX_DEPTH}
  )`;

/**
 * Live annotations whose SUBJECT is `personId`, most-recently-touched first
 * (a revise resurfaces the row, so keeping a foundational fact current keeps it
 * above the injection cap). Pass a canonical (`resolvePersonId`'d) id: the query
 * expands it to its full merge equivalence class ({@link MERGE_CLASS_CTE}),
 * because a *logical* merge (`merged_into`) does not re-key
 * `person_annotations`, so a claim authored against a now-merged-away id —
 * even one several merge hops down — would otherwise vanish from the
 * canonical's lookup.
 *
 * Only rows whose evidence doc still exists are returned: an annotation whose
 * grounding atom is gone is un-regroundable by definition, so it must not be
 * served as a prior on ANY surface (self-memory injection, the HTTP routes,
 * lookup hints). Deletion paths outside the privacy cascade (a source
 * remove/re-add that re-keys doc ids, dedup, migrations) would otherwise leave
 * a dangling claim injected forever.
 */
export function listLivePersonAnnotationsForPerson(
  db: Db,
  personId: string,
  limitOrOptions: number | { limit?: number; before?: { sortAt: number; id: string } } = 20,
): PersonAnnotationRow[] {
  const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const cursor = options.before
    ? `AND (COALESCE(updated_at, created_at) < ?
           OR (COALESCE(updated_at, created_at) = ? AND id < ?))`
    : "";
  const params: Array<string | number> = [personId];
  if (options.before) {
    params.push(options.before.sortAt, options.before.sortAt, options.before.id);
  }
  params.push(options.limit ?? 20);
  const rows = db
    .prepare<(string | number)[], PersonAnnotationDbRow>(
      `WITH ${MERGE_CLASS_CTE}
       SELECT * FROM person_annotations
        WHERE person_id IN (SELECT id FROM merge_class)
          AND invalidated_at IS NULL
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = person_annotations.evidence_doc_id)
          ${cursor}
        ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map(rowToPersonAnnotation);
}

/**
 * The one-belief conflict probe, person store: every live annotation whose
 * subject falls in `personId`'s merge equivalence class and whose claim type
 * matches `claimType` case-insensitively (stored rows may predate boundary
 * normalization). Matching happens in SQL over ALL live rows in the class —
 * `limit` caps only the candidates returned, never which rows can match.
 * `excludeId` drops one row (a supersede target, or the row being revised).
 */
export function listLiveSameClaimTypePersonAnnotations(
  db: Db,
  personId: string,
  claimType: string,
  opts: { excludeId?: string; limit: number },
): PersonAnnotationRow[] {
  const rows = db
    .prepare<unknown[], PersonAnnotationDbRow>(
      `WITH ${MERGE_CLASS_CTE}
       SELECT * FROM person_annotations
        WHERE person_id IN (SELECT id FROM merge_class)
          AND claim_type = ? COLLATE NOCASE AND invalidated_at IS NULL
          AND EXISTS (SELECT 1 FROM documents WHERE documents.id = person_annotations.evidence_doc_id)
          ${opts.excludeId !== undefined ? "AND id != ?" : ""}
        ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`,
    )
    .all(
      personId,
      claimType,
      ...(opts.excludeId !== undefined ? [opts.excludeId] : []),
      opts.limit,
    );
  return rows.map(rowToPersonAnnotation);
}

/** True when a live annotation cites `docId` in ANY of its live evidence atoms. */
export function hasLivePersonAnnotationsForEvidenceDoc(db: Db, docId: string): boolean {
  const row = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM person_annotation_evidence e
        JOIN person_annotations a ON a.id = e.annotation_id
       WHERE e.evidence_doc_id = ? AND e.broken_at IS NULL AND a.invalidated_at IS NULL LIMIT 1`,
    )
    .get(docId);
  return row !== undefined;
}

/** Cheap existence check — does the person-annotation store hold any rows? */
export function hasAnyPersonAnnotations(db: Db): boolean {
  return (
    db.prepare<[], { one: number }>("SELECT 1 AS one FROM person_annotations LIMIT 1").get() !==
    undefined
  );
}

/** Bound-variable-safe id batches for the IN(...) updates below. */
const ID_CHUNK = 400;

/**
 * Content-change invalidation for person annotations grounded in `docId` —
 * surgical per evidence ATOM, like the doc-store sibling
 * (`invalidateAnnotationsForDoc`): an atom citing `docId` whose quote no
 * longer appears in the document's NEW content (or whose document row
 * vanished) is stamped broken; the annotation soft-invalidates only when NO
 * live atom remains. A survivor whose evidence[0] broke gets the next
 * surviving atom promoted into its scalar mirror, and every survivor is
 * re-stamped `verification_state = 'unverified'` with `last_verified_at`
 * cleared, so the re-verification sweep re-judges entailment against the
 * shifted content. The privacy purge stays blanket via
 * `cascadePersonAnnotationPrivacyDelete`. Keeps the `created_at <= now`
 * event-time guard. Idempotent.
 */
export function invalidatePersonAnnotationsForDoc(
  db: Db,
  docId: string,
  now: number,
): AnnotationInvalidationResult {
  const txn = db.transaction((): AnnotationInvalidationResult => {
    const candidates = db
      .prepare<[string, number], { id: string; evidence_doc_id: string; evidence_quote: string }>(
        `SELECT id, evidence_doc_id, evidence_quote FROM person_annotations a
          WHERE EXISTS (
                  SELECT 1 FROM person_annotation_evidence e
                   WHERE e.annotation_id = a.id AND e.evidence_doc_id = ? AND e.broken_at IS NULL)
            AND invalidated_at IS NULL AND created_at <= ?`,
      )
      .all(docId, now);
    if (candidates.length === 0) return { invalidated: 0, flaggedUnverified: 0, promoted: 0 };
    const doc = db
      .prepare<[string], { content: string | null }>("SELECT content FROM documents WHERE id = ?")
      .get(docId);
    const content = doc?.content ?? "";
    const dead: string[] = [];
    const survivors: string[] = [];
    let promoted = 0;
    for (const c of candidates) {
      const remaining = breakAnnotationEvidenceForDoc(
        db,
        "person_annotation_evidence",
        c.id,
        docId,
        content,
        now,
      );
      if (remaining.length === 0) {
        dead.push(c.id);
        continue;
      }
      const head = remaining[0]!;
      if (head.evidenceDocId !== c.evidence_doc_id || head.evidenceQuote !== c.evidence_quote) {
        db.prepare<[string, string, string]>(
          `UPDATE person_annotations SET evidence_doc_id = ?, evidence_quote = ? WHERE id = ?`,
        ).run(head.evidenceDocId, head.evidenceQuote, c.id);
        promoted += 1;
      }
      survivors.push(c.id);
    }
    for (let i = 0; i < dead.length; i += ID_CHUNK) {
      const batch = dead.slice(i, i + ID_CHUNK);
      const placeholders = batch.map(() => "?").join(", ");
      db.prepare<unknown[]>(
        `UPDATE person_annotations SET invalidated_at = ? WHERE id IN (${placeholders})`,
      ).run(now, ...batch);
    }
    for (let i = 0; i < survivors.length; i += ID_CHUNK) {
      const batch = survivors.slice(i, i + ID_CHUNK);
      const placeholders = batch.map(() => "?").join(", ");
      // Cleared, not just aged — a previous entailment verdict no longer
      // speaks to the shifted content, so the row leads the sweep's backlog.
      db.prepare<unknown[]>(
        `UPDATE person_annotations SET verification_state = 'unverified', last_verified_at = NULL
          WHERE id IN (${placeholders})`,
      ).run(...batch);
    }
    return { invalidated: dead.length, flaggedUnverified: survivors.length, promoted };
  });
  return txn();
}

/** A person-store re-verification candidate; `isSelf` prioritizes profile facts. */
export interface DueVerificationPersonAnnotation {
  id: string;
  lastVerifiedAt: number | null;
  createdAt: number;
  isSelf: boolean;
}

/**
 * LIVE person annotations due a re-verification check — never checked, or
 * last checked before `cutoff` — with the SELF person's rows first (the
 * injected self-memory is the highest-leverage prior set to keep honest),
 * then oldest-verified first, never-checked rows leading. Served by the
 * migration-55 partial index.
 */
export function listDueVerificationPersonAnnotations(
  db: Db,
  opts: { cutoff: number; limit: number },
): DueVerificationPersonAnnotation[] {
  return db
    .prepare<
      [number, number],
      { id: string; last_verified_at: number | null; created_at: number; is_self: number }
    >(
      `SELECT pa.id, pa.last_verified_at, pa.created_at,
              COALESCE(p.is_self, 0) AS is_self
         FROM person_annotations pa
         LEFT JOIN people p ON p.id = pa.person_id
        WHERE pa.invalidated_at IS NULL
          AND (pa.last_verified_at IS NULL OR pa.last_verified_at < ?)
        ORDER BY COALESCE(p.is_self, 0) DESC, COALESCE(pa.last_verified_at, 0) ASC,
                 pa.created_at ASC
        LIMIT ?`,
    )
    .all(opts.cutoff, opts.limit)
    .map((r) => ({
      id: r.id,
      lastVerifiedAt: r.last_verified_at,
      createdAt: r.created_at,
      isSelf: r.is_self !== 0,
    }));
}

/**
 * Privacy cascade: HARD-delete every annotation ANY of whose evidence atoms
 * (live or broken — the blanket covers everything the annotation ever
 * embedded) cites a deleted document. Child rows are purged with parents.
 */
export function cascadePersonAnnotationPrivacyDelete(
  db: Db,
  deletedDocIds: readonly string[],
): string[] {
  if (deletedDocIds.length === 0) return [];
  const CHUNK = 400;
  const ids = new Set<string>();
  for (let i = 0; i < deletedDocIds.length; i += CHUNK) {
    const batch = deletedDocIds.slice(i, i + CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    for (const r of db
      .prepare<string[], { id: string }>(
        `SELECT DISTINCT annotation_id AS id FROM person_annotation_evidence
          WHERE evidence_doc_id IN (${placeholders})`,
      )
      .all(...batch)) {
      ids.add(r.id);
    }
  }
  if (ids.size === 0) return [];
  const all = [...ids];
  for (let i = 0; i < all.length; i += CHUNK) {
    const batch = all.slice(i, i + CHUNK);
    const idPlaceholders = batch.map(() => "?").join(", ");
    db.prepare<string[]>(
      `DELETE FROM person_annotation_evidence WHERE annotation_id IN (${idPlaceholders})`,
    ).run(...batch);
    db.prepare<string[]>(`DELETE FROM person_annotations WHERE id IN (${idPlaceholders})`).run(
      ...batch,
    );
  }
  return all;
}

export interface UpdatePersonAnnotationPatch {
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
   * Replacement for the annotation's WHOLE evidence set (≥ 1 atom); the old
   * atoms are dropped and evidence[0] is mirrored into the scalar columns.
   */
  evidence?: readonly AnnotationEvidenceInput[];
}

/**
 * Revise a live prior in place — refine claim text/type or lower confidence.
 * The grounding may only change as a WHOLE-set replacement via
 * `patch.evidence` (mirror invariant preserved); individual atoms are never
 * edited. Stamps updated_at. Returns false when unknown or already
 * invalidated.
 */
export function revisePersonAnnotation(
  db: Db,
  id: string,
  patch: UpdatePersonAnnotationPatch,
  now: number,
): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.claimType !== undefined) {
    sets.push("claim_type = ?");
    args.push(patch.claimType);
  }
  if (patch.claimText !== undefined) {
    sets.push("claim_text = ?");
    args.push(patch.claimText);
  }
  if (patch.confidence !== undefined) {
    sets.push("confidence = ?");
    args.push(patch.confidence);
  }
  if (patch.claimBasis !== undefined) {
    sets.push("claim_basis = ?");
    args.push(patch.claimBasis);
  }
  // The verification stamps count as a real revision on their own — a
  // stamps-only patch is exactly what the re-verification sweep issues —
  // matching updateDocAnnotation's semantics.
  if (patch.verificationState !== undefined) {
    sets.push("verification_state = ?");
    args.push(patch.verificationState);
  }
  if (patch.lastVerifiedAt !== undefined) {
    sets.push("last_verified_at = ?");
    args.push(patch.lastVerifiedAt);
  }
  if (sets.length === 0 && patch.evidence === undefined) return false;
  sets.push("updated_at = ?");
  args.push(now);
  const txn = db.transaction((): boolean => {
    const res = db
      .prepare(
        `UPDATE person_annotations SET ${sets.join(", ")}
          WHERE id = ? AND invalidated_at IS NULL AND created_at <= ?`,
      )
      .run(...args, id, now);
    if (res.changes === 0) return false;
    if (patch.evidence !== undefined) {
      replaceAnnotationEvidenceRows(
        db,
        { parentTable: "person_annotations", childTable: "person_annotation_evidence" },
        id,
        patch.evidence,
      );
    }
    return true;
  });
  return txn();
}

/** Retract (hard-delete) one annotation, evidence atoms included. */
export function deletePersonAnnotation(db: Db, id: string): boolean {
  const txn = db.transaction((): boolean => {
    db.prepare<[string]>("DELETE FROM person_annotation_evidence WHERE annotation_id = ?").run(id);
    return db.prepare<[string]>("DELETE FROM person_annotations WHERE id = ?").run(id).changes > 0;
  });
  return txn();
}

/**
 * Retire a LIVE prior in favour of its successor: stamp BOTH
 * `invalidated_at` (so every existing liveness predicate drops it) and
 * `superseded_by` (audit: belief revision, not content drift). Idempotent —
 * false when the row is unknown or already dead.
 */
export function supersedePersonAnnotation(
  db: Db,
  oldId: string,
  newId: string,
  now: number,
): boolean {
  const res = db
    .prepare<[number, string, string]>(
      `UPDATE person_annotations SET invalidated_at = ?, superseded_by = ?
        WHERE id = ? AND invalidated_at IS NULL`,
    )
    .run(now, newId, oldId);
  return res.changes > 0;
}

/**
 * Belief revision as ONE writer op: create the successor and retire the
 * superseded prior in a single transaction (see the doc-store sibling,
 * `createDocAnnotationSuperseding`, for the crash-safety rationale). A
 * self-supersede throws — it would commit a row born dead pointing at itself.
 */
export function createPersonAnnotationSuperseding(
  db: Db,
  input: CreatePersonAnnotationInput,
  supersedesId: string,
  now: number,
): { annotation: PersonAnnotationRow; superseded: boolean } {
  if (supersedesId === input.id) {
    throw new Error(`person annotation ${input.id} cannot supersede itself`);
  }
  const txn = db.transaction(() => {
    const annotation = createPersonAnnotation(db, input, now);
    const superseded = supersedePersonAnnotation(db, supersedesId, input.id, now);
    return { annotation, superseded };
  });
  return txn();
}

/**
 * Pure belief retirement as ONE writer op — no create: retire the live prior
 * `id` in favour of the ALREADY-EXISTING live annotation `supersededById`
 * (see the doc-store sibling, `supersedeDocAnnotationBy`, for the
 * race-and-self-supersede rationale). `superseded` is false when either row
 * was dead/unknown by write time — nothing changes then.
 */
export function supersedePersonAnnotationBy(
  db: Db,
  id: string,
  supersededById: string,
  now: number,
): { superseded: boolean } {
  if (id === supersededById) {
    throw new Error(`person annotation ${id} cannot supersede itself`);
  }
  const txn = db.transaction(() => {
    const successor = getPersonAnnotation(db, supersededById);
    if (successor === null || successor.invalidatedAt !== null) return { superseded: false };
    return { superseded: supersedePersonAnnotation(db, id, supersededById, now) };
  });
  return txn();
}

/**
 * How many of the self person's live annotations to inject into a run's
 * context as "self memory". A durable, evidence-grounded profile of the user
 * (their roles, relationships, standing preferences) that every run reads so
 * it need not re-derive who the user is. Newest-first (the list order), so a
 * user with more facts than the cap keeps the freshest; the store's
 * invalidation + the agent's revise/retract keep the set from staling.
 */
export const DEFAULT_SELF_MEMORY_MAX_ANNOTATIONS = 40;

/**
 * Render a person's live annotations as a compact, injectable memory block —
 * one line per claim, including its person-annotation id and evidence pointer.
 * Returns "" for an empty set so callers can omit the section entirely. Used
 * for the injected self-memory on both the background and (experimental)
 * interactive agents.
 *
 * Each line deliberately carries the defeasibility signal (confidence) and the
 * provenance pointer (evidence doc id): without them the reader cannot weight
 * a shaky prior differently from a near-certain one, and "re-ground before
 * asserting" has nothing to re-ground FROM.
 */
export function renderSelfMemoryBlock(annotations: readonly PersonAnnotationRow[]): string {
  if (annotations.length === 0) return "";
  // Claim text is agent-authored and can echo semi-trusted corpus content, so
  // neutralise three injection vectors before it lands in the prompt: collapse
  // newlines/whitespace (a claim holding "\n- …" would render as a spurious
  // extra bullet — a fabricated "fact"), strip the wrapper tags (so it can't
  // close out of the injected <self-memory> / <user-profile> block), and drop
  // square brackets (so a claim can't spoof a second "[reground: doc …]"
  // pointer ahead of the genuine one the template appends). Confidence and the
  // evidence doc id are gateway-derived (never corpus text), so they
  // interpolate raw.
  const clean = (s: string): string =>
    s
      .replace(/<\/?(?:self-memory|user-profile)>/gi, "")
      .replace(/[[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return annotations
    .map(
      (a) =>
        `- (${clean(a.claimType)}, conf ${a.confidence.toFixed(2)}) ${clean(a.claimText)} ` +
        `[annotation person:${clean(a.id)}; reground: doc ${a.evidenceDocId}]`,
    )
    .join("\n");
}
